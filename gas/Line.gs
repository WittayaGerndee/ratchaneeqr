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
      textMsg_('สวัสดีครับ 👋 ยินดีต้อนรับสู่ระบบส่งงาน ' + school +
        '\n\nพิมพ์คำสั่ง:\n📚 ส่งงาน\n📋 งานของฉัน\n🔗 ผูกบัญชี\n❓ ช่วยเหลือ'),
      liffButtonMsg_('เริ่มต้นส่งงาน', '📚 ส่งงาน', {})
    ]);
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  var text = String(ev.message.text || '').trim();
  var t = text.replace(/^[^\wก-๙]+/, '').toLowerCase();

  if (t === 'myid' || t === 'ไอดี') {
    return lineReply_(ev.replyToken, textMsg_('LINE userId ของคุณ:\n' + userId));
  }
  if (t.indexOf('ส่งงาน') === 0) {
    return lineReply_(ev.replyToken, liffButtonMsg_('📚 ส่งงาน\nเลือกงาน → สแกน QR นักเรียน → ยืนยัน', 'เปิดหน้าส่งงาน', {}));
  }
  if (t.indexOf('ผูกบัญชี') === 0) {
    return lineReply_(ev.replyToken, liffButtonMsg_('🔗 ผูกบัญชี LINE กับรหัสนักเรียน เพื่อรับการแจ้งเตือน', 'ผูกบัญชี', { mode: 'link' }));
  }
  if (t.indexOf('งานของฉัน') === 0 || t === 'สถานะ' || t.indexOf('งานค้าง') === 0) {
    return lineReply_(ev.replyToken, myStatusMessage_(userId));
  }

  // แบบ A: ผู้ใช้ส่งรหัส QR เข้ามาในแชท (เช่น STU-65001) → แสดงข้อมูล + ปุ่มยืนยันผ่าน LIFF
  var prefix = String(getSetting_('QR_STUDENT_PREFIX', 'STU-')).toUpperCase();
  if (text.toUpperCase().indexOf(prefix) === 0) {
    var s = getStudent_(parseStudentCode_(text));
    if (!s) return lineReply_(ev.replyToken, textMsg_('❌ ไม่พบรหัสนักเรียนนี้'));
    return lineReply_(ev.replyToken, liffButtonMsg_(
      'พบข้อมูลนักเรียน\nรหัส: ' + s.student_id + '\nชื่อ: ' + s.name + '\nห้อง: ' + className_(s),
      'เลือกงานและยืนยัน', { student: String(s.student_id) }));
  }

  return lineReply_(ev.replyToken, textMsg_(
    '❓ คำสั่งที่ใช้ได้\n\n📚 ส่งงาน — เปิดหน้าส่งงาน\n📋 งานของฉัน — ดูงานที่ยังไม่ส่ง\n🔗 ผูกบัญชี — ผูก LINE กับรหัสนักเรียน\n🆔 myid — ดู LINE userId'));
}

function myStatusMessage_(userId) {
  var s = findStudentByLineId_(userId);
  if (!s) {
    return liffButtonMsg_('ยังไม่ได้ผูกบัญชี LINE กับรหัสนักเรียน\nกรุณาผูกบัญชีก่อน', '🔗 ผูกบัญชี', { mode: 'link' });
  }
  var list = studentAssignmentStatus_(s);
  if (!list.length) return textMsg_('📋 ' + s.name + '\nยังไม่มีงานที่มอบหมาย');
  var lines = list.map(function (a) {
    var icon = a.submission_status === SUBMISSION_STATUS.NOT_SUBMITTED ? '❌' :
      a.submission_status === SUBMISSION_STATUS.REVISE ? '✏️' :
      a.submission_status === SUBMISSION_STATUS.PASSED ? '🏆' : '✅';
    return icon + ' ' + a.subject + ' — ' + a.assignment_name +
      '\n    ' + a.submission_status + (a.submitted_text ? ' (' + a.submitted_text + ')' : ' | กำหนดส่ง ' + a.due_text);
  });
  var pending = list.filter(function (a) { return a.submission_status === SUBMISSION_STATUS.NOT_SUBMITTED; }).length;
  return textMsg_('📋 งานของ ' + s.name + ' (' + className_(s) + ')\nค้างส่ง ' + pending + ' งาน\n\n' + lines.join('\n'));
}

// ---------------- Flex: ผลการส่งงาน ----------------

function submissionFlex_(r) {
  var row = function (label, value, color) {
    return {
      type: 'box', layout: 'baseline', spacing: 'sm', contents: [
        { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
        { type: 'text', text: String(value || '-'), size: 'sm', wrap: true, flex: 6, color: color || '#111111', weight: 'bold' }
      ]
    };
  };
  var header = r.code === 'RESUBMITTED' ? '🔄 บันทึกการส่งซ้ำสำเร็จ' : '✅ บันทึกการส่งงานสำเร็จ';
  var body = [
    row('รหัสนักเรียน', r.student.student_id),
    row('ชื่อ', r.student.name),
    row('ห้อง', r.student.class_name),
    row('วิชา', r.assignment.subject),
    row('งาน', r.assignment.assignment_name),
    row('วันที่', r.dateText),
    row('เวลา', r.timeText + ' น.'),
    row('สถานะ', SUBMISSION_STATUS.SUBMITTED + (r.isLate ? ' (ส่งช้า)' : ''), r.isLate ? '#e67e22' : '#06c755')
  ];
  if (r.attempt > 1) body.push(row('ครั้งที่', r.attempt));
  return {
    type: 'flex',
    altText: header + ' ' + r.assignment.assignment_name,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: r.isLate ? '#e67e22' : '#06c755', contents: [
          { type: 'text', text: header, color: '#ffffff', weight: 'bold', size: 'md' },
          { type: 'text', text: getSetting_('SCHOOL_NAME', ''), color: '#ffffffcc', size: 'xs' }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body }
    }
  };
}
