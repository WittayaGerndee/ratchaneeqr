/**
 * Tenant.gs : แยกข้อมูลของแต่ละบัญชี (โรงเรียน/ครู) — Google Sheet + โฟลเดอร์ Drive ของตัวเอง
 *
 * ทะเบียนอยู่ใน Spreadsheet หลัก:
 *   Tenants : tenant_id, school, teacher_name, owner_line_id, spreadsheet_id, folder_id, status, created_at
 *   Members : line_user_id, tenant_id, name, role (admin|teacher), status, created_at
 *
 * บัญชี MAIN = Spreadsheet หลัก (ข้อมูลเดิมของผู้ดูแลระบบ) — ผู้ดูแลคือ ADMIN_LINE_ID + แผ่น Teachers เดิม
 * ทุกคำขอ: resolveMember_(LINE userId) → useTenant_() → ฟังก์ชันอ่าน/เขียนทั้งหมดใช้ Sheet ของบัญชีนั้น
 */

var MAIN_TENANT_ID = 'MAIN';
var REGISTRY_SCHEMA = {
  Tenants: ['tenant_id', 'school', 'teacher_name', 'owner_line_id', 'spreadsheet_id', 'folder_id', 'status', 'created_at'],
  Members: ['line_user_id', 'tenant_id', 'name', 'role', 'status', 'created_at']
};

var _tenant = null;
var _masterMemo = null;

function masterSs_() {
  if (!_masterMemo) _masterMemo = SpreadsheetApp.openById(getSpreadsheetId_());
  return _masterMemo;
}

function currentTenantId_() {
  return _tenant ? _tenant.tenant_id : MAIN_TENANT_ID;
}

function isMainTenant_() {
  return currentTenantId_() === MAIN_TENANT_ID;
}

/** สลับไปใช้ข้อมูลของบัญชี t (ล้าง memo ที่ผูกกับ Spreadsheet เดิม) */
function useTenant_(t) {
  _tenant = t && t.tenant_id !== MAIN_TENANT_ID ? t : null;
  _ssMemo = null;
  _settingsMemo = null;
  _headersMemo = {};
}

function mainTenant_() {
  return { tenant_id: MAIN_TENANT_ID, spreadsheet_id: getSpreadsheetId_(), folder_id: '', status: 'active' };
}

// ---------------- ทะเบียน (อ่านจาก Spreadsheet หลักเสมอ) ----------------

function ensureRegistry_() {
  var ss = masterSs_();
  Object.keys(REGISTRY_SCHEMA).forEach(function (name) {
    var sh = ensureSheet_(ss, name, REGISTRY_SCHEMA[name]);
    sh.getRange('A:B').setNumberFormat('@');
  });
}

function registryTable_(name) {
  var cache = CacheService.getScriptCache();
  var key = 'reg_' + name;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var sh = masterSs_().getSheetByName(name);
  var rows = [];
  if (sh) {
    var values = sh.getDataRange().getValues();
    var hs = values[0].map(function (h) { return String(h).trim(); });
    for (var i = 1; i < values.length; i++) {
      if (values[i].join('') === '') continue;
      var o = { _row: i + 1 };
      hs.forEach(function (h, c) { o[h] = values[i][c] instanceof Date ? values[i][c].toISOString() : values[i][c]; });
      rows.push(o);
    }
  }
  try { cache.put(key, JSON.stringify(rows), 300); } catch (e) { /* ใหญ่เกิน */ }
  return rows;
}

function invalidateRegistry_() {
  CacheService.getScriptCache().removeAll(['reg_Tenants', 'reg_Members']);
}

function registryAppend_(name, obj) {
  var sh = masterSs_().getSheetByName(name);
  var row = REGISTRY_SCHEMA[name].map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, 2).setNumberFormat('@');
  sh.getRange(r, 1, 1, row.length).setValues([row]);
  invalidateRegistry_();
}

function registryUpdate_(name, rowNum, obj) {
  var sh = masterSs_().getSheetByName(name);
  var hs = REGISTRY_SCHEMA[name];
  var range = sh.getRange(rowNum, 1, 1, hs.length);
  var row = range.getValues()[0];
  hs.forEach(function (h, i) { if (Object.prototype.hasOwnProperty.call(obj, h)) row[i] = obj[h]; });
  range.setValues([row]);
  invalidateRegistry_();
}

function findTenant_(tenantId) {
  if (!tenantId || tenantId === MAIN_TENANT_ID) return mainTenant_();
  return registryTable_('Tenants').filter(function (t) { return t.tenant_id === tenantId; })[0] || null;
}

function activeTenants_() {
  return [mainTenant_()].concat(registryTable_('Tenants').filter(function (t) {
    return String(t.status || 'active').toLowerCase() === 'active' && t.spreadsheet_id;
  }));
}

