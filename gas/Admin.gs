/**
 * Admin.gs : ฟังก์ชันฝั่ง Server ของหน้า Admin (เรียกผ่าน google.script.run)
 *
 * สิทธิ์: ผู้ใช้ต้องมีอีเมลอยู่ใน Sheet Teachers (status = active)
 *   role = admin   → ทำได้ทุกอย่าง (รวม Teachers, Settings, ลบข้อมูล)
 *   role = teacher → จัดการนักเรียน/ห้อง/งาน/ตรวจงาน
 */

/** Sheet ที่แก้ไขผ่านหน้า Admin ได้ */
var ADMIN_EDITABLE = {
  Students: { adminOnly: false },
  Classes: { adminOnly: false },
  Assignments: { adminOnly: false },
  Teachers: { adminOnly: true },
  Settings: { adminOnly: true }
};

function adminAuth_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (err) { /* ignore */ }
  if (!email) return { ok: false, email: '' };
  var t = readTable_('Teachers').filter(function (r) {
    return normId_(r.email) === normId_(email) && String(r.status || 'active').toLowerCase() === 'active';
  })[0];
  if (!t) return { ok: false, email: email };
  return { ok: true, email: email, name: t.name, role: String(t.role || 'teacher').toLowerCase() };
}

function requireAuth_(adminOnly) {
  var a = adminAuth_();
  if (!a.ok) throw new Error('ไม่มีสิทธิ์เข้าถึง');
  if (adminOnly && a.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบ (admin) เท่านั้น');
  return a;
}

// ---------------- Meta / CRUD ----------------

function adminMeta() {
  var a = requireAuth_();
  return {
    user: a, schema: SCHEMA, keys: SHEET_KEYS, editable: ADMIN_EDITABLE,
    status: SUBMISSION_STATUS, school: getSetting_('SCHOOL_NAME', ''),
    liffId: getSetting_('LIFF_ID', ''), studentPrefix: getSetting_('QR_STUDENT_PREFIX', 'STU-'),
    taskPrefix: getSetting_('QR_TASK_PREFIX', 'TASK-'),
    spreadsheetUrl: ss_().getUrl(),
    driveUrl: getSetting_('GOOGLE_DRIVE_FOLDER_ID') ? 'https://drive.google.com/drive/folders/' + getSetting_('GOOGLE_DRIVE_FOLDER_ID') : ''
  };
}

function adminList(sheetName) {
  var auth = requireAuth_();
  if (!ADMIN_EDITABLE[sheetName] && sheetName !== 'Submissions' && sheetName !== 'Logs') throw new Error('ไม่อนุญาต');
  if ((sheetName === 'Logs' || (ADMIN_EDITABLE[sheetName] || {}).adminOnly) && auth.role !== 'admin') throw new Error('เฉพาะ admin');
  var rows = readTable_(sheetName);
  if (sheetName === 'Logs') rows = rows.slice(-500).reverse();
  return serialize_(rows);
}

/** เพิ่ม/แก้ไข 1 แถว (ถ้ามี key อยู่แล้ว = แก้ไข) */
function adminSave(sheetName, obj, isNew) {
  var cfg = ADMIN_EDITABLE[sheetName];
  if (!cfg) throw new Error('ไม่อนุญาต');
  requireAuth_(cfg.adminOnly);
  var key = SHEET_KEYS[sheetName];
  var id = String(obj[key] || '').trim();
  if (!id) throw new Error('กรุณากรอก ' + key);

  var clean = {};
  SCHEMA[sheetName].forEach(function (c) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) clean[c] = obj[c];
  });
  clean[key] = id;
  if (sheetName === 'Assignments') {
    if (clean.due_date) clean.due_date = toDate_(clean.due_date) || clean.due_date;
    if (clean.status) clean.status = String(clean.status).toUpperCase();
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var existing = findOne_(sheetName, key, id);
    if (existing && isNew) throw new Error(key + ' "' + id + '" มีอยู่แล้ว');
    if (existing) {
      // ถ้าเปลี่ยนวันกำหนดส่ง ให้เตือนใหม่ได้อีกครั้ง
      if (sheetName === 'Assignments' && clean.due_date && String(toDate_(existing.due_date)) !== String(toDate_(clean.due_date))) {
        clean.reminded_at = '';
      }
      updateRow_(sheetName, existing._row, clean);
    } else {
      if (sheetName === 'Assignments') clean.created_at = new Date();
      appendRow_(sheetName, clean);
    }
  } finally {
    lock.releaseLock();
  }
  if (sheetName === 'Settings') _settingsMemo = null;
  log_('ADMIN_SAVE', { result: sheetName + ':' + id });
  return true;
}

