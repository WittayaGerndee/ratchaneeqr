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

  var saved;
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
      saved = Object.assign({}, existing, clean);
    } else {
      if (sheetName === 'Assignments') {
        clean.created_at = new Date();
        if (!clean.status) clean.status = ASSIGNMENT_STATUS.OPEN;
      }
      if ((sheetName === 'Students' || sheetName === 'Teachers' || sheetName === 'Classes') && !clean.status) clean.status = 'active';
      appendRow_(sheetName, clean);
      saved = clean;
    }
  } finally {
    lock.releaseLock();
  }
  if (sheetName === 'Settings') _settingsMemo = null;
  if (sheetName === 'Settings' || sheetName === 'Teachers') invalidateTableCache_(sheetName);
  return saved;
}

function deleteRecord_(sheetName, id) {
  var key = SHEET_KEYS[sheetName];
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findOne_(sheetName, key, id);
    if (!row) throw new Error('ไม่พบข้อมูล');
    deleteRow_(sheetName, row._row);
    if (sheetName === 'Settings' || sheetName === 'Teachers') invalidateTableCache_(sheetName);
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
      var cr = splitClassRoom_(c[2], c[3]);
      c[2] = cr.cls; c[3] = cr.room;
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
      setTextFormat_(sh, hs, 2, data.length);
      sh.getRange(2, 1, data.length, hs.length).setValues(data);
    }
  } finally {
    lock.releaseLock();
  }
  log_('IMPORT_STUDENTS', { result: 'added ' + added + ', updated ' + updated });
  return { ok: true, added: added, updated: updated, skipped: skipped };
}

/** รหัสนักเรียนถัดไป: เลขมากสุด + 1 (คงจำนวนหลักเดิม เช่น 0009 → 0010) · ยังไม่มีเลย = 1001 */
function nextStudentId_(rows) {
  var best = null;
  rows.forEach(function (r) {
    var id = String(r.student_id || '').trim();
    if (/^\d+$/.test(id) && (!best || Number(id) > Number(best))) best = id;
  });
  if (!best) return '1001';
  var n = String(Number(best) + 1);
  while (n.length < best.length) n = '0' + n;
  return n;
}

function normNumber_(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  return s === '' ? '' : String(Number(s));
}

/**
 * เพิ่ม/แก้นักเรียน 1 คน
 * @param {Object} s { student_id? (ว่าง = รันอัตโนมัติ), name, class, room, number (เลขที่) }
 * @param {string=} oldId รหัสเดิม (แก้ไข)
 * @return {{ok:boolean, message?:string, row?:Object}}
 */
function saveStudent_(s, oldId) {
  var name = String(s.name || '').trim();
  if (!name) return { ok: false, message: 'กรุณากรอกชื่อนักเรียน' };
  var cr = splitClassRoom_(s.class, s.room);
  if (!cr.cls) return { ok: false, message: 'กรุณากรอกชั้น' };
  var number = String(s.number === undefined || s.number === null ? '' : s.number).trim();
  if (number && !/^\d{1,4}$/.test(number)) return { ok: false, message: 'เลขที่ต้องเป็นตัวเลข' };
  number = normNumber_(number);
  ensureColumns_('Students');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readTable_('Students');
    var find = function (id) { id = normId_(id); return rows.filter(function (r) { return normId_(r.student_id) === id; })[0] || null; };
    var cur = oldId ? find(oldId) : null;
    if (oldId && !cur) return { ok: false, message: 'ไม่พบนักเรียนคนนี้' };
    var id = String(s.student_id || '').trim() || (cur ? String(cur.student_id) : nextStudentId_(rows));
    var other = find(id);
    if (other && other !== cur) return { ok: false, message: 'รหัส "' + id + '" มีอยู่แล้ว' };
    var cn = className_({ class: cr.cls, room: cr.room });
    if (number) {
      var clash = rows.filter(function (r) {
        return r !== cur && isStudentActive_(r) && className_(r) === cn && normNumber_(r.number) === number;
      })[0];
      if (clash) return { ok: false, message: 'เลขที่ ' + number + ' ห้อง ' + cn + ' เป็นของ ' + clash.name + ' แล้ว' };
    }
    var rec = { student_id: id, name: name, class: cr.cls, room: cr.room, number: number, status: 'active' };
    if (cur) updateRow_('Students', cur._row, rec);
    else appendRow_('Students', rec);
    return { ok: true, row: rec };
  } finally {
    lock.releaseLock();
  }
}

