/**
 * Subjects.gs : วิชา — ครูเพิ่มวิชาก่อน แล้วสร้างใบงานในวิชานั้น
 * ใบงานเก็บชื่อวิชาในคอลัมน์ subject (เหมือนเดิม) ส่วนแผ่น Subjects เป็นรายการวิชาให้เลือก
 */

/** บัญชีที่สร้างก่อนมีเมนูวิชา ยังไม่มีแผ่น Subjects */
function ensureSubjectsSheet_() {
  if (!ss_().getSheetByName('Subjects')) ensureSheet_(ss_(), 'Subjects', SCHEMA.Subjects);
}

function sameName_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function isSubjectActive_(r) {
  return String(r.status || 'active').toLowerCase() !== 'deleted';
}

function publicSubject_(r) {
  return { subject_id: String(r.subject_id), name: String(r.name), class_target: String(r.class_target || '') };
}

function nextSubjectId_(rows) {
  var max = 0;
  rows.forEach(function (r) {
    var m = String(r.subject_id).match(/^SJ(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'SJ' + ('00' + (max + 1)).slice(-3);
}

/**
 * รายชื่อวิชา — วิชาที่มีอยู่ในใบงานเดิมแต่ยังไม่อยู่ในแผ่น Subjects จะถูกเพิ่มให้อัตโนมัติ
 * @param {Array=} assignments แถวของแผ่น Assignments (ถ้าอ่านไว้แล้ว)
 */
function listSubjects_(assignments) {
  ensureSubjectsSheet_();
  var rows = readTable_('Subjects');
  var missing = [];
  (assignments || readTable_('Assignments')).forEach(function (a) {
    var n = String(a.subject || '').trim();
    if (n && !rows.some(function (r) { return sameName_(r.name, n); }) && !missing.some(function (x) { return sameName_(x, n); })) missing.push(n);
  });
  if (missing.length) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      rows = readTable_('Subjects');
      missing.forEach(function (n) {
        if (rows.some(function (r) { return sameName_(r.name, n); })) return;
        var rec = { subject_id: nextSubjectId_(rows), name: n, class_target: '', status: 'active', created_at: new Date() };
        appendRow_('Subjects', rec);
        rows.push(rec);
      });
    } finally {
      lock.releaseLock();
    }
  }
  return rows.filter(isSubjectActive_).map(publicSubject_);
}

/** ใบงานที่อ้างถึงวิชาที่ยังไม่มีในรายการ → เพิ่มวิชาให้ (กันข้อมูลไม่ตรงกัน) */
function ensureSubjectNamed_(name) {
  listSubjects_([{ subject: name }]);
}

/**
 * เพิ่ม/แก้ไขวิชา — เปลี่ยนชื่อวิชาจะเปลี่ยนชื่อในใบงานและรายการส่งงานเดิมให้ด้วย
 * @param {Object} p { subject_id?, name, class_target? }
 */
function saveSubject_(p) {
  var name = String(p.name || '').trim();
  if (!name) return { ok: false, message: 'กรุณากรอกชื่อวิชา' };
  ensureSubjectsSheet_();
  var renamed = null, saved;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readTable_('Subjects').filter(isSubjectActive_);
    var id = String(p.subject_id || '').trim();
    var clash = rows.filter(function (r) { return sameName_(r.name, name) && String(r.subject_id) !== id; })[0];
    if (clash) return { ok: false, message: 'มีวิชา "' + clash.name + '" อยู่แล้ว' };
    var cls = String(p.class_target || '').trim();
    if (!id) {
      saved = { subject_id: nextSubjectId_(readTable_('Subjects')), name: name, class_target: cls, status: 'active', created_at: new Date() };
      appendRow_('Subjects', saved);
    } else {
      var cur = rows.filter(function (r) { return String(r.subject_id) === id; })[0];
      if (!cur) return { ok: false, message: 'ไม่พบวิชานี้' };
      updateRow_('Subjects', cur._row, { name: name, class_target: cls });
      if (name !== String(cur.name)) {
        renamed = { from: String(cur.name), to: name };
        renameSubjectInSheet_('Assignments', cur.name, name);
        renameSubjectInSheet_('Submissions', cur.name, name);
      }
      saved = Object.assign({}, cur, { name: name, class_target: cls });
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, subject: publicSubject_(saved), renamed: renamed, subjects: listSubjects_() };
}

/** เปลี่ยนชื่อวิชาในคอลัมน์ subject ของทั้งแผ่น (เขียนครั้งเดียว) */
function renameSubjectInSheet_(sheetName, from, to) {
  var sh = sheet_(sheetName), hs = headers_(sheetName), col = hs.indexOf('subject');
  var last = sh.getLastRow();
  if (col < 0 || last < 2) return;
  var range = sh.getRange(2, col + 1, last - 1, 1), vals = range.getValues(), changed = false;
  vals.forEach(function (v) { if (sameName_(v[0], from)) { v[0] = to; changed = true; } });
  if (changed) range.setValues(vals);
}

/** ลบวิชา — ลบได้เฉพาะวิชาที่ยังไม่มีใบงาน */
function deleteSubject_(subjectId) {
  ensureSubjectsSheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cur = readTable_('Subjects').filter(function (r) { return String(r.subject_id) === String(subjectId) && isSubjectActive_(r); })[0];
    if (!cur) return { ok: false, message: 'ไม่พบวิชานี้' };
    var used = readTable_('Assignments').filter(function (a) { return sameName_(a.subject, cur.name); }).length;
    if (used) return { ok: false, message: 'วิชานี้มีใบงาน ' + used + ' ใบ ลบไม่ได้ — ลบหรือย้ายใบงานก่อน' };
    deleteRow_('Subjects', cur._row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, subjects: listSubjects_() };
}
