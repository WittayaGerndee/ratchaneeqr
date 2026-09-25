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
  saveRecord_(sheetName, obj, isNew);
  log_('ADMIN_SAVE', { result: sheetName + ':' + obj[SHEET_KEYS[sheetName]] });
  return true;
}

function adminDelete(sheetName, id) {
  if (!ADMIN_EDITABLE[sheetName] && sheetName !== 'Submissions') throw new Error('ไม่อนุญาต');
  requireAuth_(true);
  deleteRecord_(sheetName, id);
  log_('ADMIN_DELETE', { result: sheetName + ':' + id });
  return true;
}

/** นำเข้านักเรียนจากการวางข้อมูลจาก Excel/Sheets: student_id, name, class, room (คั่นด้วย Tab หรือ ,) */
function adminImportStudents(text) {
  requireAuth_();
  return importStudents_(text);
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

/** ส่งรายชื่อคนที่ยังไม่ส่งให้ครูทุกคนทาง LINE */
function adminRemindMissing(assignmentId) {
  requireAuth_();
  var res = adminMissing(assignmentId);
  var a = res.assignment;
  var ids = teacherLineIds_();
  if (!ids.length) throw new Error('ยังไม่มีครูที่ตั้ง line_user_id (หรือ ADMIN_LINE_ID)');
  var names = res.students.slice(0, 40).map(function (s) { return '• ' + s.student_id + ' ' + s.name + ' (' + s.class_name + ')'; });
  if (res.students.length > 40) names.push('… และอีก ' + (res.students.length - 40) + ' คน');
  lineMulticast_(ids, textMsg_('📋 ยังไม่ส่งงาน\n\n' + a.subject + ' — ' + a.assignment_name + '\nกำหนดส่ง: ' + a.due_text +
    '\n\n❌ ยังไม่ส่ง ' + res.students.length + ' คน\n' + (names.join('\n') || '-')));
  log_('ADMIN_REMIND', { result: assignmentId + ' ' + res.students.length });
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
      rate: target ? Math.round(mine.length / target * 1000) / 10 : 0
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
