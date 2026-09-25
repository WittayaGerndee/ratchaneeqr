/**
 * Records.gs : เพิ่ม/แก้ไข/ลบ/นำเข้าข้อมูล (ใช้ร่วมกันระหว่างหน้า LIFF และหน้า Admin)
 * ตรวจสิทธิ์ที่ผู้เรียก (Api.gs / Admin.gs) ก่อนเรียกฟังก์ชันเหล่านี้
 */

/**
 * เพิ่มหรือแก้ไข 1 แถว
 * @param {string} sheetName
 * @param {Object} obj       ค่าที่จะบันทึก (เฉพาะคอลัมน์ใน SCHEMA)
 * @param {boolean} isNew    true = ต้องเป็นรหัสใหม่
 * @param {string=} oldId    รหัสเดิม (กรณีแก้ไขรหัส)
 */
function saveRecord_(sheetName, obj, isNew, oldId) {
  var key = SHEET_KEYS[sheetName];
  var id = String(obj[key] || '').trim();
  if (!id) throw new Error('กรุณากรอกรหัส');

  var clean = {};
  SCHEMA[sheetName].forEach(function (c) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) clean[c] = typeof obj[c] === 'string' ? obj[c].trim() : obj[c];
  });
  clean[key] = id;
  if (sheetName === 'Assignments') {
    if (Object.prototype.hasOwnProperty.call(clean, 'due_date')) clean.due_date = clean.due_date ? (toDate_(clean.due_date) || clean.due_date) : '';
    if (clean.status) clean.status = String(clean.status).toUpperCase();
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readTable_(sheetName);
    var find = function (v) {
      v = normId_(v);
      for (var i = 0; i < rows.length; i++) if (normId_(rows[i][key]) === v) return rows[i];
      return null;
    };
    var existing = find(oldId || id);
    if (isNew && existing) throw new Error('รหัส "' + id + '" มีอยู่แล้ว');
    if (!isNew && oldId && normId_(oldId) !== normId_(id) && find(id)) throw new Error('รหัส "' + id + '" มีอยู่แล้ว');

    if (existing && !isNew) {
      if (sheetName === 'Assignments' && Object.prototype.hasOwnProperty.call(clean, 'due_date') &&
          String(toDate_(existing.due_date)) !== String(toDate_(clean.due_date))) {
        clean.reminded_at = ''; // เปลี่ยนกำหนดส่ง → เตือนใหม่ได้
      }
      updateRow_(sheetName, existing._row, clean);
    } else {
      if (sheetName === 'Assignments') {
        clean.created_at = new Date();
        if (!clean.status) clean.status = ASSIGNMENT_STATUS.OPEN;
      }
      if ((sheetName === 'Students' || sheetName === 'Teachers' || sheetName === 'Classes') && !clean.status) clean.status = 'active';
      appendRow_(sheetName, clean);
    }
  } finally {
    lock.releaseLock();
  }
  if (sheetName === 'Settings') _settingsMemo = null;
  return findOne_(sheetName, key, id);
}

function deleteRecord_(sheetName, id) {
  var key = SHEET_KEYS[sheetName];
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findOne_(sheetName, key, id);
    if (!row) throw new Error('ไม่พบข้อมูล');
    deleteRow_(sheetName, row._row);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * นำเข้านักเรียนจากข้อความที่วางจาก Excel/Sheets
 * แต่ละบรรทัด: รหัส, ชื่อ-สกุล, ชั้น, ห้อง  (คั่นด้วย Tab หรือ ,)  — รหัสที่มีอยู่แล้วจะถูกอัปเดต
 * เขียนลง Sheet ครั้งเดียว (เร็วแม้มีหลายร้อยคน)
 */
function importStudents_(text) {
  var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var added = 0, updated = 0, skipped = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_('Students');
    var hs = headers_('Students');
    var col = {};
    hs.forEach(function (h, i) { col[h] = i; });
    var lastRow = sh.getLastRow();
    var data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, hs.length).getValues() : [];
    var index = {};
    data.forEach(function (r, i) { index[normId_(r[col.student_id])] = i; });

    lines.forEach(function (l) {
      var c = l.split(/\t|,/).map(function (x) { return x.trim(); });
      if (!c[0] || !c[1] || /student_id|รหัส/i.test(c[0])) { skipped++; return; }
      var i = index[normId_(c[0])];
      if (i === undefined) {
        var row = hs.map(function () { return ''; });
        row[col.student_id] = c[0]; row[col.name] = c[1]; row[col.class] = c[2] || ''; row[col.room] = c[3] || '';
        row[col.status] = 'active';
        index[normId_(c[0])] = data.length;
        data.push(row);
        added++;
      } else {
        data[i][col.name] = c[1];
        if (c[2]) data[i][col.class] = c[2];
        if (c[3]) data[i][col.room] = c[3];
        data[i][col.status] = 'active';
        updated++;
      }
    });
    if (data.length) {
      sh.getRange(2, col.student_id + 1, data.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, data.length, hs.length).setValues(data);
    }
  } finally {
    lock.releaseLock();
  }
  log_('IMPORT_STUDENTS', { result: 'added ' + added + ', updated ' + updated });
  return { ok: true, added: added, updated: updated, skipped: skipped };
}
