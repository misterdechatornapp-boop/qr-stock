// Builds setup-qr.html (git-ignored) from local-setup.json: a printable QR that configures a device in one scan.
// usage: node tools/make-setup-qr.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { u, k } = JSON.parse(fs.readFileSync(path.join(root, 'local-setup.json'), 'utf8'));
const payload = 'QRSTOCK-SETUP:' + JSON.stringify({ u, k });
const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR ตั้งค่า QR Stock</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;color:#17201e;background:#fff}#q{display:inline-block;padding:16px;border:1px solid #ddd;border-radius:12px}
.warn{color:#b45309;max-width:460px;margin:12px auto;font-size:14px}</style></head><body>
<h2>QR ตั้งค่า · QR Stock</h2>
<p>เปิด https://misterdechatornapp-boop.github.io/qr-stock/ บนมือถือ → หน้า <b>สแกน</b> → เปิดกล้อง → สแกน QR นี้</p>
<div id="q"></div>
<p class="warn">⚠ QR นี้มีรหัสเข้าใช้คลัง ใครสแกนได้ก็แก้ไขข้อมูลได้ เก็บไว้เฉพาะคนในทีม อย่าโพสต์สาธารณะ</p>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('q'),{text:${JSON.stringify(payload)},width:300,height:300,correctLevel:QRCode.CorrectLevel.M});</script>
</body></html>`;
fs.writeFileSync(path.join(root, 'setup-qr.html'), html);
console.log('wrote setup-qr.html');
