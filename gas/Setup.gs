/**
 * Setup.gs : ติดตั้งระบบครั้งแรก
 *
 * วิธีใช้: เปิด Apps Script Editor → เลือกฟังก์ชัน setup → Run
 *   - สร้าง Spreadsheet (ถ้า script ไม่ได้ผูกกับ Sheet) และทุก Sheet ตาม SCHEMA
 *   - เขียนค่าเริ่มต้นใน Settings
 *   - สร้างโฟลเดอร์หลักใน Google Drive
 *   - เพิ่มผู้รัน setup เป็น admin ใน Teachers
 *   - ติดตั้ง Trigger แจ้งเตือน
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var existing = props.getProperty('SPREADSHEET_ID');
    var sid = existing || PRESET_SPREADSHEET_ID;
    ss = sid ? SpreadsheetApp.openById(sid) : SpreadsheetApp.create(APP_NAME + ' Database');
  }
  props.setProperty('SPREADSHEET_ID', ss.getId());
  _ssMemo = ss;

  Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name, SCHEMA[name]); });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('แผ่น1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  // รหัสนักเรียน/งาน เก็บเป็นข้อความ (ป้องกัน 00125 กลายเป็น 125)
  sheet_('Students').getRange('A:A').setNumberFormat('@');
  sheet_('Assignments').getRange('A:A').setNumberFormat('@');
  sheet_('Submissions').getRange('C:C').setNumberFormat('@');
  sheet_('Submissions').getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm:ss');
  sheet_('Assignments').getRange('F:F').setNumberFormat('dd/mm/yyyy hh:mm');

  // Settings เริ่มต้น (ไม่ทับค่าที่มีอยู่แล้ว)
  var have = {};
  readTable_('Settings').forEach(function (r) { have[r.key] = true; });
  DEFAULT_SETTINGS.forEach(function (s) {
    if (!have[s[0]]) appendRow_('Settings', { key: s[0], value: s[1], description: s[2] });
  });
  _settingsMemo = null;

  // โฟลเดอร์หลักใน Drive
  var rootId = getSetting_('GOOGLE_DRIVE_FOLDER_ID');
  if (!rootId) {
    rootId = PRESET_DRIVE_FOLDER_ID || DriveApp.createFolder('School_Submission').getId();
    setSettingValue_('GOOGLE_DRIVE_FOLDER_ID', rootId);
  }

  // ผู้รัน setup = admin
  var email = Session.getEffectiveUser().getEmail();
  if (email && !readTable_('Teachers').some(function (t) { return normId_(t.email) === normId_(email); })) {
    appendRow_('Teachers', { teacher_id: 'T001', name: 'ผู้ดูแลระบบ', email: email, role: 'admin', status: 'active' });
  }

  installTriggers();
  log_('SETUP', { result: 'OK ' + APP_VERSION });
  console.log('✅ Setup เสร็จ: ' + ss.getUrl());
  console.log('⚠️ อย่าลืมตั้ง Script Property: LINE_CHANNEL_ACCESS_TOKEN และกรอก LIFF_ID / LINE_LOGIN_CHANNEL_ID ใน Settings');
  return ss.getUrl();
}

/** ใส่ข้อมูลตัวอย่างเพื่อทดสอบ (รันหลัง setup) */
function seedSampleData() {
  var tz = getTz_();
  if (!readTable_('Classes').length) {
    [['M5-1', 'ม.5/1', 'ม.5', '1'], ['M5-2', 'ม.5/2', 'ม.5', '2'], ['M5-3', 'ม.5/3', 'ม.5', '3']].forEach(function (c) {
      appendRow_('Classes', { class_id: c[0], class_name: c[1], level: c[2], room: c[3], teacher: 'ครู A', status: 'active' });
    });
  }
  if (!readTable_('Students').length) {
    [
      ['65001', 'นายสมชาย ใจดี', '1'], ['65002', 'นางสาวสมใจ ดีมาก', '1'], ['65003', 'นายมานะ ขยัน', '1'],
      ['65004', 'นางสาวมานี มีสุข', '2'], ['65005', 'นายปิติ ยินดี', '2'], ['65006', 'นางสาวชูใจ ใฝ่รู้', '3']
    ].forEach(function (s) {
      appendRow_('Students', { student_id: s[0], name: s[1], class: 'ม.5', room: s[2], status: 'active' });
    });
  }
  if (!readTable_('Assignments').length) {
    var due = new Date(Date.now() + 5 * 86400000);
    due = Utilities.parseDate(Utilities.formatDate(due, tz, 'yyyy-MM-dd') + ' 16:00', tz, 'yyyy-MM-dd HH:mm');
    appendRow_('Assignments', {
      assignment_id: 'HW001', subject: 'คอมพิวเตอร์', assignment_name: 'ใบงานที่ 1', description: '',
      class_target: 'ม.5', due_date: due, teacher: 'ครู A', status: 'OPEN',
      allow_resubmit: 'FALSE', require_file: 'FALSE', created_at: new Date()
    });
    appendRow_('Assignments', {
      assignment_id: 'HW002', subject: 'วิทยาศาสตร์', assignment_name: 'ใบงานที่ 2', description: 'แนบไฟล์ PDF',
      class_target: 'ม.5/1', due_date: due, teacher: 'ครู B', status: 'OPEN',
      allow_resubmit: 'TRUE', require_file: 'TRUE', created_at: new Date()
    });
  }
  console.log('✅ เพิ่มข้อมูลตัวอย่างแล้ว');
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  } else {
    // เพิ่มคอลัมน์ที่ยังไม่มี (รองรับการอัปเดตเวอร์ชัน)
    var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    cols.forEach(function (c) {
      if (cur.indexOf(c) < 0) {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(c);
        cur.push(c);
      }
    });
  }
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#e8f5e9');
  sh.setFrozenRows(1);
  return sh;
}

