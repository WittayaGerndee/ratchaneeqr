/**
 * ============================================================
 *  RatchaneeQR — ระบบส่งงานนักเรียนด้วย QR Code + LINE OA
 *  Config.gs : โครงสร้าง Sheet, ค่าคงที่ และการอ่านค่า Settings
 * ============================================================
 */

var APP_NAME = 'RatchaneeQR';
var APP_VERSION = '1.0.0';

/** ค่าของโรงเรียนนี้ (setup() ใช้ค่าเหล่านี้แทนการสร้างใหม่) */
var PRESET_SPREADSHEET_ID = '10DKkTCgoCYWFtTAJftUjtqY1DhxcyX5hj_QjJEyQZGk';
var PRESET_DRIVE_FOLDER_ID = '1SNatJsmKiKfBJYlzz0fwEjVByDreBqUF';

/** ค่าที่ใช้เมื่อช่องใน Sheet Settings ว่าง (ค่าใน Sheet มาก่อนเสมอ) */
var PRESET_SETTINGS = {
  GOOGLE_DRIVE_FOLDER_ID: PRESET_DRIVE_FOLDER_ID,
  LIFF_ID: '2011746825-S9XJTTnb',
  LINE_LOGIN_CHANNEL_ID: '2011746825',
  ADMIN_LINE_ID: 'Uc675b478d6bb8e03c3e21d11f8da50b8'
};

/** โครงสร้างคอลัมน์ของทุก Sheet (ลำดับคอลัมน์ = ลำดับใน array) */
var SCHEMA = {
  Students: [
    'student_id', 'citizen_code', 'name', 'class', 'room', 'status',
    'line_user_id', 'linked_at', 'note'
  ],
  Classes: [
    'class_id', 'class_name', 'level', 'room', 'teacher', 'status'
  ],
  Assignments: [
    'assignment_id', 'subject', 'assignment_name', 'description', 'class_target',
    'due_date', 'teacher', 'status', 'allow_resubmit', 'require_file',
    'created_at', 'reminded_at'
  ],
  Submissions: [
    'submission_id', 'timestamp', 'student_id', 'name', 'class', 'room',
    'assignment_id', 'assignment', 'subject', 'status', 'attempt', 'is_late',
    'line_user_id', 'submitted_by', 'file_url', 'checked_by', 'checked_at',
    'score', 'note', 'updated_at'
  ],
  Teachers: [
    'teacher_id', 'name', 'email', 'line_user_id', 'role', 'status'
  ],
  Settings: [
    'key', 'value', 'description'
  ],
  Logs: [
    'timestamp', 'event', 'student_id', 'line_user_id', 'ip', 'result', 'error'
  ]
};

/** คอลัมน์ key ของแต่ละ Sheet (ใช้สำหรับค้นหา/แก้ไข) */
var SHEET_KEYS = {
  Students: 'student_id',
  Classes: 'class_id',
  Assignments: 'assignment_id',
  Submissions: 'submission_id',
  Teachers: 'teacher_id',
  Settings: 'key'
};

/** สถานะการส่งงาน (ยังไม่ส่ง → ส่งแล้ว → ครูตรวจแล้ว → ผ่าน / แก้ไข) */
var SUBMISSION_STATUS = {
  NOT_SUBMITTED: 'ยังไม่ส่ง',
  SUBMITTED: 'ส่งแล้ว',
  CHECKED: 'ครูตรวจแล้ว',
  PASSED: 'ผ่าน',
  REVISE: 'แก้ไข'
};

var ASSIGNMENT_STATUS = { OPEN: 'OPEN', CLOSED: 'CLOSED' };