/**
 * หาว่า LINE userId นี้เป็นครูของบัญชีไหน
 * @return {{tenant:Object, role:string, name:string}|null}
 */
function resolveMember_(userId) {
  if (!userId) return null;
  var m = registryTable_('Members').filter(function (x) {
    return x.line_user_id === userId && String(x.status || 'active').toLowerCase() === 'active';
  })[0];
  if (m) {
    var t = findTenant_(m.tenant_id);
    if (t && String(t.status || 'active').toLowerCase() === 'active') {
      return { tenant: t, role: String(m.role || 'teacher').toLowerCase(), name: m.name || '' };
    }
  }
  // บัญชี MAIN (ระบบเดิม): ADMIN_LINE_ID + แผ่น Teachers ของ Spreadsheet หลัก
  useTenant_(null);
  if (userId === getSetting_('ADMIN_LINE_ID')) {
    return { tenant: mainTenant_(), role: 'admin', name: getSetting_('ADMIN_NAME', 'ผู้ดูแลระบบ') };
  }
  var legacy = cachedTable_('Teachers').filter(function (t) {
    return t.line_user_id && t.line_user_id === userId && String(t.status || 'active').toLowerCase() === 'active';
  })[0];
  if (legacy) return { tenant: mainTenant_(), role: String(legacy.role || 'teacher').toLowerCase(), name: legacy.name || '' };
  return null;
}

/** ครูทุกคนของบัญชีปัจจุบัน (ใช้ส่งแจ้งเตือน / แสดงในหน้าตั้งค่า) */
function tenantMembers_() {
  var tid = currentTenantId_();
  var list = registryTable_('Members').filter(function (m) {
    return m.tenant_id === tid && String(m.status || 'active').toLowerCase() === 'active';
  }).map(function (m) {
    var owner = !isMainTenant_() && m.line_user_id === _tenant.owner_line_id;
    return { line_user_id: m.line_user_id, name: m.name, role: String(m.role || 'teacher').toLowerCase(), source: owner ? 'owner' : 'registry' };
  });
  if (isMainTenant_()) {
    var admin = getSetting_('ADMIN_LINE_ID');
    if (admin && !list.some(function (m) { return m.line_user_id === admin; })) {
      list.unshift({ line_user_id: admin, name: getSetting_('ADMIN_NAME', 'ผู้ดูแลระบบ'), role: 'admin', source: 'owner' });
    }
    cachedTable_('Teachers').forEach(function (t) {
      if (t.line_user_id && String(t.status || 'active').toLowerCase() === 'active' && !list.some(function (m) { return m.line_user_id === t.line_user_id; })) {
        list.push({ line_user_id: t.line_user_id, name: t.name, role: String(t.role || 'teacher').toLowerCase(), source: 'sheet' });
      }
    });
  } else if (_tenant.owner_line_id && !list.some(function (m) { return m.line_user_id === _tenant.owner_line_id; })) {
    list.unshift({ line_user_id: _tenant.owner_line_id, name: _tenant.teacher_name, role: 'admin', source: 'owner' });
  }
  return list;
}

// ---------------- สมัครใช้งาน ----------------

/**
 * สร้างบัญชีใหม่: Google Sheet + โฟลเดอร์ Drive ของตัวเอง แล้วผูก LINE userId เป็นผู้ดูแลบัญชีนั้น
 * เรียกซ้ำได้ปลอดภัย (ถ้าสมัครแล้วจะคืนบัญชีเดิม)
 */