function adminDelete(sheetName, id) {
  if (!ADMIN_EDITABLE[sheetName] && sheetName !== 'Submissions') throw new Error('ไม่อนุญาต');
  requireAuth_(true);
  var key = SHEET_KEYS[sheetName];
  var row = findOne_(sheetName, key, id);
  if (!row) throw new Error('ไม่พบข้อมูล');
  deleteRow_(sheetName, row._row);
  log_('ADMIN_DELETE', { result: sheetName + ':' + id });
  return true;
}

/** นำเข้านักเรียนจากการวางข้อมูลจาก Excel/Sheets: student_id, name, class, room (คั่นด้วย Tab หรือ ,) */
function adminImportStudents(text) {
  requireAuth_();
  var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var existing = {};
  readTable_('Students').forEach(function (s) { existing[normId_(s.student_id)] = s; });
  var added = 0, updated = 0, skipped = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var newRows = [];
    lines.forEach(function (l) {
      var c = l.split(/\t|,/).map(function (x) { return x.trim(); });
      if (!c[0] || /student_id|รหัส/i.test(c[0])) { skipped++; return; }
      var obj = { student_id: c[0], name: c[1] || '', class: c[2] || '', room: c[3] || '', status: 'active' };
      var ex = existing[normId_(c[0])];
      if (ex) { updateRow_('Students', ex._row, { name: obj.name, class: obj.class, room: obj.room }); updated++; }
      else { newRows.push(obj); existing[normId_(c[0])] = obj; added++; }
    });
    if (newRows.length) {
      var sh = sheet_('Students');
      var hs = headers_('Students');
      var vals = newRows.map(function (o) { return hs.map(function (h) { return o[h] !== undefined ? o[h] : ''; }); });
      sh.getRange(sh.getLastRow() + 1, 1, vals.length, hs.length).setValues(vals);
    }
  } finally {
    lock.releaseLock();
  }
  log_('ADMIN_IMPORT', { result: 'added ' + added + ', updated ' + updated });
  return { added: added, updated: updated, skipped: skipped };
}

// ---------------- Submissions ----------------

