/**
 * Submission.gs : Student API, Assignment API, Submission API (หัวใจของระบบ)
 */

// ---------------- Student ----------------

function getStudent_(studentId) {
  var s = findOne_('Students', 'student_id', studentId);
  if (!s) return null;
  s.class_name = className_(s);
  return s;
}

function className_(s) {
  if (!s) return '';
  return s.room !== '' && s.room !== undefined ? (s.class + '/' + s.room) : String(s.class);
}

function isStudentActive_(s) {
  return s && String(s.status || 'active').toLowerCase() === 'active';
}

/** ข้อมูลนักเรียนที่ปลอดภัยสำหรับส่งให้ client (ไม่มีเลขบัตรประชาชน/LINE ID) */
function publicStudent_(s) {
  if (!s) return null;
  return {
    student_id: String(s.student_id), name: s.name, class: s.class, room: s.room,
    class_name: className_(s), status: s.status
  };
}

// ---------------- Assignment ----------------

function getAssignment_(assignmentId) {
  return findOne_('Assignments', 'assignment_id', assignmentId);
}

function isAssignmentOpen_(a) {
  return a && String(a.status || '').toUpperCase() === ASSIGNMENT_STATUS.OPEN;
}

/** ตรวจว่านักเรียนอยู่ในกลุ่มเป้าหมายของงานหรือไม่ (class_target: ALL | ม.5 | ม.5/1 | คั่นด้วย ,) */
function isStudentTarget_(assignment, student) {
  var target = String(assignment.class_target || 'ALL').trim();
  if (!target || target.toUpperCase() === 'ALL' || target === 'ทั้งหมด') return true;
  var cls = normId_(student.class);
  var full = normId_(className_(student));
  return target.split(/[,;]/).some(function (t) {
    t = normId_(t);
    return t && (t === cls || t === full);
  });
}

function publicAssignment_(a) {
  if (!a) return null;
  var due = toDate_(a.due_date);
  return {
    assignment_id: String(a.assignment_id), subject: a.subject, assignment_name: a.assignment_name,
    description: a.description, class_target: a.class_target || 'ALL', teacher: a.teacher,
    status: a.status, allow_resubmit: isTrue_(a.allow_resubmit), require_file: isTrue_(a.require_file),
    due_date: due ? due.toISOString() : '', due_text: due ? fmtDateTimeTH_(due) : 'ไม่กำหนด',
    is_overdue: !!(due && due.getTime() < Date.now())
  };
}

function listOpenAssignments_() {
  return readTable_('Assignments').filter(isAssignmentOpen_).map(publicAssignment_);
}

// ---------------- Submission ----------------

function findSubmission_(studentId, assignmentId) {
  var sid = normId_(studentId), aid = normId_(assignmentId);
  var rows = readTable_('Submissions');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normId_(rows[i].student_id) === sid && normId_(rows[i].assignment_id) === aid) return rows[i];
  }
  return null;
}

/**
 * บันทึกการส่งงาน
 * @param {Object} p { studentId, assignmentId, resubmit, file:{name,mimeType,data(base64)} }
 * @param {Object} actor { userId, displayName, isTeacher }
 * @return {Object} { ok, code, message, ... }
 */