function setSettingValue_(key, value) {
  var row = findOne_('Settings', 'key', key);
  if (row) updateRow_('Settings', row._row, { value: value });
  else appendRow_('Settings', { key: key, value: value, description: '' });
  _settingsMemo = null;
  invalidateTableCache_('Settings');
}

/** ติดตั้ง Trigger: แจ้งเตือนทุกชั่วโมง + สรุปรายวัน 18:00 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendDueReminders' || fn === 'sendDailySummary') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDueReminders').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('sendDailySummary').timeBased().everyDays(1).atHour(18).create();
}

/**
 * ปรับข้อมูลเวอร์ชันเก่าให้เป็นปัจจุบัน (รันอัตโนมัติครั้งเดียวต่อเวอร์ชัน เมื่อมีคำขอแรกเข้ามา)
 */
var MIGRATION_VERSION = '3';
function runMigrations_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('MIGRATION_VERSION') === MIGRATION_VERSION) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    if (props.getProperty('MIGRATION_VERSION') === MIGRATION_VERSION) return;
    // v3: ชื่อโรงเรียน/ครู ตามที่ผู้ใช้กำหนด + ตั้งคอลัมน์รหัสให้เป็นข้อความ
    var school = getSetting_('SCHOOL_NAME', '');
    if (!school || school === 'โรงเรียนตัวอย่าง') setSettingValue_('SCHOOL_NAME', 'โรงเรียนอนุบาลศรีสุทโธ');
    if (!findOne_('Settings', 'key', 'ADMIN_NAME')) setSettingValue_('ADMIN_NAME', 'ครูรัชนี');
    ['Students', 'Assignments', 'Submissions'].forEach(function (name) {
      var sh = sheet_(name);
      setTextFormat_(sh, headers_(name), 2, Math.max(sh.getMaxRows() - 1, 1));
    });
    props.setProperty('MIGRATION_VERSION', MIGRATION_VERSION);
    log_('MIGRATION', { result: 'v' + MIGRATION_VERSION });
  } catch (err) {
    log_('MIGRATION_ERROR', { error: err && err.stack || err });
  } finally {
    lock.releaseLock();
  }
}
