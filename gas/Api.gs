/**
 * Api.gs : JSON API สำหรับหน้า LIFF (ใช้เฉพาะครู)
 *
 * LIFF เรียกด้วย fetch(POST, body = JSON string, ไม่ตั้ง Content-Type เพื่อเลี่ยง CORS preflight)
 *   { action: 'init' | 'assignment' | 'submit' | 'undo' | 'summary' | 'createAssignment', idToken: '...', ... }
 *
 * สิทธิ์: LINE userId ต้องอยู่ใน Teachers.line_user_id (status = active) หรือเป็น ADMIN_LINE_ID
 */

function handleApi_(body) {
  try {
    var actor = resolveActor_(body);
    var fn = API_ACTIONS[body.action];
    if (!fn) return { ok: false, code: 'UNKNOWN_ACTION', message: 'ไม่รู้จักคำสั่ง ' + body.action };
    if (body.action !== 'init' && !actor.isTeacher) {
      return { ok: false, code: 'NOT_TEACHER', message: 'ระบบนี้สำหรับครูเท่านั้น' };
    }
    return serialize_(fn(body, actor));
  } catch (err) {
    var msg = String(err && err.message || err);
    log_('API_ERROR', { result: body && body.action, error: err && err.stack || msg });
    return { ok: false, code: msg.indexOf('UNAUTHORIZED') === 0 ? 'UNAUTHORIZED' : 'ERROR', message: msg };
  }
}

function resolveActor_(body) {
  var user;
  if (getBoolSetting_('REQUIRE_ID_TOKEN', true)) {
    user = verifyIdToken_(body.idToken);
  } else {
    // โหมดทดสอบเท่านั้น (REQUIRE_ID_TOKEN = FALSE)
    user = { userId: String(body.userId || 'DEV_USER'), displayName: String(body.displayName || 'Developer') };
  }
  var teacher = findTeacherByLineId_(user.userId);
  var isAdminLine = !!user.userId && user.userId === getSetting_('ADMIN_LINE_ID');
  user.isTeacher = !!teacher || isAdminLine;
  user.teacherName = teacher ? teacher.name : (isAdminLine ? 'ผู้ดูแลระบบ' : '');
  return user;
}

function findTeacherByLineId_(userId) {
  if (!userId) return null;
  return readTable_('Teachers').filter(function (t) {
    return t.line_user_id && t.line_user_id === userId && String(t.status || 'active').toLowerCase() === 'active';
  })[0] || null;
}

var API_ACTIONS = {
  init: function (b, actor) {
    var out = {
      ok: true,
      school: getSetting_('SCHOOL_NAME', ''),
      user: { displayName: actor.displayName, isTeacher: actor.isTeacher, teacherName: actor.teacherName },
      maxFileMb: getNumberSetting_('MAX_FILE_MB', 10)
    };
    if (!actor.isTeacher) {
      out.userId = actor.userId; // ให้ครูส่ง userId นี้ให้ผู้ดูแลเพิ่มสิทธิ์
      out.assignments = [];
      return out;
    }
    out.assignments = listOpenAssignments_();
    out.classes = classNames_();
    return out;
  },

  assignment: function (b) {
    var a = getAssignment_(parseTaskCode_(b.code));
    if (!a) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', message: 'ไม่พบงานจาก QR นี้' };
    if (!isAssignmentOpen_(a)) return { ok: false, code: 'ASSIGNMENT_CLOSED', message: 'งาน "' + a.assignment_name + '" ปิดรับแล้ว' };
    return { ok: true, assignment: publicAssignment_(a), progress: assignmentProgress_(a) };
  },

  submit: function (b, actor) {
    var r = submitAssignment_({
      studentId: b.studentId, assignmentId: b.assignmentId, resubmit: !!b.resubmit, file: b.file
    }, actor);
    var a = getAssignment_(parseTaskCode_(b.assignmentId));
    if (a) r.progress = assignmentProgress_(a);
    return r;
  },

  undo: function (b, actor) {
    return undoSubmission_(b.submissionId, actor);
  },

  summary: function (b) {
    var d = buildDashboard_(parseTaskCode_(b.assignmentId || ''));
    if (!d.selected) return { ok: false, code: 'NO_ASSIGNMENT', message: 'ยังไม่มีงาน' };
    var aid = normId_(d.selected.assignment.assignment_id);
    var submitted = readTable_('Submissions').filter(function (r) { return normId_(r.assignment_id) === aid; })
      .map(function (r) {
        return {
          submission_id: r.submission_id, student_id: String(r.student_id), name: r.name,
          class_name: className_(r), time: fmtDateTimeTH_(r.timestamp), is_late: isTrue_(r.is_late), status: r.status
        };
      });
    return { ok: true, summary: d.selected, submitted: submitted, assignments: d.assignments };
  },

  createAssignment: function (b, actor) {
    return createAssignment_(b, actor);
  }
};

/** ความคืบหน้าของงาน: ส่งแล้ว / ทั้งหมด */
function assignmentProgress_(a) {
  var target = readTable_('Students').filter(function (s) { return isStudentActive_(s) && isStudentTarget_(a, s); });
  var ids = {};
  target.forEach(function (s) { ids[normId_(s.student_id)] = true; });
  var done = {};
  readTable_('Submissions').forEach(function (r) {
    if (normId_(r.assignment_id) === normId_(a.assignment_id) && ids[normId_(r.student_id)]) done[normId_(r.student_id)] = true;
  });
  return { submitted: Object.keys(done).length, target: target.length };
}

function classNames_() {
  var set = {};
  readTable_('Students').forEach(function (s) { if (isStudentActive_(s)) set[className_(s)] = true; });
  readTable_('Classes').forEach(function (c) { if (c.class_name) set[c.class_name] = true; });
  return Object.keys(set).sort();
}

/** ครูสร้างงานใหม่จากมือถือ (รหัสงานสร้างอัตโนมัติ HW001, HW002, ...) */
function createAssignment_(b, actor) {
  var subject = String(b.subject || '').trim();
  var name = String(b.assignment_name || '').trim();
  if (!subject || !name) return { ok: false, code: 'INVALID', message: 'กรุณากรอกวิชาและชื่องาน' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var max = 0;
    readTable_('Assignments').forEach(function (a) {
      var m = String(a.assignment_id).match(/^HW(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]));
    });
    var id = 'HW' + ('00' + (max + 1)).slice(-3);
    var row = {
      assignment_id: id, subject: subject, assignment_name: name, description: String(b.description || ''),
      class_target: String(b.class_target || 'ALL').trim() || 'ALL',
      due_date: b.due_date ? (toDate_(b.due_date) || '') : '',
      teacher: actor.teacherName || actor.displayName || '', status: ASSIGNMENT_STATUS.OPEN,
      allow_resubmit: 'FALSE', require_file: 'FALSE', created_at: new Date()
    };
    appendRow_('Assignments', row);
    log_('CREATE_ASSIGNMENT', { line_user_id: actor.userId, result: id });
    var a = getAssignment_(id);
    return { ok: true, assignment: publicAssignment_(a), progress: assignmentProgress_(a) };
  } finally {
    lock.releaseLock();
  }
}
