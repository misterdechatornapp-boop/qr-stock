// Local preview server: node serve.js  →  http://localhost:8797
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8797;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.txt': 'text/plain', '.gz': 'application/gzip', '.jpg': 'image/jpeg', '.png': 'image/png' };

http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, p === '/' ? 'index.html' : p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('QR Stock preview on http://localhost:' + PORT));
