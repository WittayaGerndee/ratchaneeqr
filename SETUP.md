# RatchaneeQR — คู่มือติดตั้ง

ระบบส่งงานนักเรียนด้วย QR Code ผ่าน LINE OA + LIFF + Google Apps Script + Google Sheets + Google Drive
(ตามแนวคิดใน [readme.md](readme.md))

## โครงสร้างโปรเจกต์

```
gas/                  ← โค้ด Google Apps Script (Backend + หน้า Admin)
  Config.gs           โครงสร้าง Sheet 7 แผ่น, ค่า Settings
  Setup.gs            setup() ติดตั้งครั้งแรก, seedSampleData(), Trigger
  Main.gs             doGet (Admin) / doPost (LINE Webhook + LIFF API)
  Api.gs              API สำหรับ LIFF (ตรวจ LINE ID Token ทุกคำขอ)
  Submission.gs       ค้นนักเรียน/งาน, บันทึกการส่ง, กันส่งซ้ำ, ผูกบัญชี
  Line.gs             LINE Messaging API, Webhook, Flex Message
  Notify.gs           แจ้งเตือนหลังส่ง / ก่อนครบกำหนด / สรุปรายวัน
  Qr.gs               สร้าง QR PNG ลง Drive
  Drive.gs            โฟลเดอร์ School_Submission/ปี/ชั้น/วิชา/งาน
  Admin.gs            ฟังก์ชันหน้า Admin (สิทธิ์ครู/admin)
  AdminPage.html, AdminJs.html, AdminCss.html, Denied.html
liff/                 ← หน้า LIFF (ไฟล์ static ต้องโฮสต์บน HTTPS)
  index.html, config.js
test/run-tests.js     ← ทดสอบ logic ด้วย Node: node test/run-tests.js
```

## ขั้นตอนการทำงาน

1. นักเรียน/ครูเปิด LIFF จาก LINE OA (Rich menu "📚 ส่งงาน") **หรือ** สแกน QR งานที่ติดหน้าห้องด้วยกล้อง
2. เลือกงาน (หรือสแกน QR งาน)
3. สแกน QR นักเรียน (`STU-65001`) → ระบบแสดงรหัส ชื่อ ห้อง งาน และเวลา
4. กด **✅ ยืนยันส่งงาน** (แนบไฟล์ได้) → บันทึกลง Sheet `Submissions` → ส่ง Flex Message ยืนยันทาง LINE
5. ถ้านักเรียนคนนี้ส่งงานนี้แล้ว → แสดง ⚠️ พร้อมเวลาที่ส่ง และปุ่ม 🔄 ส่งอีกครั้ง (เฉพาะงานที่ตั้ง `allow_resubmit = TRUE` หรือผู้สแกนเป็นครู)

สถานะงาน: `ยังไม่ส่ง → ส่งแล้ว → ครูตรวจแล้ว → ผ่าน / แก้ไข` (ครูเปลี่ยนสถานะในหน้า Admin และแจ้งผลนักเรียนทาง LINE ได้)

---

## 1. ติดตั้ง Apps Script + Google Sheet

1. สร้าง Google Sheet ใหม่ → เมนู **ส่วนขยาย → Apps Script**
2. คัดลอกไฟล์ทั้งหมดใน `gas/` ไปใส่ (ชื่อไฟล์ต้องตรงกัน, ไฟล์ `.html` สร้างเป็น HTML)
   หรือใช้ clasp:
   ```bash
   cd gas && cp .clasp.json.example .clasp.json   # แก้ scriptId
   clasp push
   ```
3. ในหน้า Apps Script เลือกฟังก์ชัน `setup` → **Run** → อนุญาตสิทธิ์
   - สร้าง Sheet: Students, Classes, Assignments, Submissions, Teachers, Settings, Logs
   - สร้างโฟลเดอร์ `School_Submission` ใน Drive
   - เพิ่มบัญชีของคุณเป็น admin ใน `Teachers`
   - ติดตั้ง Trigger แจ้งเตือน (ทุกชั่วโมง) และสรุปรายวัน (18:00)