function registerTenant_(userId, school, teacherName) {
  school = String(school || '').trim();
  teacherName = String(teacherName || '').trim();
  if (!school || !teacherName) throw new Error('กรุณากรอกชื่อโรงเรียนและชื่อครู');
  if (school.length > 100 || teacherName.length > 100) throw new Error('ชื่อยาวเกินไป');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('ระบบกำลังทำงาน กรุณาลองใหม่');
  try {
    invalidateRegistry_();
    var existing = resolveMember_(userId);
    if (existing) return existing;

    useTenant_(null);
    ensureRegistry_();
    var tenantId = 'T' + Utilities.formatDate(new Date(), getTz_(), 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);

    // โฟลเดอร์: <โฟลเดอร์หลัก>/Tenants/<โรงเรียน - ครู>
    var root = DriveApp.getFolderById(getSetting_('GOOGLE_DRIVE_FOLDER_ID') || PRESET_DRIVE_FOLDER_ID);
    var folder = subFolder_(subFolder_(root, 'Tenants'), school + ' - ' + teacherName);
    var ss = SpreadsheetApp.create('RatchaneeQR - ' + school + ' (' + teacherName + ')');
    DriveApp.getFileById(ss.getId()).moveTo(folder);

    var t = {
      tenant_id: tenantId, school: school, teacher_name: teacherName, owner_line_id: userId,
      spreadsheet_id: ss.getId(), folder_id: folder.getId(), status: 'active', created_at: new Date()
    };
    useTenant_(t);
    _ssMemo = ss;
    Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name, SCHEMA[name]); });
    ss.getSheets().forEach(function (sh) {
      if (!SCHEMA[sh.getName()] && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
    });
    ['Students', 'Assignments', 'Submissions'].forEach(function (name) {
      setTextFormat_(ss.getSheetByName(name), SCHEMA[name], 2, 999);
    });
    var settings = [
      ['SCHOOL_NAME', school, 'ชื่อโรงเรียน'],
      ['ADMIN_NAME', teacherName, 'ชื่อครูผู้ดูแล'],
      ['GOOGLE_DRIVE_FOLDER_ID', folder.getId(), 'โฟลเดอร์ Drive ของบัญชีนี้'],
      ['ACADEMIC_YEAR', getSetting_('ACADEMIC_YEAR', '2569'), 'ปีการศึกษา'],
      ['ALLOW_LATE_SUBMISSION', 'TRUE', 'อนุญาตส่งหลังกำหนด'],
      ['REMINDER_HOURS_BEFORE', '24', 'แจ้งเตือนครูก่อนครบกำหนดกี่ชั่วโมง (0 = ปิด)']
    ];
    var sh = ss.getSheetByName('Settings');
    sh.getRange(2, 1, settings.length, 3).setNumberFormat('@').setValues(settings);
    _settingsMemo = null;

    registryAppend_('Tenants', t);
    registryAppend_('Members', { line_user_id: userId, tenant_id: tenantId, name: teacherName, role: 'admin', status: 'active', created_at: new Date() });
    useTenant_(null);
    log_('REGISTER', { line_user_id: userId, result: tenantId + ' ' + school });
    useTenant_(t);
    return { tenant: t, role: 'admin', name: teacherName, created: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------- จัดการครูในบัญชี ----------------

function addMember_(lineUserId, name, role) {
  lineUserId = String(lineUserId || '').trim();
  if (!/^U[0-9a-f]{32}$/.test(lineUserId)) throw new Error('รหัส LINE ไม่ถูกต้อง (ขึ้นต้นด้วย U ตามด้วยตัวอักษร 32 ตัว)');
  role = role === 'admin' ? 'admin' : 'teacher';
  var tid = currentTenantId_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ระบบกำลังทำงาน กรุณาลองใหม่');
  try {
    ensureRegistry_();
    invalidateRegistry_();
    var other = registryTable_('Members').filter(function (m) {
      return m.line_user_id === lineUserId && String(m.status || 'active').toLowerCase() === 'active';
    })[0];
    if (other && other.tenant_id !== tid) throw new Error('ครูคนนี้ใช้งานอยู่กับอีกบัญชีหนึ่งแล้ว');
    if (!other) {
      // อาจเป็นครูของบัญชี MAIN (ADMIN_LINE_ID / แผ่น Teachers) — resolveMember_ สลับ context จึงต้องคืนค่าเดิม
      var saved = _tenant;
      var existing = resolveMember_(lineUserId);
      useTenant_(saved);
      if (existing && existing.tenant.tenant_id !== tid) throw new Error('ครูคนนี้ใช้งานอยู่กับอีกบัญชีหนึ่งแล้ว');
    }
    if (other) {
      registryUpdate_('Members', other._row, { name: name || other.name, role: role });
    } else {
      registryAppend_('Members', { line_user_id: lineUserId, tenant_id: tid, name: String(name || 'ครู').trim(), role: role, status: 'active', created_at: new Date() });
    }
  } finally {
    lock.releaseLock();
  }
  return tenantMembers_();
}

function removeMember_(lineUserId, actor) {
  if (lineUserId === actor.userId) throw new Error('ลบตัวเองไม่ได้');
  if (!isMainTenant_() && _tenant.owner_line_id === lineUserId) throw new Error('ลบเจ้าของบัญชีไม่ได้');
  var tid = currentTenantId_();
  var m = registryTable_('Members').filter(function (x) {
    return x.line_user_id === lineUserId && x.tenant_id === tid && String(x.status || 'active').toLowerCase() === 'active';
  })[0];
  if (!m) throw new Error('ครูคนนี้ถูกเพิ่มจาก Google Sheet (แผ่น Teachers) — ลบที่ Sheet แทน');
  registryUpdate_('Members', m._row, { status: 'removed' });
  return tenantMembers_();
}

/** รันฟังก์ชันกับทุกบัญชี (ใช้กับ Trigger แจ้งเตือน) */
function forEachTenant_(fn) {
  activeTenants_().forEach(function (t) {
    try {
      useTenant_(t);
      fn(t);
    } catch (err) {
      console.error('tenant ' + t.tenant_id, err);
    }
  });
  useTenant_(null);
}
