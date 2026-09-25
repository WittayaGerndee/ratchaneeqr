/**
 * Qr.gs : สร้าง QR Code ลง Google Drive
 *
 * QR นักเรียน : "STU-65001"  (เก็บแค่รหัส ไม่เก็บชื่อ/ข้อมูลส่วนตัว)
 * QR งาน      : "https://liff.line.me/<LIFF_ID>?task=HW001"  (สแกนด้วยกล้องแล้วเปิด LIFF ได้ทันที)
 *               ถ้ายังไม่ตั้ง LIFF_ID จะใช้ "TASK-HW001"
 */

var QR_API = 'https://quickchart.io/qr';

function studentQrText_(studentId) {
  return getSetting_('QR_STUDENT_PREFIX', 'STU-') + studentId;
}

function taskQrText_(assignmentId) {
  return getLiffUrl_({ task: assignmentId }) || (getSetting_('QR_TASK_PREFIX', 'TASK-') + assignmentId);
}

function qrBlob_(text, fileName) {
  var url = QR_API + '?size=500&margin=2&ecLevel=M&format=png&text=' + encodeURIComponent(text);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('สร้าง QR ไม่สำเร็จ: HTTP ' + res.getResponseCode());
  return res.getBlob().setName(fileName);
}

function saveQr_(folder, text, fileName) {
  var it = folder.getFilesByName(fileName);
  while (it.hasNext()) it.next().setTrashed(true);
  return folder.createFile(qrBlob_(text, fileName));
}

/**
 * สร้าง QR_<student_id>.png ของนักเรียน (กรองตามห้องได้ เช่น "ม.5/1")
 * ทำงานเป็นชุด หยุดก่อนหมดเวลา 6 นาทีของ Apps Script แล้วบอกจำนวนที่เหลือ
 */
function generateStudentQRs(classFilter) {
  var start = Date.now();
  var folder = folderPath_(['QR Codes', 'Students']);
  var students = readTable_('Students').filter(function (s) {
    return isStudentActive_(s) && (!classFilter || className_(s) === classFilter || String(s.class) === classFilter);
  });
  var done = 0;
  for (var i = 0; i < students.length; i++) {
    if (Date.now() - start > 4.5 * 60 * 1000) break;
    var s = students[i];
    saveQr_(folder, studentQrText_(s.student_id), 'QR_' + s.student_id + '.png');
    done++;
  }
  log_('QR_STUDENTS', { result: done + '/' + students.length });
  return { done: done, total: students.length, remaining: students.length - done, folderUrl: folder.getUrl() };
}

function generateAssignmentQRs() {
  var folder = folderPath_(['QR Codes', 'Assignments']);
  var list = readTable_('Assignments').filter(isAssignmentOpen_);
  list.forEach(function (a) {
    saveQr_(folder, taskQrText_(a.assignment_id), 'TASK_' + a.assignment_id + '.png');
  });
  log_('QR_TASKS', { result: String(list.length) });
  return { done: list.length, total: list.length, remaining: 0, folderUrl: folder.getUrl() };
}
