# คู่มือการใช้งาน (PDF)

- ต้นฉบับ: `manual.html` + ภาพหน้าจอใน `shots/`
- ไฟล์ที่เผยแพร่: `liff/manual.pdf` (GitHub Pages → ปุ่ม "คู่มือการใช้งาน" ในหน้าตั้งค่า)

สร้าง PDF ใหม่หลังแก้ต้นฉบับ:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --virtual-time-budget=8000 --print-to-pdf=liff/manual.pdf "file://$PWD/docs/manual/manual.html"
```
