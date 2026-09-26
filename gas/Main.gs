/**
 * Main.gs : จุดเข้าของ Web App
 *
 * doPost  ← LINE Webhook (มี body.events)  และ  LIFF API (มี body.action)
 * doGet   ← หน้า Admin (?page=admin, ค่าเริ่มต้น) และ health check (?page=health)
 */

function doPost(e) {
  useTenant_(null); // เริ่มที่บัญชีหลักเสมอ (resolveActor_ จะสลับไปบัญชีของผู้ใช้)
  runMigrations_();
  var body = {};
  try {
    body = JSON.parse(e && e.postData && e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'BAD_JSON', message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  }

  if (body.events) {
    handleWebhook_(body);
    return json_({ ok: true });
  }
  if (body.action) {
    return json_(handleApi_(body));
  }
  return json_({ ok: false, code: 'BAD_REQUEST' });
}

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'admin';
  if (page === 'health') {
    return json_({ ok: true, app: APP_NAME, version: APP_VERSION, time: new Date().toISOString() });
  }
  useTenant_(null);
  runMigrations_();
  var auth = adminAuth_();
  if (!auth.ok) {
    var t = HtmlService.createTemplateFromFile('Denied');
    t.email = auth.email || '(ไม่ทราบ — ต้องเปิดผ่าน Admin Deployment)';
    return t.evaluate().setTitle('ไม่มีสิทธิ์เข้าถึง').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var tpl = HtmlService.createTemplateFromFile('AdminPage');
  tpl.school = getSetting_('SCHOOL_NAME', '');
  tpl.user = auth;
  return tpl.evaluate()
    .setTitle('Admin — ระบบส่งงาน ' + getSetting_('SCHOOL_NAME', ''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
