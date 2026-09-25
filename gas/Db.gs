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
  var values = sheet_(name).getDataRange().getValues(); // อ่านครั้งเดียว (เร็วกว่าเรียกหลายครั้ง)
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim(); });
  _headersMemo[name] = headers;
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

var _headersMemo = {};

function headers_(name) {
  if (_headersMemo[name]) return _headersMemo[name];
  var sh = sheet_(name);
  _headersMemo[name] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  return _headersMemo[name];
}

/** อ่านตารางผ่าน CacheService (ใช้กับ Settings/Teachers ที่อ่านทุกคำขอแต่แก้ไม่บ่อย) */
var TABLE_CACHE_SECONDS = 120;
function cachedTable_(name) {
  var cache = CacheService.getScriptCache();
  var key = 'tbl_' + name;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var rows = readTable_(name).map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; }); return o; });
  try { cache.put(key, JSON.stringify(rows), TABLE_CACHE_SECONDS); } catch (e) { /* ใหญ่เกิน 100KB */ }
  return rows;
}
function invalidateTableCache_(name) {
  CacheService.getScriptCache().remove('tbl_' + name);
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
