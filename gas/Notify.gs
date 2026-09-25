/**
 * Notify.gs : แจ้งเตือนครูทาง LINE
 *   - เตือนก่อนครบกำหนด พร้อมรายชื่อคนที่ยังไม่ส่ง (Trigger ทุกชั่วโมง)
 *   - สรุปรายวันให้ ADMIN_LINE_ID (Trigger 18:00)
 */

/** รายชื่อ LINE ของครูทั้งหมด (Teachers.line_user_id + ADMIN_LINE_ID) */
function teacherLineIds_() {
  var ids = readTable_('Teachers').filter(function (t) {
    return t.line_user_id && String(t.status || 'active').toLowerCase() === 'active';
  }).map(function (t) { return t.line_user_id; });
  var admin = getSetting_('ADMIN_LINE_ID');
  if (admin && ids.indexOf(admin) < 0) ids.push(admin);
  return ids;
}

/** เตือนครูก่อนครบกำหนด REMINDER_HOURS_BEFORE ชั่วโมง พร้อมรายชื่อคนที่ยังไม่ส่ง (ครั้งเดียวต่องาน) */
function sendDueReminders() {
  var hours = getNumberSetting_('REMINDER_HOURS_BEFORE', 24);
  if (hours <= 0) return;
  var teachers = teacherLineIds_();
  if (!teachers.length) return;
  var now = Date.now();
  var students = readTable_('Students').filter(isStudentActive_);
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
    var target = students.filter(function (s) { return isStudentTarget_(a, s); });
    var pending = target.filter(function (s) { return !done[normId_(s.student_id)]; });
    updateRow_('Assignments', a._row, { reminded_at: new Date() });
    if (!pending.length) return;

    var names = pending.slice(0, 40).map(function (s) { return '• ' + s.student_id + ' ' + s.name + ' (' + className_(s) + ')'; });
    if (pending.length > 40) names.push('… และอีก ' + (pending.length - 40) + ' คน');
    lineMulticast_(teachers, textMsg_('🔔 ใกล้ครบกำหนดส่ง\n\n' + a.subject + ' — ' + a.assignment_name +
      '\nกำหนดส่ง: ' + fmtDateTimeTH_(due) + '\nส่งแล้ว ' + (target.length - pending.length) + '/' + target.length +
      ' คน\n\n❌ ยังไม่ส่ง ' + pending.length + ' คน\n' + names.join('\n')));
    log_('REMINDER', { result: a.assignment_id + ' pending ' + pending.length });
  });
}

/** สรุปรายวันส่งให้ผู้ดูแล */
function sendDailySummary() {
  var admin = getSetting_('ADMIN_LINE_ID');
  if (!admin) return;
  var d = buildDashboard_('');
  if (!d.todayCount && !d.assignments.length) return;
  var lines = d.assignments.slice(0, 10).map(function (a) {
    return '• ' + a.assignment_name + ' (' + a.subject + ') ' + a.submitted + '/' + a.target + ' = ' + a.rate + '%';
  });
  linePush_(admin, textMsg_('📊 สรุปการส่งงาน ' + fmtDateTH_(new Date()) + '\n\nบันทึกวันนี้: ' + d.todayCount + ' รายการ\nงานที่เปิดอยู่: ' +
    d.assignments.length + ' งาน\n\n' + (lines.join('\n') || '-')));
}