/**
 * นำเข้านักเรียนแบบใหม่ (หน้า LIFF): แต่ละบรรทัด เลขที่, ชื่อ-สกุล, ชั้น, ห้อง (หรือ เลขที่, ชื่อ, ป.4/5)
 * รหัสนักเรียนรันให้อัตโนมัติ · ห้อง+เลขที่ ตรงกับคนเดิม → แก้ชื่อ · ห้อง+ชื่อ ตรงกับคนเดิม → แก้เลขที่
 * เขียนลง Sheet ครั้งเดียว
 */
function importStudentsByNumber_(text) {
  // ไม่ trim ทั้งบรรทัด: บรรทัดที่ไม่มีเลขที่ขึ้นต้นด้วย Tab (คอลัมน์แรกว่าง)
  var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  var added = 0, updated = 0, skipped = 0;
  ensureColumns_('Students');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_('Students'), hs = headers_('Students'), col = {};
    hs.forEach(function (h, i) { col[h] = i; });
    var lastRow = sh.getLastRow();
    var data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, hs.length).getValues() : [];
    var objs = data.map(function (r) { return { student_id: r[col.student_id] }; });
    var nextId = nextStudentId_(objs);
    var key = function (r) { return className_({ class: r[col['class']], room: r[col.room] }); };
    var byNum = {}, byName = {};
    data.forEach(function (r, i) {
      if (String(r[col.status] || 'active').toLowerCase() !== 'active') return;
      if (normNumber_(r[col.number]) !== '') byNum[key(r) + '|' + normNumber_(r[col.number])] = i;
      byName[key(r) + '|' + String(r[col.name]).trim()] = i;
    });
    lines.forEach(function (l) {
      var c = l.split(/\t|,/).map(function (x) { return x.trim(); });
      if (c[0] && !/^\d+$/.test(c[0]) && /เลขที่|ลำดับ|no\.?|number/i.test(c[0])) { skipped++; return; } // แถวหัวตาราง
      var num = /^\d{1,4}$/.test(c[0]) ? normNumber_(c[0]) : '';
      var name = c[1] || '';
      var cr = splitClassRoom_(c[2], c[3]);
      if (!name || !cr.cls || (c[0] && !num)) { skipped++; return; }
      var k = className_({ class: cr.cls, room: cr.room });
      var i = num ? byNum[k + '|' + num] : undefined;
      if (i === undefined) i = byName[k + '|' + name];
      if (i === undefined) {
        var row = hs.map(function () { return ''; });
        row[col.student_id] = nextId; row[col.name] = name; row[col['class']] = cr.cls; row[col.room] = cr.room;
        row[col.number] = num; row[col.status] = 'active';
        nextId = nextStudentId_([{ student_id: nextId }]);
        i = data.length; data.push(row); added++;
      } else {
        data[i][col.name] = name;
        if (num) data[i][col.number] = num;
        data[i][col.status] = 'active';
        updated++;
      }
      if (num) byNum[k + '|' + num] = i;
      byName[k + '|' + name] = i;
    });
    if (data.length) {
      setTextFormat_(sh, hs, 2, data.length);
      sh.getRange(2, 1, data.length, hs.length).setValues(data);
    }
  } finally {
    lock.releaseLock();
  }
  log_('IMPORT_STUDENTS', { result: 'added ' + added + ', updated ' + updated });
  return { ok: true, added: added, updated: updated, skipped: skipped };
}

/** แยก "ป.4/5" → { cls: "ป.4", room: "5" } (ถ้าห้องว่าง) */
function splitClassRoom_(cls, room) {
  cls = String(cls || '').trim();
  room = String(room || '').trim();
  if (!room && cls.indexOf('/') > 0) {
    var p = cls.split('/');
    room = p.pop().trim();
    cls = p.join('/').trim();
  }
  return { cls: cls, room: room };
}