function submitAssignment_(p, actor) {
  var studentId = parseStudentCode_(p.studentId);
  var assignmentId = parseTaskCode_(p.assignmentId);
  var logBase = { student_id: studentId, line_user_id: actor.userId };

  var student = getStudent_(studentId);
  if (!student) return fail_('STUDENT_NOT_FOUND', 'ไม่พบรหัสนักเรียน ' + studentId, logBase);
  if (!isStudentActive_(student)) return fail_('STUDENT_INACTIVE', 'สถานะนักเรียนไม่พร้อมใช้งาน', logBase);

  var a = getAssignment_(assignmentId);
  if (!a) return fail_('ASSIGNMENT_NOT_FOUND', 'ไม่พบงานรหัส ' + assignmentId, logBase);
  if (!isAssignmentOpen_(a)) return fail_('ASSIGNMENT_CLOSED', 'งานนี้ปิดรับแล้ว', logBase);
  if (!isStudentTarget_(a, student)) {
    return fail_('NOT_TARGET', 'งานนี้ไม่ได้มอบหมายให้ห้อง ' + className_(student), logBase);
  }

  var now = new Date();
  var due = toDate_(a.due_date);
  var isLate = !!(due && now.getTime() > due.getTime());
  if (isLate && !getBoolSetting_('ALLOW_LATE_SUBMISSION', true) && !actor.isTeacher) {
    return fail_('OVERDUE', 'เลยกำหนดส่งแล้ว (' + fmtDateTimeTH_(due) + ')', logBase);
  }
  if (isTrue_(a.require_file) && !(p.file && p.file.data) && !actor.isTeacher) {
    return fail_('FILE_REQUIRED', 'งานนี้ต้องแนบไฟล์', logBase);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('BUSY', 'ระบบกำลังทำงาน กรุณาลองใหม่อีกครั้ง', logBase);
  try {
    // ---- กันส่งซ้ำ: student_id + assignment_id ----
    var existing = findSubmission_(student.student_id, a.assignment_id);
    var canResubmit = isTrue_(a.allow_resubmit) || !!actor.isTeacher;
    if (existing && !p.resubmit) {
      log_('SUBMIT_DUPLICATE', { student_id: studentId, line_user_id: actor.userId, result: 'DUPLICATE' });
      return {
        ok: false, code: 'DUPLICATE',
        message: 'นักเรียนคนนี้ส่งงานนี้แล้ว',
        submittedAt: toDate_(existing.timestamp) ? toDate_(existing.timestamp).toISOString() : '',
        submittedText: fmtDateTimeTH_(existing.timestamp),
        status: existing.status, attempt: Number(existing.attempt) || 1,
        canResubmit: canResubmit,
        student: publicStudent_(student), assignment: publicAssignment_(a)
      };
    }
    if (existing && p.resubmit && !canResubmit) {
      return fail_('RESUBMIT_NOT_ALLOWED', 'งานนี้ไม่อนุญาตให้ส่งซ้ำ กรุณาติดต่อครู', logBase);
    }

    var fileUrl = '';
    if (p.file && p.file.data) {
      fileUrl = saveSubmissionFile_(p.file, student, a);
    }

    var record;
    if (existing) {
      record = {
        timestamp: now, status: SUBMISSION_STATUS.SUBMITTED,
        attempt: (Number(existing.attempt) || 1) + 1, is_late: isLate ? 'TRUE' : 'FALSE',
        line_user_id: actor.userId || '', submitted_by: actor.displayName || '',
        file_url: fileUrl || existing.file_url || '',
        checked_by: '', checked_at: '', updated_at: now
      };
      updateRow_('Submissions', existing._row, record);
      record.submission_id = existing.submission_id;
    } else {
      record = {
        submission_id: newId_('SUB'), timestamp: now,
        student_id: String(student.student_id), name: student.name, class: student.class, room: student.room,
        assignment_id: String(a.assignment_id), assignment: a.assignment_name, subject: a.subject,
        status: SUBMISSION_STATUS.SUBMITTED, attempt: 1, is_late: isLate ? 'TRUE' : 'FALSE',
        line_user_id: actor.userId || '', submitted_by: actor.displayName || '',
        file_url: fileUrl, updated_at: now
      };
      appendRow_('Submissions', record);
    }
    SpreadsheetApp.flush();

    log_(existing ? 'RESUBMIT' : 'SUBMIT', { student_id: studentId, line_user_id: actor.userId, result: record.submission_id });

    var result = {
      ok: true, code: existing ? 'RESUBMITTED' : 'SUBMITTED',
      message: 'บันทึกการส่งงานสำเร็จ',
      submission_id: record.submission_id,
      timestamp: now.toISOString(), dateText: fmtDateTH_(now), timeText: fmtTimeTH_(now, true),
      attempt: record.attempt, isLate: isLate, fileUrl: record.file_url,
      student: publicStudent_(student), assignment: publicAssignment_(a)
    };

    return result;
  } finally {
    lock.releaseLock();
  }
}

function fail_(code, message, logData) {
  log_('SUBMIT_FAIL', {
    student_id: logData && logData.student_id, line_user_id: logData && logData.line_user_id,
    result: code, error: message
  });
  return { ok: false, code: code, message: message };
}

/** ยกเลิกการบันทึก (กรณีครูสแกนผิดคน) — ลบแถวที่เพิ่งบันทึก หรือถอยครั้งที่ส่งซ้ำ */
function undoSubmission_(submissionId, actor) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findOne_('Submissions', 'submission_id', submissionId);
    if (!row) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)' };
    var attempt = Number(row.attempt) || 1;
    if (attempt > 1) {
      updateRow_('Submissions', row._row, { attempt: attempt - 1, updated_at: new Date() });
    } else {
      deleteRow_('Submissions', row._row);
    }
    log_('UNDO', { student_id: row.student_id, line_user_id: actor.userId, result: submissionId });
    var a = getAssignment_(row.assignment_id);
    return { ok: true, message: 'ยกเลิกแล้ว', progress: a ? assignmentProgress_(a) : null };
  } finally {
    lock.releaseLock();
  }
}
