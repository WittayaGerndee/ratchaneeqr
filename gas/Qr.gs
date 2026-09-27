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

/**
 * สร้าง PDF สติกเกอร์ QR (A4) เก็บในโฟลเดอร์ Drive ของบัญชี แล้วเปิดลิงก์ให้ดูได้
 * @param {string} classFilter  เช่น "ป.4/5" (ว่าง = ทุกห้อง)
 * @param {number} sizeMm       ขนาดสติกเกอร์ 30 / 38 / 50 มม.
 */
function buildQrPdf_(classFilter, sizeMm) {
  sizeMm = [30, 38, 50].indexOf(sizeMm) >= 0 ? sizeMm : 38;
  var students = readTable_('Students').filter(function (s) {
    return isStudentActive_(s) && (!classFilter || className_(s) === classFilter);
  }).sort(function (a, b) {
    return String(className_(a)).localeCompare(String(className_(b)), 'th', { numeric: true }) ||
      byNumber_(a, b) || String(a.student_id).localeCompare(String(b.student_id), 'th', { numeric: true });
  });
  if (!students.length) throw new Error('ไม่มีนักเรียนในห้องที่เลือก');
  if (students.length > 400) throw new Error('นักเรียนเยอะเกินไป (' + students.length + ' คน) กรุณาเลือกทีละห้อง');

  var title = classFilter || 'ทุกห้อง';
  var stamp = Utilities.formatDate(new Date(), getTz_(), 'yyyyMMdd-HHmm');
  var name = 'QR_' + title.replace(/[\/\\]/g, '-') + '_' + stamp + '.pdf';
  var pdf = renderQrPdf_(students, sizeMm).setName(name);
  var folder = folderPath_(['QR Codes', 'PDF']);
  var file = folder.createFile(pdf);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* โดเมนไม่อนุญาต */ }
  log_('QR_PDF', { result: title + ' ' + students.length });
  return {
    title: title, count: students.length, name: name, fileId: file.getId(),
    url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    download: 'https://drive.google.com/uc?export=download&id=' + file.getId()
  };
}

/** เรียงตามเลขที่ (คนที่ยังไม่มีเลขที่อยู่ท้าย) */
function byNumber_(a, b) {
  var x = a.number === '' || a.number === undefined || a.number === null ? Infinity : Number(a.number);
  var y = b.number === '' || b.number === undefined || b.number === null ? Infinity : Number(b.number);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** แถวสติกเกอร์ต่อหน้า A4 ตามขนาด (เผื่อหัวห้องด้านบน) */
var QR_ROWS_PER_PAGE = { 30: 6, 38: 5, 50: 4 };

/**
 * สร้าง PDF (Blob) จากรายชื่อนักเรียน: [{student_id, name, class, room}]
 * แยกหน้าตามห้อง (ห้องใหม่ขึ้นหน้าใหม่) และทุกหน้ามีหัว "ห้อง …"
 */
function renderQrPdf_(students, sizeMm) {
  var prefix = getSetting_('QR_STUDENT_PREFIX', 'STU-');
  var images = fetchQrImages_(students.map(function (s) { return prefix + s.student_id; }));
  var school = getSetting_('SCHOOL_NAME', '');

  var cols = Math.floor(194 / (sizeMm + 4));
  var perPage = cols * (QR_ROWS_PER_PAGE[sizeMm] || 5);
  var font = sizeMm <= 30 ? 7.5 : sizeMm <= 38 ? 9 : 11;
  var imgMm = sizeMm - 4;
  var cell = function (s, i) {
    return '<td style="width:' + sizeMm + 'mm;padding:1.5mm;border:0.3mm dashed #999;text-align:center;vertical-align:top;font-size:' + font + 'pt">' +
      '<img src="data:image/png;base64,' + images[i] + '" style="width:' + imgMm + 'mm;height:' + imgMm + 'mm"><br>' +
      '<b>' + htmlEsc_(s.student_id) + '</b><br><div style="white-space:nowrap;overflow:hidden;width:' + sizeMm + 'mm">' + htmlEsc_(s.name) + '</div>' +
      '<span style="color:#555">' + htmlEsc_(className_(s)) + (s.number !== '' && s.number !== undefined && s.number !== null ? ' · เลขที่ ' + htmlEsc_(s.number) : '') + '</span></td>';
  };

  // จัดกลุ่มตามห้อง (รายชื่อเรียงตามห้องมาแล้ว)
  var rooms = [];
  students.forEach(function (s, i) {
    var cn = className_(s);
    var last = rooms[rooms.length - 1];
    if (!last || last.name !== cn) rooms.push(last = { name: cn, items: [] });
    last.items.push({ s: s, i: i });
  });

  var pages = [];
  rooms.forEach(function (room) {
    var total = Math.ceil(room.items.length / perPage);
    for (var p = 0; p < total; p++) {
      var chunk = room.items.slice(p * perPage, (p + 1) * perPage);
      var rows = [];
      for (var k = 0; k < chunk.length; k += cols) {
        var r = chunk.slice(k, k + cols).map(function (x) { return cell(x.s, x.i); });
        while (r.length < cols) r.push('<td style="width:' + sizeMm + 'mm"></td>');
        rows.push('<tr>' + r.join('') + '</tr>');
      }
      pages.push('<div style="' + (pages.length ? 'page-break-before:always;' : '') + '">' +
        '<table style="width:100%;border-bottom:0.5mm solid #000;margin-bottom:2mm"><tr>' +
        '<td style="font-size:18pt;font-weight:bold">ห้อง ' + htmlEsc_(room.name) + '</td>' +
        '<td style="text-align:right;font-size:9pt;color:#444">' + htmlEsc_(school) + '<br>' + room.items.length + ' คน' +
        (total > 1 ? ' · หน้า ' + (p + 1) + '/' + total : '') + '</td></tr></table>' +
        '<table style="border-collapse:separate;border-spacing:2mm">' + rows.join('') + '</table></div>');
    }
  });

  var html = '<html><head><meta charset="utf-8"><style>@page{size:A4;margin:8mm}body{font-family:"Sarabun","Noto Sans Thai",sans-serif;margin:0}' +
    'tr{page-break-inside:avoid}</style></head><body>' + pages.join('') + '</body></html>';
  return Utilities.newBlob(html, 'text/html', 'qr.html').getAs('application/pdf');
}

/** ดึงรูป QR หลายรูปพร้อมกัน (สำรองด้วยผู้ให้บริการที่ 2) → base64 */
function fetchQrImages_(texts) {
  var out = [];
  for (var i = 0; i < texts.length; i += 60) {
    var chunk = texts.slice(i, i + 60);
    var res = UrlFetchApp.fetchAll(chunk.map(function (t) {
      return { url: QR_API + '?size=300&margin=1&ecLevel=M&format=png&text=' + encodeURIComponent(t), muteHttpExceptions: true };
    }));
    res.forEach(function (r, j) {
      if (r.getResponseCode() !== 200) {
        r = UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=4&data=' + encodeURIComponent(chunk[j]), { muteHttpExceptions: true });
        if (r.getResponseCode() !== 200) throw new Error('สร้างรูป QR ไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
      out.push(Utilities.base64Encode(r.getBlob().getBytes()));
    });
  }
  return out;
}

function htmlEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
