/**
 * Api.gs : JSON API สำหรับหน้า LIFF (ใช้เฉพาะครู)
 *
 * LIFF เรียกด้วย fetch(POST, body = JSON string, ไม่ตั้ง Content-Type เพื่อเลี่ยง CORS preflight)
 *   { action, idToken, ... }
 *
 * ความเร็ว: หน้า LIFF เรียก bootstrap ครั้งเดียวเพื่อโหลดนักเรียน/งาน/การส่งทั้งหมด
 * แล้วตรวจผลการสแกนบนมือถือทันที ส่วนการบันทึกส่งขึ้นเป็นชุดด้วย submitBatch
 *
 * สิทธิ์: LINE userId ต้องอยู่ใน Teachers.line_user_id (status = active) หรือเป็น ADMIN_LINE_ID
 */

function handleApi_(body) {
  try {
    var actor = resolveActor_(body);
    var fn = API_ACTIONS[body.action];
    if (!fn) return { ok: false, code: 'UNKNOWN_ACTION', message: 'ไม่รู้จักคำสั่ง ' + body.action };
    if (body.action !== 'bootstrap' && !actor.isTeacher) {
      return { ok: false, code: 'NOT_TEACHER', message: 'ระบบนี้สำหรับครูเท่านั้น' };
    }
    // กันทำซ้ำ: Google บางครั้งรันคำสั่งสำเร็จแต่ส่งผลกลับไม่ถึงมือถือ → หน้า LIFF ส่งซ้ำด้วย reqId เดิม
    var reqKey = body.reqId && WRITE_ACTIONS[body.action] ? 'req_' + actor.userId + '_' + String(body.reqId).substring(0, 60) : '';
    if (!reqKey) return serialize_(fn(body, actor));

    // หน้า LIFF อาจส่งคำขอเดียวกันซ้อนกันหลายชุด (เมื่อ Google ตอบช้า) → ให้ทำงานจริงครั้งเดียว
    // ใช้ UserLock (แยกจาก ScriptLock ที่ฟังก์ชันด้านในใช้) เพื่อให้ชุดที่มาทีหลังรอแล้วได้ผลเดิม
    var cache = CacheService.getScriptCache();
    var hit = cache.get(reqKey);
    if (hit) return JSON.parse(hit);
    var guard = LockService.getUserLock();
    if (!guard.tryLock(28000)) return { ok: false, code: 'BUSY', message: 'ระบบกำลังทำงาน กรุณาลองใหม่' };
    try {
      hit = cache.get(reqKey);
      if (hit) return JSON.parse(hit);
      var result = serialize_(fn(body, actor));
      try { cache.put(reqKey, JSON.stringify(result), 1800); } catch (e) { /* ผลลัพธ์ใหญ่เกิน cache */ }
      return result;
    } finally {
      guard.releaseLock();
    }
  } catch (err) {
    var msg = String(err && err.message || err);
    if (msg.indexOf('UNAUTHORIZED') !== 0) log_('API_ERROR', { result: body && body.action, error: err && err.stack || msg });
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
  user.isAdmin = isAdminLine || !!(teacher && String(teacher.role || '').toLowerCase() === 'admin');
  user.teacherName = teacher ? teacher.name : (isAdminLine ? getSetting_('ADMIN_NAME', 'ผู้ดูแลระบบ') : '');
  return user;
}

function findTeacherByLineId_(userId) {
  if (!userId) return null;
  return cachedTable_('Teachers').filter(function (t) {
    return t.line_user_id && t.line_user_id === userId && String(t.status || 'active').toLowerCase() === 'active';
  })[0] || null;
}

/** คำสั่งที่เปลี่ยนข้อมูล (ต้องกันการทำซ้ำเมื่อหน้า LIFF ส่งซ้ำ) */
var WRITE_ACTIONS = {
  submitBatch: true, undo: true, saveStudent: true, deleteStudent: true,
  importStudents: true, saveAssignment: true, deleteAssignment: true, saveSettings: true
};

var API_ACTIONS = {
  /** โหลดข้อมูลทั้งหมดที่หน้า LIFF ต้องใช้ในครั้งเดียว */
  bootstrap: function (b, actor) {
    var out = {
      ok: true,
      school: getSetting_('SCHOOL_NAME', ''),
      user: { displayName: actor.displayName, isTeacher: actor.isTeacher, isAdmin: !!actor.isAdmin, teacherName: actor.teacherName },
      adminName: getSetting_('ADMIN_NAME', ''),
      studentPrefix: getSetting_('QR_STUDENT_PREFIX', 'STU-'),
      taskPrefix: getSetting_('QR_TASK_PREFIX', 'TASK-'),
      liffId: getSetting_('LIFF_ID', '')
    };
    if (!actor.isTeacher) {
      out.userId = actor.userId; // ให้ครูส่ง userId นี้ให้ผู้ดูแลเพิ่มสิทธิ์
      return out;
    }
    return Object.assign(out, loadData_());
  },

  submitBatch: function (b, actor) {
    return { ok: true, results: submitBatch_(b.items, actor) };
  },

  undo: function (b, actor) {
    return undoSubmission_(b.submissionId, actor);
  },

  // ---------- นักเรียน ----------
  saveStudent: function (b, actor) {
    var s = b.student || {};
    var id = String(s.student_id || '').trim(), name = String(s.name || '').trim();
    if (!id || !name) return { ok: false, message: 'กรุณากรอกรหัสและชื่อนักเรียน' };
    var cr = splitClassRoom_(s.class, s.room);
    if (!cr.cls) return { ok: false, message: 'กรุณากรอกชั้น' };
    var row = saveRecord_('Students', {
      student_id: id, name: name, class: cr.cls, room: cr.room, status: 'active'
    }, !b.oldId, b.oldId);
    log_('SAVE_STUDENT', { student_id: s.student_id, line_user_id: actor.userId, result: b.oldId ? 'edit' : 'new' });
    return { ok: true, student: studentRow_(row) };
  },

  deleteStudent: function (b, actor) {
    deleteRecord_('Students', b.studentId);
    log_('DELETE_STUDENT', { student_id: b.studentId, line_user_id: actor.userId });
    return { ok: true };
  },

  importStudents: function (b) {
    var r = importStudents_(b.text);
    r.students = loadData_().students;
    return r;
  },

  // ---------- งาน ----------
  saveAssignment: function (b, actor) {
    var a = b.assignment || {};
    if (!String(a.subject || '').trim() || !String(a.assignment_name || '').trim()) {
      return { ok: false, message: 'กรุณากรอกวิชาและชื่องาน' };
    }
    var isNew = !a.assignment_id;
    if (isNew) a.assignment_id = nextAssignmentId_();
    var rec = {
      assignment_id: a.assignment_id, subject: a.subject, assignment_name: a.assignment_name,
      class_target: String(a.class_target || 'ALL').trim() || 'ALL', due_date: a.due_date || ''
    };
    if (isNew) rec.teacher = actor.teacherName || actor.displayName || '';
    if (a.status) rec.status = a.status;
    var row = saveRecord_('Assignments', rec, isNew);
    log_('SAVE_ASSIGNMENT', { line_user_id: actor.userId, result: rec.assignment_id });
    return { ok: true, assignment: publicAssignment_(row) };
  },

  saveSettings: function (b, actor) {
    if (!actor.isAdmin) return { ok: false, message: 'เฉพาะผู้ดูแลระบบ' };
    var allowed = { SCHOOL_NAME: true, ADMIN_NAME: true };
    Object.keys(b.settings || {}).forEach(function (k) {
      if (allowed[k]) saveRecord_('Settings', { key: k, value: String(b.settings[k] || '').trim() }, !findOne_('Settings', 'key', k));
    });
    return { ok: true, school: getSetting_('SCHOOL_NAME', ''), adminName: getSetting_('ADMIN_NAME', '') };
  },

  deleteAssignment: function (b, actor) {
    var aid = normId_(b.assignmentId);
    var used = readTable_('Submissions').some(function (r) { return normId_(r.assignment_id) === aid; });
    if (used) return { ok: false, message: 'งานนี้มีการส่งแล้ว ลบไม่ได้ — ใช้ "ปิดรับ" แทน' };
    deleteRecord_('Assignments', b.assignmentId);
    log_('DELETE_ASSIGNMENT', { line_user_id: actor.userId, result: b.assignmentId });
    return { ok: true };
  }
};

/** ข้อมูลทั้งหมดสำหรับหน้า LIFF (ส่งแบบกระชับเพื่อให้โหลดเร็ว) */
function loadData_() {
  var students = readTable_('Students').filter(isStudentActive_).map(studentRow_);
  var assignments = readTable_('Assignments').map(publicAssignment_);
  // งานที่เปิดอยู่ + งานที่ปิดล่าสุด 10 งาน
  var open = assignments.filter(function (a) { return a.status === ASSIGNMENT_STATUS.OPEN; });
  var closed = assignments.filter(function (a) { return a.status !== ASSIGNMENT_STATUS.OPEN; }).slice(-10);
  var list = open.concat(closed);
  var wanted = {};
  list.forEach(function (a) { wanted[normId_(a.assignment_id)] = true; });

  // subs[assignment_id][student_id] = [timestampISO, submission_id, isLate]
  var subs = {};
  readTable_('Submissions').forEach(function (r) {
    var aid = String(r.assignment_id);
    if (!wanted[normId_(aid)]) return;
    var d = toDate_(r.timestamp);
    (subs[aid] = subs[aid] || {})[String(r.student_id)] = [d ? d.toISOString() : '', r.submission_id, isTrue_(r.is_late)];
  });
  return { students: students, assignments: list, subs: subs };
}

/** นักเรียนแบบ array: [student_id, name, class, room] */
function studentRow_(s) {
  return [String(s.student_id), s.name, String(s.class), String(s.room)];
}

function nextAssignmentId_() {
  var max = 0;
  readTable_('Assignments').forEach(function (a) {
    var m = String(a.assignment_id).match(/^HW(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'HW' + ('00' + (max + 1)).slice(-3);
}

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
