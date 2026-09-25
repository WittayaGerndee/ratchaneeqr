/**
 * Db.gs : ตัวช่วยอ่าน/เขียน Google Sheets แบบ object
 */

var _ssMemo = null;

function ss_() {
  if (!_ssMemo) _ssMemo = SpreadsheetApp.openById(getSpreadsheetId_());
  return _ssMemo;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบ Sheet: ' + name + ' (รัน setup() ก่อน)');
  return sh;
}

/** อ่านทั้ง Sheet เป็น array ของ object (มี _row = เลขแถวจริงใน Sheet) */
function readTable_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = { _row: i + 1 };
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = row[c];
    }
    out.push(obj);
  }
  return out;
}

function headers_(name) {
  var sh = sheet_(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var hs = headers_(name);
  var row = hs.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sh.appendRow(row);
  return sh.getLastRow();
}

/** แก้ไขเฉพาะคอลัมน์ที่ส่งมาใน obj */
function updateRow_(name, rowNum, obj) {
  var sh = sheet_(name);
  var hs = headers_(name);
  var range = sh.getRange(rowNum, 1, 1, hs.length);
  var row = range.getValues()[0];
  hs.forEach(function (h, i) {
    if (Object.prototype.hasOwnProperty.call(obj, h)) row[i] = obj[h];
  });
  range.setValues([row]);
}

function deleteRow_(name, rowNum) {
  sheet_(name).deleteRow(rowNum);
}

function findOne_(name, key, value) {
  var v = normId_(value);
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) {
    if (normId_(rows[i][key]) === v) return rows[i];
  }
  return null;
}

function normId_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/** แปลง Date → ISO string และตัด _row ออก เพื่อส่งให้ client ได้ */
function serialize_(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Object.prototype.toString.call(obj) === '[object Date]') {
    return isNaN(obj.getTime()) ? '' : obj.toISOString();
  }
  if (Array.isArray(obj)) return obj.map(serialize_);
  if (typeof obj === 'object') {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = serialize_(obj[k]); });
    return out;
  }
  return obj;
}