/** ครูเปลี่ยนสถานะ/คะแนน/หมายเหตุ ของรายการส่งงาน */
function adminUpdateSubmission(submissionId, data) {
  var auth = requireAuth_();
  var row = findOne_('Submissions', 'submission_id', submissionId);
  if (!row) throw new Error('ไม่พบรายการส่งงาน');
  var allowed = [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.CHECKED, SUBMISSION_STATUS.PASSED, SUBMISSION_STATUS.REVISE];
  var upd = { updated_at: new Date() };
  if (data.status !== undefined) {
    if (allowed.indexOf(data.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
    upd.status = data.status;
    if (data.status !== SUBMISSION_STATUS.SUBMITTED) { upd.checked_by = auth.name || auth.email; upd.checked_at = new Date(); }
  }
  if (data.score !== undefined) upd.score = data.score;
  if (data.note !== undefined) upd.note = data.note;
  updateRow_('Submissions', row._row, upd);

  // แจ้งนักเรียนเมื่อครูตรวจ (ถ้าผูก LINE ไว้)
  if (data.notify && upd.status && upd.status !== SUBMISSION_STATUS.SUBMITTED) {
    var s = getStudent_(row.student_id);
    if (s && s.line_user_id) {
      try {
        var icon = upd.status === SUBMISSION_STATUS.PASSED ? '🏆' : upd.status === SUBMISSION_STATUS.REVISE ? '✏️' : '📝';
        linePush_(s.line_user_id, textMsg_(icon + ' ผลการตรวจงาน\n\nงาน: ' + row.assignment + ' (' + row.subject + ')\nสถานะ: ' +
          upd.status + (data.score !== undefined && data.score !== '' ? '\nคะแนน: ' + data.score : '') +
          (data.note ? '\nหมายเหตุ: ' + data.note : '')));
      } catch (err) { /* logged */ }
    }
  }
  return true;
}

/** นักเรียนที่ยังไม่ส่งงาน (assignmentId) กรองตามห้องได้ */
function adminMissing(assignmentId, classFilter) {
  requireAuth_();
  var a = getAssignment_(assignmentId);
  if (!a) throw new Error('ไม่พบงาน');
  var done = {};
  readTable_('Submissions').forEach(function (r) {
    if (normId_(r.assignment_id) === normId_(a.assignment_id)) done[normId_(r.student_id)] = true;
  });
  var list = readTable_('Students').filter(function (s) {
    return isStudentActive_(s) && isStudentTarget_(a, s) && !done[normId_(s.student_id)] &&
      (!classFilter || className_(s) === classFilter);
  }).map(function (s) {
    var p = publicStudent_(s);
    return p;
  });
  return { assignment: publicAssignment_(a), students: list };
}

/** แจ้งเตือนนักเรียนที่ยังไม่ส่ง (เฉพาะคนที่ผูก LINE) ทันที */
function adminRemindMissing(assignmentId) {
  requireAuth_();
  var a = getAssignment_(assignmentId);
  var res = adminMissing(assignmentId);
  var ids = res.students.map(function (s) { return getStudent_(s.student_id); })
    .filter(function (s) { return s && s.line_user_id; }).map(function (s) { return s.line_user_id; });
  if (ids.length) {
    lineMulticast_(ids, textMsg_('🔔 แจ้งเตือนการส่งงาน\n\nวิชา: ' + a.subject + '\nงาน: ' + a.assignment_name +
      '\nกำหนดส่ง: ' + fmtDateTimeTH_(a.due_date) + '\n\nสถานะ: ❌ ยังไม่ส่ง\nกรุณาส่งงานโดยเร็ว'));
  }
  log_('ADMIN_REMIND', { result: assignmentId + ' ' + ids.length });
  return { sent: ids.length, missing: res.students.length };
}

// ---------------- Dashboard / Report ----------------

function adminDashboard(assignmentId) {
  requireAuth_();
  return serialize_(buildDashboard_(assignmentId || ''));
}

function buildDashboard_(assignmentId) {
  var students = readTable_('Students').filter(isStudentActive_);
  var assignments = readTable_('Assignments');
  var subs = readTable_('Submissions');
  var tz = getTz_();
  var todayKey = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');

  var subByAssign = {};
  var todayCount = 0;
  subs.forEach(function (r) {
    var k = normId_(r.assignment_id);
    (subByAssign[k] = subByAssign[k] || {})[normId_(r.student_id)] = r;
    var d = toDate_(r.timestamp);
    if (d && Utilities.formatDate(d, tz, 'yyyyMMdd') === todayKey) todayCount++;
  });

  // สรุปทุกงานที่เปิดอยู่ (หรือทุกงาน ถ้าไม่มีงานเปิด)
  var list = assignments.filter(isAssignmentOpen_);
  if (!list.length) list = assignments.slice(-10);
  var summary = list.map(function (a) {
    var target = students.filter(function (s) { return isStudentTarget_(a, s); });
    var done = subByAssign[normId_(a.assignment_id)] || {};
    var submitted = target.filter(function (s) { return done[normId_(s.student_id)]; }).length;
    var pa = publicAssignment_(a);
    pa.target = target.length;
    pa.submitted = submitted;
    pa.rate = target.length ? Math.round(submitted / target.length * 1000) / 10 : 0;
    return pa;
  }).sort(function (x, y) { return x.rate - y.rate; });

  var out = {
    totalStudents: students.length, totalSubmissions: subs.length, todayCount: todayCount,
    assignments: summary, selected: null
  };

  var aid = assignmentId || (summary.length ? summary[0].assignment_id : '');
  var a = aid ? getAssignment_(aid) : null;
  if (a) {
    var target = students.filter(function (s) { return isStudentTarget_(a, s); });
    var done = subByAssign[normId_(a.assignment_id)] || {};
    var rooms = {};
    var missing = [];
    var late = 0;
    var byStatus = {};
    target.forEach(function (s) {
      var cn = className_(s);
      var r = rooms[cn] = rooms[cn] || { class_name: cn, target: 0, submitted: 0 };
      r.target++;
      var sub = done[normId_(s.student_id)];
      if (sub) {
        r.submitted++;
        if (isTrue_(sub.is_late)) late++;
        byStatus[sub.status] = (byStatus[sub.status] || 0) + 1;
      } else {
        missing.push(publicStudent_(s));
      }
    });
    var roomList = Object.keys(rooms).sort().map(function (k) {
      var r = rooms[k];
      r.rate = r.target ? Math.round(r.submitted / r.target * 1000) / 10 : 0;
      return r;
    });
    var submitted = target.length - missing.length;
    out.selected = {
      assignment: publicAssignment_(a),
      target: target.length, submitted: submitted, missingCount: missing.length, late: late,
      rate: target.length ? Math.round(submitted / target.length * 1000) / 10 : 0,
      rooms: roomList, missing: missing, byStatus: byStatus
    };
  }
  return out;
}

/** รายงาน: จำนวนงานที่ส่งของนักเรียนแต่ละคน */
function adminStudentReport(classFilter) {
  requireAuth_();
  var assignments = readTable_('Assignments');
  var subs = readTable_('Submissions');
  var subsByStudent = {};
  subs.forEach(function (r) { (subsByStudent[normId_(r.student_id)] = subsByStudent[normId_(r.student_id)] || []).push(r); });
  return readTable_('Students').filter(function (s) {
    return isStudentActive_(s) && (!classFilter || className_(s) === classFilter);
  }).map(function (s) {
    var mine = subsByStudent[normId_(s.student_id)] || [];
    var target = assignments.filter(function (a) { return isStudentTarget_(a, s); }).length;
    return {
      student_id: String(s.student_id), name: s.name, class_name: className_(s),
      target: target, submitted: mine.length,
      attempts: mine.reduce(function (n, r) { return n + (Number(r.attempt) || 1); }, 0),
      late: mine.filter(function (r) { return isTrue_(r.is_late); }).length,
      passed: mine.filter(function (r) { return r.status === SUBMISSION_STATUS.PASSED; }).length,
      revise: mine.filter(function (r) { return r.status === SUBMISSION_STATUS.REVISE; }).length,
      rate: target ? Math.round(mine.length / target * 1000) / 10 : 0,
      linked: !!s.line_user_id
    };
  });
}

// ---------------- QR ----------------

function adminGenerateStudentQRs(classFilter) {
  requireAuth_();
  return generateStudentQRs(classFilter || '');
}

function adminGenerateTaskQRs() {
  requireAuth_();
  return generateAssignmentQRs();
}

function adminQrData(classFilter) {
  requireAuth_();
  var students = readTable_('Students').filter(function (s) {
    return isStudentActive_(s) && (!classFilter || className_(s) === classFilter);
  }).map(function (s) {
    var p = publicStudent_(s);
    p.qr = studentQrText_(s.student_id);
    return p;
  });
  var tasks = readTable_('Assignments').filter(isAssignmentOpen_).map(function (a) {
    var p = publicAssignment_(a);
    p.qr = taskQrText_(a.assignment_id);
    return p;
  });
  return { students: students, tasks: tasks, school: getSetting_('SCHOOL_NAME', '') };
}

function adminClassNames() {
  requireAuth_();
  var set = {};
  readTable_('Students').forEach(function (s) { if (isStudentActive_(s)) set[className_(s)] = true; });
  readTable_('Classes').forEach(function (c) { if (c.class_name) set[c.class_name] = true; });
  return Object.keys(set).sort();
}

/** ทดสอบส่งข้อความ LINE ถึงผู้ดูแล */
function adminTestLine() {
  requireAuth_(true);
  var to = getSetting_('ADMIN_LINE_ID');
  if (!to) throw new Error('ยังไม่ได้ตั้งค่า ADMIN_LINE_ID');
  linePush_(to, textMsg_('✅ ทดสอบการเชื่อมต่อ LINE สำเร็จ\n' + fmtDateTimeTH_(new Date())));
  return true;
}