/** ค่าเริ่มต้นของ Settings (setup() จะเขียนลง Sheet ให้) */
var DEFAULT_SETTINGS = [
  ['SCHOOL_NAME', 'โรงเรียนตัวอย่าง', 'ชื่อโรงเรียน (แสดงใน LINE/LIFF/Admin)'],
  ['TIMEZONE', 'Asia/Bangkok', 'Timezone'],
  ['ACADEMIC_YEAR', '2569', 'ปีการศึกษา (ใช้เป็นชื่อโฟลเดอร์ใน Drive)'],
  ['GOOGLE_DRIVE_FOLDER_ID', '', 'โฟลเดอร์หลักใน Drive (setup() สร้างให้อัตโนมัติ)'],
  ['LIFF_ID', '', 'LIFF ID เช่น 2001234567-AbCdEfGh'],
  ['LINE_LOGIN_CHANNEL_ID', '', 'Channel ID ของ LINE Login channel ที่สร้าง LIFF (ใช้ตรวจ ID Token)'],
  ['ADMIN_LINE_ID', '', 'LINE userId ของผู้ดูแล (รับสรุปรายวัน) — พิมพ์ "myid" ใน LINE OA เพื่อดู'],
  ['REQUIRE_ID_TOKEN', 'TRUE', 'ตรวจ LINE ID Token ทุกคำขอจาก LIFF (ควรเป็น TRUE เสมอบน production)'],
  ['ALLOW_MANUAL_ENTRY', 'FALSE', 'อนุญาตให้นักเรียนพิมพ์รหัสเองแทนการสแกน (ครูพิมพ์ได้เสมอ)'],
  ['ALLOW_LATE_SUBMISSION', 'TRUE', 'อนุญาตส่งหลังกำหนด (จะถูกทำเครื่องหมายว่าส่งช้า)'],
  ['NOTIFY_ON_SUBMIT', 'TRUE', 'ส่งข้อความยืนยันกลับทาง LINE หลังส่งงาน'],
  ['REMINDER_HOURS_BEFORE', '24', 'แจ้งเตือนนักเรียนที่ยังไม่ส่ง ก่อนกำหนดส่งกี่ชั่วโมง'],
  ['MAX_FILE_MB', '10', 'ขนาดไฟล์แนบสูงสุด (MB)'],
  ['QR_STUDENT_PREFIX', 'STU-', 'คำนำหน้า QR นักเรียน'],
  ['QR_TASK_PREFIX', 'TASK-', 'คำนำหน้า QR งาน (ใช้เมื่อยังไม่ได้ตั้ง LIFF_ID)']
];

/**
 * ค่าที่เป็นความลับ ให้เก็บใน Script Properties (Project Settings → Script Properties)
 * แทนการเก็บใน Sheet เพราะครูที่มีสิทธิ์แก้ Sheet จะมองเห็นได้
 *   LINE_CHANNEL_ACCESS_TOKEN  (จำเป็น)
 */
var SECRET_KEYS = ['LINE_CHANNEL_ACCESS_TOKEN'];

var _settingsMemo = null;

/** อ่านค่า Setting: Script Properties ก่อน แล้วค่อยดูใน Sheet Settings */
function getSetting_(key, fallback) {
  var prop = PropertiesService.getScriptProperties().getProperty(key);
  if (prop !== null && prop !== '') return prop;
  // ค่าลับ (SECRET_KEYS) ยังอ่านจาก Sheet ได้เป็น fallback แต่ไม่แนะนำ
  if (!_settingsMemo) {
    _settingsMemo = {};
    try {
      readTable_('Settings').forEach(function (r) {
        _settingsMemo[String(r.key).trim()] = r.value;
      });
    } catch (err) { /* ยังไม่ได้ setup */ }
  }
  var v = _settingsMemo[key];
  if ((v === undefined || v === null || v === '') && PRESET_SETTINGS[key]) v = PRESET_SETTINGS[key];
  if (v === undefined || v === null || v === '') return fallback !== undefined ? fallback : '';
  return v;
}

function getBoolSetting_(key, fallback) {
  var v = getSetting_(key, fallback ? 'TRUE' : 'FALSE');
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function getNumberSetting_(key, fallback) {
  var n = Number(getSetting_(key, fallback));
  return isNaN(n) ? fallback : n;
}

function getTz_() {
  return getSetting_('TIMEZONE', 'Asia/Bangkok');
}

function getSpreadsheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return id;
  if (PRESET_SPREADSHEET_ID) return PRESET_SPREADSHEET_ID;
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active.getId();
  throw new Error('ยังไม่ได้ตั้งค่า SPREADSHEET_ID — กรุณารัน setup() ก่อน');
}

/** URL ของ LIFF (ใช้ใน LINE message และ QR งาน) */
function getLiffUrl_(params) {
  var liffId = getSetting_('LIFF_ID');
  if (!liffId) return '';
  var url = 'https://liff.line.me/' + liffId;
  if (params) {
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    if (qs) url += '?' + qs;
  }
  return url;
}
