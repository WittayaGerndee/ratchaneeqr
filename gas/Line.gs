/**
 * Line.gs : LINE Messaging API + Webhook + ตรวจสอบ LIFF ID Token
 */

var LINE_API = 'https://api.line.me/v2/bot';

function lineToken_() {
  var t = getSetting_('LINE_CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน Script Properties');
  return t;
}

function lineCall_(path, payload) {
  var res = UrlFetchApp.fetch(LINE_API + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineToken_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    log_('LINE_API_ERROR', { result: path + ' ' + code, error: res.getContentText() });
    throw new Error('LINE API ' + code + ': ' + res.getContentText());
  }
  return true;
}

function lineReply_(replyToken, messages) {
  if (!replyToken) return;
  return lineCall_('/message/reply', { replyToken: replyToken, messages: [].concat(messages).slice(0, 5) });
}

function linePush_(to, messages) {
  if (!to) return;
  return lineCall_('/message/push', { to: to, messages: [].concat(messages).slice(0, 5) });
}

/** ส่งหาผู้ใช้หลายคน (สูงสุด 500 คน/ครั้ง) */
function lineMulticast_(userIds, messages) {
  var ids = userIds.filter(Boolean);
  for (var i = 0; i < ids.length; i += 500) {
    lineCall_('/message/multicast', { to: ids.slice(i, i + 500), messages: [].concat(messages).slice(0, 5) });
  }
}

function textMsg_(text) { return { type: 'text', text: String(text).substring(0, 4900) }; }

function liffButtonMsg_(text, label, params) {
  var url = getLiffUrl_(params);
  if (!url) return textMsg_(text + '\n\n(ผู้ดูแลยังไม่ได้ตั้งค่า LIFF_ID)');
  return {
    type: 'template',
    altText: text,
    template: {
      type: 'buttons',
      text: String(text).substring(0, 160),
      actions: [{ type: 'uri', label: label, uri: url }]
    }
  };
}

// ---------------- ตรวจสอบ LIFF ID Token ----------------

/**
 * ตรวจ ID Token กับ LINE → คืน { userId, displayName }
 * (cache 10 นาที เพื่อไม่ต้องเรียก LINE ทุกคำขอ)
 */
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('UNAUTHORIZED: ไม่มี ID Token');
  var cache = CacheService.getScriptCache();
  var key = 'idt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).substring(0, 40);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var channelId = getSetting_('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) throw new Error('ยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: String(channelId) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('UNAUTHORIZED: ID Token ไม่ถูกต้องหรือหมดอายุ');
  var body = JSON.parse(res.getContentText());
  var user = { userId: body.sub, displayName: body.name || '' };
  var ttl = Math.max(60, Math.min(600, Number(body.exp) - Math.floor(Date.now() / 1000)));
  cache.put(key, JSON.stringify(user), ttl);
  return user;
}

// ---------------- Webhook ----------------

/**
 * หมายเหตุ: Apps Script อ่าน HTTP header ไม่ได้ จึงตรวจ X-Line-Signature ไม่ได้
 * Webhook นี้จึงทำเฉพาะงาน "ตอบกลับ/แสดงข้อมูล" เท่านั้น ไม่มีการบันทึกการส่งงานผ่าน Webhook
 * (การบันทึกทั้งหมดผ่าน LIFF ซึ่งตรวจ ID Token)
 */
function handleWebhook_(body) {
  (body.events || []).forEach(function (ev) {
    try {
      handleEvent_(ev);
    } catch (err) {
      log_('WEBHOOK_ERROR', { line_user_id: ev.source && ev.source.userId, error: err && err.stack || err });
    }
  });
}

function handleEvent_(ev) {
  var userId = ev.source && ev.source.userId;
  var school = getSetting_('SCHOOL_NAME', '');

  if (ev.type === 'follow') {
    return lineReply_(ev.replyToken, [
      textMsg_('สวัสดีครับ 👋 ระบบเช็คการส่งงาน ' + school + ' (สำหรับครู)\n\n' + HELP_TEXT_),
      liffButtonMsg_('เริ่มสแกนเช็คการส่งงาน', '📷 สแกนส่งงาน', {})
    ]);
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  var t = String(ev.message.text || '').trim().replace(/^[^\wก-๙]+/, '').toLowerCase();

  if (t === 'myid' || t === 'ไอดี') {
    return lineReply_(ev.replyToken, textMsg_('LINE userId ของคุณ:\n' + userId +
      '\n\nส่งรหัสนี้ให้ผู้ดูแลระบบ เพื่อเพิ่มในแผ่น Teachers (คอลัมน์ line_user_id)'));
  }

  var isTeacher = !!findTeacherByLineId_(userId) || userId === getSetting_('ADMIN_LINE_ID');
  if (!isTeacher) {
    return lineReply_(ev.replyToken, textMsg_('ระบบนี้สำหรับครูเท่านั้น\nหากเป็นครู พิมพ์ myid แล้วส่งรหัสให้ผู้ดูแลระบบ'));
  }

  if (t.indexOf('สแกน') === 0 || t.indexOf('ส่งงาน') === 0) {
    return lineReply_(ev.replyToken, liffButtonMsg_('📷 สแกนส่งงาน\nเลือกงาน แล้วสแกน QR บนสมุดทีละเล่ม', 'เปิดหน้าสแกน', {}));
  }
  if (t.indexOf('เพิ่มงาน') === 0) {
    return lineReply_(ev.replyToken, liffButtonMsg_('➕ เพิ่มงานใหม่', 'เพิ่มงาน', { mode: 'new' }));
  }
  if (t.indexOf('สรุป') === 0 || t.indexOf('ยังไม่ส่ง') === 0) {
    return lineReply_(ev.replyToken, summaryMessages_());
  }
  return lineReply_(ev.replyToken, textMsg_(HELP_TEXT_));
}

var HELP_TEXT_ = '❓ คำสั่งที่ใช้ได้\n\n📷 สแกน — เปิดหน้าสแกนสมุด\n📊 สรุป — ดูว่างานไหนส่งแล้วกี่คน\n➕ เพิ่มงาน — สร้างงานใหม่\n🆔 myid — ดู LINE userId';

/** สรุปงานที่เปิดอยู่ + ปุ่มดูรายละเอียดใน LIFF */
function summaryMessages_() {
  var d = buildDashboard_('');
  if (!d.assignments.length) return textMsg_('ยังไม่มีงานที่เปิดรับ\nพิมพ์ "เพิ่มงาน" เพื่อสร้างงานใหม่');
  var lines = d.assignments.slice(0, 15).map(function (a) {
    return (a.submitted >= a.target && a.target ? '✅ ' : '⏳ ') + a.assignment_name + ' (' + a.subject + ' ' + a.class_target + ')\n    ส่ง ' +
      a.submitted + '/' + a.target + ' คน · ยังไม่ส่ง ' + (a.target - a.submitted) + ' คน';
  });
  return [
    textMsg_('📊 สรุปการส่งงาน ' + fmtDateTH_(new Date()) + '\n\n' + lines.join('\n')),
    liffButtonMsg_('ดูรายชื่อคนที่ยังไม่ส่ง', '📋 ดูรายชื่อ', { mode: 'summary' })
  ];
}
