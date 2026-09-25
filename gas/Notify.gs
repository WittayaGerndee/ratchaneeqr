/**
 * Notify.gs : แจ้งเตือนทาง LINE
 *   - หลังส่งงาน (ผู้สแกน + นักเรียนเจ้าของงานที่ผูกบัญชีไว้)
 *   - เตือนก่อนครบกำหนด (Trigger ทุกชั่วโมง)
 *   - สรุปรายวันให้ ADMIN_LINE_ID (Trigger 18:00)
 */

function notifySubmission_(result, student, actor) {
  var msg = submissionFlex_(result);
  var targets = [];
  if (actor.userId) targets.push(actor.userId);
  if (student.line_user_id && targets.indexOf(student.line_user_id) < 0) targets.push(student.line_user_id);
  targets.forEach(function (to) { linePush_(to, msg); });
}

/** เตือนนักเรียนที่ยังไม่ส่ง ก่อนครบกำหนด REMINDER_HOURS_BEFORE ชั่วโมง (ครั้งเดียวต่องาน) */
function sendDueReminders() {
  var hours = getNumberSetting_('REMINDER_HOURS_BEFORE', 24);
  if (hours <= 0) return;
  var now = Date.now();
  var students = readTable_('Students').filter(function (s) { return isStudentActive_(s) && s.line_user_id; });
  var subs = readTable_('Submissions');

  readTable_('Assignments').forEach(function (a) {
    if (!isAssignmentOpen_(a) || a.reminded_at) return;
    var due = toDate_(a.due_date);
    if (!due) return;
    var left = due.getTime() - now;
    if (left <= 0 || left > hours * 3600000) return;

    var done = {};
    subs.forEach(function (r) {
      if (normId_(r.assignment_id) === normId_(a.assignment_id)) done[normId_(r.student_id)] = true;
    });
    var pending = students.filter(function (s) { return isStudentTarget_(a, s) && !done[normId_(s.student_id)]; });

    var sent = 0;
    pending.forEach(function (s) {
      try {
        linePush_(s.line_user_id, [
          textMsg_('🔔 แจ้งเตือนการส่งงาน\n\n' + s.name + '\n\nวิชา: ' + a.subject + '\nงาน: ' + a.assignment_name +
            '\nกำหนดส่ง: ' + fmtDateTimeTH_(due) + '\n\nสถานะ: ❌ ยังไม่ส่ง')
        ]);
        sent++;
      } catch (err) { /* logged in lineCall_ */ }
    });
    updateRow_('Assignments', a._row, { reminded_at: new Date() });
    log_('REMINDER', { result: a.assignment_id + ' sent ' + sent + '/' + pending.length });
  });
}

/** สรุปรายวันส่งให้ผู้ดูแล */
function sendDailySummary() {
  var admin = getSetting_('ADMIN_LINE_ID');
  if (!admin) return;
  var d = buildDashboard_('');
  var today = fmtDateTH_(new Date());
  var lines = d.assignments.slice(0, 10).map(function (a) {
    return '• ' + a.assignment_name + ' (' + a.subject + ') ' + a.submitted + '/' + a.target + ' = ' + a.rate + '%';
  });
  linePush_(admin, textMsg_('📊 สรุปการส่งงาน ' + today + '\n\nส่งวันนี้: ' + d.todayCount + ' รายการ\nงานที่เปิดอยู่: ' +
    d.assignments.length + ' งาน\n\n' + (lines.join('\n') || '-')));
}
