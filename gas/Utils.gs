/**
 * Utils.gs : วันที่ภาษาไทย, Log, ตัวแปลงรหัส QR
 */

function toDate_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  // รองรับ yyyy-MM-ddTHH:mm (จาก input datetime-local) และ yyyy-MM-dd
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) {
    var fmt = m[4] ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd';
    var src = m[4] ? (m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5]) : (m[1] + '-' + m[2] + '-' + m[3]);
    var d = Utilities.parseDate(src, getTz_(), fmt);
    if (!m[4]) d = new Date(d.getTime() + (23 * 60 + 59) * 60000); // ไม่มีเวลา = สิ้นวัน
    return d;
  }
  // รองรับ dd/MM/yyyy (พ.ศ. หรือ ค.ศ.)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    var y = Number(m[3]);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    var str = y + '-' + pad2_(m[2]) + '-' + pad2_(m[1]) + 'T' + (m[4] ? pad2_(m[4]) + ':' + m[5] : '23:59');
    return Utilities.parseDate(str, getTz_(), "yyyy-MM-dd'T'HH:mm");
  }
  var d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** 25/09/2569 */
function fmtDateTH_(d) {
  d = toDate_(d);
  if (!d) return '-';
  var tz = getTz_();
  var y = Number(Utilities.formatDate(d, tz, 'yyyy')) + 543;
  return Utilities.formatDate(d, tz, 'dd/MM/') + y;
}

/** 16:42 */
function fmtTimeTH_(d, withSeconds) {
  d = toDate_(d);
  if (!d) return '-';
  return Utilities.formatDate(d, getTz_(), withSeconds ? 'HH:mm:ss' : 'HH:mm');
}

function fmtDateTimeTH_(d) {
  d = toDate_(d);
  if (!d) return '-';
  return fmtDateTH_(d) + ' เวลา ' + fmtTimeTH_(d) + ' น.';
}

function isTrue_(v) {
  return v === true || ['TRUE', 'YES', 'Y', '1', 'ใช่'].indexOf(String(v).trim().toUpperCase()) >= 0;
}

function newId_(prefix) {
  var ts = Utilities.formatDate(new Date(), getTz_(), 'yyMMddHHmmss');
  var rnd = Math.floor(Math.random() * 46656).toString(36).toUpperCase();
  while (rnd.length < 3) rnd = '0' + rnd;
  return prefix + ts + rnd;
}

/** ดึงค่า query param จาก URL (ใช้กับ QR ที่เป็นลิงก์) */
function urlParam_(url, name) {
  var m = String(url).match(new RegExp('[?&]' + name + '=([^&#]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * แปลงข้อความจาก QR นักเรียน → student_id
 *   "STU-65001" → "65001",  "STU-2026-00125" → "2026-00125",
 *   "https://...?student=65001" → "65001",  "65001" → "65001"
 */
function parseStudentCode_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return urlParam_(s, 'student') || urlParam_(s, 'stu');
  var prefix = String(getSetting_('QR_STUDENT_PREFIX', 'STU-'));
  if (prefix && s.toUpperCase().indexOf(prefix.toUpperCase()) === 0) return s.substring(prefix.length).trim();
  var m = s.match(/^STU-?(.+)$/i);
  return m ? m[1].trim() : s;
}

/**
 * แปลงข้อความจาก QR งาน → assignment_id
 *   "https://liff.line.me/xxx?task=HW001" → "HW001",  "TASK-HW001" → "HW001",  "HW001" → "HW001"
 */
function parseTaskCode_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return urlParam_(s, 'task');
  var prefix = String(getSetting_('QR_TASK_PREFIX', 'TASK-'));
  if (prefix && s.toUpperCase().indexOf(prefix.toUpperCase()) === 0) return s.substring(prefix.length).trim();
  return s;
}

/** เขียน Log (ไม่ throw ต่อ แม้เขียนไม่สำเร็จ) */
function log_(event, data) {
  data = data || {};
  try {
    appendRow_('Logs', {
      timestamp: new Date(),
      event: event,
      student_id: data.student_id || '',
      line_user_id: data.line_user_id || '',
      ip: data.ip || '-', // Apps Script ไม่สามารถอ่าน IP ของผู้เรียกได้
      result: data.result || '',
      error: data.error ? String(data.error).substring(0, 500) : ''
    });
  } catch (err) {
    console.error('log_ failed', err);
  }
}
