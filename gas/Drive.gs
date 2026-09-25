/**
 * Drive.gs : โครงสร้างโฟลเดอร์และการบันทึกไฟล์งาน
 *
 * 📁 School_Submission
 *   ├── 📁 2569 / 📁 ม.5 / 📁 คอมพิวเตอร์ / 📁 HW001 / 65001_สมชาย_ใบงานที่1.pdf
 *   └── 📁 QR Codes / 📁 Students, 📁 Assignments
 */

function rootFolder_() {
  var id = getSetting_('GOOGLE_DRIVE_FOLDER_ID');
  if (!id) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_DRIVE_FOLDER_ID');
  return DriveApp.getFolderById(id);
}

function subFolder_(parent, name) {
  name = String(name || '-').replace(/[\\\/]/g, '-').trim() || '-';
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function folderPath_(names) {
  var f = rootFolder_();
  names.forEach(function (n) { f = subFolder_(f, n); });
  return f;
}

function safeName_(s) {
  return String(s || '').replace(/[\\\/:*?"<>|\s]+/g, '').substring(0, 60);
}

/** บันทึกไฟล์งานจาก base64 → คืน URL */
function saveSubmissionFile_(file, student, assignment) {
  var maxMb = getNumberSetting_('MAX_FILE_MB', 10);
  var bytes = Utilities.base64Decode(String(file.data).replace(/^data:[^,]+,/, ''));
  if (bytes.length > maxMb * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + maxMb + ' MB');

  var folder = folderPath_([
    getSetting_('ACADEMIC_YEAR', '2569'), student.class, assignment.subject, assignment.assignment_id
  ]);
  var ext = '';
  var m = String(file.name || '').match(/\.([A-Za-z0-9]{1,6})$/);
  if (m) ext = '.' + m[1].toLowerCase();
  var firstName = String(student.name || '').replace(/^(นาย|นางสาว|นาง|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.)/, '').split(/\s+/)[0];
  var name = [student.student_id, safeName_(firstName), safeName_(assignment.assignment_name)].join('_') + ext;

  // ส่งใหม่: ย้ายไฟล์เดิมชื่อเดียวกันไปถังขยะ (กู้คืนได้ 30 วัน)
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);

  var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', name);
  var saved = folder.createFile(blob);
  return saved.getUrl();
}