4. (ไม่บังคับ) Run `seedSampleData` เพื่อใส่ข้อมูลตัวอย่าง

## 2. LINE Official Account (Messaging API)

1. [LINE Developers Console](https://developers.line.biz/console/) → สร้าง Provider → **Messaging API channel**
2. แท็บ Messaging API → Issue **Channel access token (long-lived)**
3. Apps Script → ⚙️ Project Settings → **Script Properties** → เพิ่ม
   `LINE_CHANNEL_ACCESS_TOKEN` = token ที่ได้
   (เก็บที่นี่แทน Sheet เพราะครูที่แก้ Sheet ได้จะไม่เห็น Token)

## 3. Deploy Web App (2 ตัว)

Apps Script → **Deploy → New deployment → Web app**

| Deployment | Execute as | Who has access | ใช้สำหรับ |
|---|---|---|---|
| **API** | Me | Anyone | LINE Webhook + LIFF API |
| **Admin** | User accessing the web app | Anyone with Google account | หน้า Admin ของครู |

- นำ URL ของ **API** (`.../exec`) ไปใส่ใน LINE Developers → Messaging API → **Webhook URL** → เปิด **Use webhook**
  และปิด Auto-reply ใน LINE OA Manager
- หน้า **Admin** ใช้สิทธิ์ของครูแต่ละคน จึงต้อง **แชร์ Google Sheet และโฟลเดอร์ School_Submission ให้ครู (Editor)**
  และเพิ่มอีเมลครูใน Sheet `Teachers` (role = `teacher` หรือ `admin`)
- แก้โค้ดแล้ว: Deploy → Manage deployments → ✏️ → Version: **New version** (URL เดิมใช้ต่อได้)

## 4. LIFF

1. LINE Developers → Provider เดิม → สร้าง **LINE Login channel**
2. แท็บ LIFF → Add
   - Size: **Full**
   - Endpoint URL: URL ที่โฮสต์โฟลเดอร์ `liff/` (ต้องเป็น HTTPS เช่น GitHub Pages, Netlify, Firebase Hosting)
   - Scopes: ✅ `openid` ✅ `profile`
   - ✅ **Scan QR**
3. แก้ `liff/config.js`
   ```js
   window.APP_CONFIG = { LIFF_ID: '2001234567-AbCdEfGh', API_URL: 'https://script.google.com/macros/s/xxxx/exec' };
   ```
4. ใน Sheet `Settings` กรอก `LIFF_ID` และ `LINE_LOGIN_CHANNEL_ID` (Channel ID ของ LINE Login channel — ใช้ตรวจ ID Token)
5. ลิงก์ LINE Login channel กับ OA: LINE Login channel → Basic settings → **Linked OA** (เพื่อให้ Add friend อัตโนมัติ)

## 5. Rich menu (LINE OA Manager)

| ปุ่ม | Action |
|---|---|
| 📚 ส่งงาน | Link: `https://liff.line.me/<LIFF_ID>` |
| 📋 งานของฉัน | Text: `งานของฉัน` |
| 🔗 ผูกบัญชี | Link: `https://liff.line.me/<LIFF_ID>?mode=link` |

คำสั่งในแชท: `ส่งงาน`, `งานของฉัน`, `ผูกบัญชี`, `myid` (ดู LINE userId), หรือพิมพ์ `STU-65001`

## 6. ตั้งค่าครู / ผู้ดูแล

- ครูพิมพ์ `myid` ใน LINE OA → คัดลอก userId ไปใส่คอลัมน์ `line_user_id` ใน `Teachers`
  → ครูพิมพ์รหัสนักเรียนเองได้ (กรณีบัตรหาย) และส่งซ้ำแทนนักเรียนได้
- ใส่ userId ของผู้ดูแลใน `Settings.ADMIN_LINE_ID` เพื่อรับสรุปรายวัน

## 7. พิมพ์ QR

หน้า Admin → **QR Code**
- **บัตร QR นักเรียน**: เลือกห้อง → 🖨️ พิมพ์ / บันทึก PDF (4 ใบต่อแถว)
- **โปสเตอร์ QR งาน**: QR เป็นลิงก์ LIFF พร้อม `?task=HW001` → สแกนด้วยกล้องมือถือแล้วเปิดหน้าส่งงานที่เลือกงานไว้แล้ว
- 💾 บันทึก PNG ลง Drive → `School_Submission/QR Codes/` (`QR_65001.png`, `TASK_HW001.png`)

QR นักเรียนเก็บเฉพาะรหัส (`STU-65001`) ไม่มีชื่อหรือ Token — เปลี่ยนชื่อหรือห้องได้โดยไม่ต้องพิมพ์ QR ใหม่

---

## Settings ที่สำคัญ

| Key | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `REQUIRE_ID_TOKEN` | TRUE | ตรวจ LINE ID Token (ตั้ง FALSE เฉพาะตอนทดสอบ) |
| `ALLOW_MANUAL_ENTRY` | FALSE | ให้นักเรียนพิมพ์รหัสแทนการสแกน (ครูพิมพ์ได้เสมอ) |
| `ALLOW_LATE_SUBMISSION` | TRUE | ส่งหลังกำหนดได้ แต่ถูกทำเครื่องหมาย "ส่งช้า" |
| `NOTIFY_ON_SUBMIT` | TRUE | Push ข้อความยืนยันหลังส่งงาน |
| `REMINDER_HOURS_BEFORE` | 24 | เตือนก่อนครบกำหนดกี่ชั่วโมง (0 = ปิด) |
| `MAX_FILE_MB` | 10 | ขนาดไฟล์แนบสูงสุด |

คอลัมน์ `class_target` ในงาน: `ALL`, `ม.5` (ทั้งระดับ), `ม.5/1` หรือหลายห้องคั่นด้วย `,`

## โหมดทดสอบ (ไม่ใช้ LINE)

1. ตั้ง `Settings.REQUIRE_ID_TOKEN = FALSE`
2. `liff/config.js` ปล่อย `LIFF_ID` ว่าง ใส่เฉพาะ `API_URL`
3. เปิด `liff/index.html` ผ่าน local web server → สแกนด้วยกล้องเว็บ (html5-qrcode) หรือพิมพ์รหัส (ถ้าเปิด `ALLOW_MANUAL_ENTRY`)

**อย่าลืมตั้งกลับเป็น TRUE ก่อนใช้งานจริง**

## ข้อจำกัดที่ควรรู้

- **Apps Script อ่าน HTTP header ไม่ได้** จึงตรวจ `X-Line-Signature` ของ Webhook ไม่ได้ ระบบจึงให้ Webhook ทำแค่ตอบกลับหรือแสดงข้อมูล
  ส่วนการบันทึกการส่งงานทุกครั้งต้องผ่าน LIFF ซึ่งตรวจ ID Token
- **โควตาข้อความ LINE**: Push, Multicast และข้อความแจ้งเตือนนับโควตาของแพ็กเกจ OA ส่วน Reply ไม่นับ
  ถ้าโควตาไม่พอ ให้ปิด `NOTIFY_ON_SUBMIT` (หน้า LIFF ยังแสดงผลการส่งตามปกติ)
- โควตา Apps Script: ทำงานได้ครั้งละไม่เกิน 6 นาที และ UrlFetch ต่อวันมีจำกัด ระบบจึงสร้าง QR ลง Drive เป็นชุด (กดซ้ำเพื่อทำต่อ)
- Google Sheets เหมาะกับข้อมูลระดับหลักหมื่นแถว ถ้าใช้หลายปีการศึกษา ควรย้าย `Submissions` ปีเก่าไปเก็บที่ไฟล์อื่น
- Dashboard ในหน้า Admin ใช้งานได้ทันที ถ้าต้องการกราฟเพิ่ม ให้เชื่อม Sheet กับ Looker Studio
