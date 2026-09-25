#!/usr/bin/env bash
# Deploy RatchaneeQR ขึ้น Google Apps Script (ต้อง clasp login ก่อน)
#
#   ./deploy.sh            อัปเดตทั้ง API และ Admin deployment (URL เดิม)
#   ./deploy.sh api        อัปเดตเฉพาะ API (LINE Webhook + LIFF)
#
# Apps Script อ่านโหมด Web app (execute as / access) จาก appsscript.json ตอนสร้าง version
# สคริปต์นี้จึงสลับ manifest ชั่วคราวเพื่อสร้าง Admin version แล้วคืนค่าเดิม
set -euo pipefail
cd "$(dirname "$0")/gas"

API_ID="AKfycbznYm-rlEeZIdFmfbTSPBKENNEkY5DGaub91nqyQLlg7sfkaKor1i3Sh_bQ5li0xq6IgA"
ADMIN_ID_FILE="../.admin-deployment-id"
STAMP="$(date '+%Y-%m-%d %H:%M')"

set_webapp() { # $1 = executeAs, $2 = access
  python3 - "$1" "$2" <<'EOF'
import json, sys
m = json.load(open('appsscript.json'))
m['webapp'] = {'executeAs': sys.argv[1], 'access': sys.argv[2]}
json.dump(m, open('appsscript.json', 'w'), indent=2, ensure_ascii=False)
open('appsscript.json', 'a').write('\n')
EOF
}
restore() { set_webapp USER_DEPLOYING ANYONE_ANONYMOUS; }
trap restore EXIT

if [ "${1:-all}" != "api" ]; then
  echo "▶ Admin deployment (execute as: ผู้ใช้ที่เข้าใช้, access: มีบัญชี Google)"
  set_webapp USER_ACCESSING ANYONE
  clasp push --force >/dev/null
  if [ -f "$ADMIN_ID_FILE" ]; then
    clasp create-deployment -i "$(cat "$ADMIN_ID_FILE")" --description "Admin $STAMP"
  else
    clasp create-deployment --description "Admin $STAMP" | tee /dev/stderr | grep -oE 'AKfyc[A-Za-z0-9_-]+' > "$ADMIN_ID_FILE"
  fi
fi

echo "▶ API deployment (execute as: เจ้าของ, access: ทุกคน)"
restore
clasp push --force >/dev/null
clasp create-deployment -i "$API_ID" --description "API $STAMP"

echo
echo "API   : https://script.google.com/macros/s/$API_ID/exec"
[ -f "$ADMIN_ID_FILE" ] && echo "Admin : https://script.google.com/macros/s/$(cat "$ADMIN_ID_FILE")/exec"
