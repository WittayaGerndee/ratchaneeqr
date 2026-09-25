/**
 * Api.gs : JSON API สำหรับหน้า LIFF
 *
 * LIFF เรียกด้วย fetch(POST, body = JSON string, ไม่ตั้ง Content-Type เพื่อเลี่ยง CORS preflight)
 *   { action: 'init' | 'student' | 'assignment' | 'submit' | 'link' | 'myStatus', idToken: '...', ... }
 */

function handleApi_(body) {
  try {
    var actor = resolveActor_(body);
    var fn = API_ACTIONS[body.action];
    if (!fn) return { ok: false, code: 'UNKNOWN_ACTION', message: 'ไม่รู้จักคำสั่ง ' + body.action };
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
  var teacher = readTable_('Teachers').filter(function (t) {
    return t.line_user_id && t.line_user_id === user.userId && String(t.status || 'active').toLowerCase() === 'active';
  })[0];
  user.isTeacher = !!teacher;
  user.teacherName = teacher ? teacher.name : '';
  return user;
}

var API_ACTIONS = {
  init: function (b, actor) {
    var linked = findStudentByLineId_(actor.userId);
    return {
      ok: true,
      school: getSetting_('SCHOOL_NAME', ''),
      user: { displayName: actor.displayName, isTeacher: actor.isTeacher, teacherName: actor.teacherName },
      allowManual: actor.isTeacher || getBoolSetting_('ALLOW_MANUAL_ENTRY', false),
      maxFileMb: getNumberSetting_('MAX_FILE_MB', 10),
      linkedStudent: publicStudent_(linked),
      assignments: listOpenAssignments_()
    };
  },

  assignment: function (b) {
    var a = getAssignment_(parseTaskCode_(b.code));
    if (!a) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', message: 'ไม่พบงานจาก QR นี้' };
    if (!isAssignmentOpen_(a)) return { ok: false, code: 'ASSIGNMENT_CLOSED', message: 'งาน "' + a.assignment_name + '" ปิดรับแล้ว' };
    return { ok: true, assignment: publicAssignment_(a) };
  },

  student: function (b) {
    var s = getStudent_(parseStudentCode_(b.code));
    if (!s) return { ok: false, code: 'STUDENT_NOT_FOUND', message: 'ไม่พบรหัสนักเรียนจาก QR นี้' };
    if (!isStudentActive_(s)) return { ok: false, code: 'STUDENT_INACTIVE', message: 'สถานะนักเรียนไม่พร้อมใช้งาน' };
    var out = { ok: true, student: publicStudent_(s) };
    if (b.assignmentId) {
      var a = getAssignment_(parseTaskCode_(b.assignmentId));
      if (a) {
        out.isTarget = isStudentTarget_(a, s);
        var ex = findSubmission_(s.student_id, a.assignment_id);
        if (ex) {
          out.existing = {
            submittedText: fmtDateTimeTH_(ex.timestamp), status: ex.status, attempt: Number(ex.attempt) || 1
          };
        }
      }
    }
    return out;
  },

  submit: function (b, actor) {
    return submitAssignment_({
      studentId: b.studentId, assignmentId: b.assignmentId, resubmit: !!b.resubmit, file: b.file
    }, actor);
  },

  link: function (b, actor) {
    return linkStudent_(b.code, actor);
  },

  myStatus: function (b, actor) {
    var s = findStudentByLineId_(actor.userId);
    if (!s) return { ok: false, code: 'NOT_LINKED', message: 'ยังไม่ได้ผูกบัญชี' };
    return { ok: true, student: publicStudent_(s), items: studentAssignmentStatus_(s) };
  }
};
