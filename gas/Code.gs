/**
 * QR Stock — backend (Google Apps Script, bound to the "QR Stock" spreadsheet)
 * Web app: execute as owner, access anyone. Every call (except init) must carry API_KEY.
 * API_KEY lives in Script Properties only — never in the repo.
 *
 * Two levels:
 *   Products — one row per product type (key: type_code = GTIN for GS1 codes)
 *   Items    — one row per stock unit (key: code = type|SN:serial, type|LOT:lot, or type)
 */
var VERSION = '1.4.0';

var SHEETS = {
  Products: ['type_code', 'ref', 'name', 'category', 'brand', 'note', 'image_id', 'thumb', 'created_at', 'updated_at'],
  Items: ['code', 'type_code', 'serial', 'lot', 'ref', 'mfg_date', 'exp_date', 'qty', 'unit', 'location', 'note', 'fields', 'format', 'raw_sample', 'created_at', 'updated_at', 'scan_count', 'last_scan'],
  Log: ['ts', 'action', 'code', 'raw', 'detail', 'device'],
  Config: ['key', 'value'],
  Images: ['image_id', 'seq', 'type_code', 'mime', 'data'] // photo base64 split into ≤45k-char chunks (cell limit 50k)
};
// columns that must stay text (barcodes lose leading zeros, dates get reinterpreted otherwise)
var TEXT_COLS = {
  Products: ['type_code', 'ref'],
  Items: ['code', 'type_code', 'serial', 'lot', 'ref', 'mfg_date', 'exp_date', 'fields', 'raw_sample'],
  Log: ['code', 'raw'],
  Config: ['key', 'value'],
  Images: ['image_id', 'type_code', 'data']
};
var CHUNK = 45000;
var MAX_IMAGE_CHARS = 600000; // ~450 KB jpeg

function doGet() {
  return json_({ ok: true, app: 'qr-stock', version: VERSION });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('API_KEY');

  if (req.action === 'init') {
    if (apiKey) return json_({ ok: false, error: 'already_initialized' });
    if (!req.key || String(req.key).length < 16) return json_({ ok: false, error: 'key_too_short' });
    props.setProperty('API_KEY', String(req.key));
    ensureSheets_();
    return json_({ ok: true, version: VERSION });
  }
  if (!apiKey || req.key !== apiKey) return json_({ ok: false, error: 'unauthorized' });

  try {
    if (props.getProperty('SCHEMA_OK') !== VERSION) ensureSheets_(); else schemaOk_ = true;
    switch (req.action) {
      case 'ping': return json_({ ok: true, version: VERSION, sheet: SpreadsheetApp.getActiveSpreadsheet().getUrl() });
      case 'list': return json_({ ok: true, items: read_('Items').rows, products: read_('Products').rows });
      case 'scan': return json_(withLock_(function () { return scan_(req); }));
      case 'saveItem': return json_(withLock_(function () { return saveItem_(req); }));
      case 'saveProduct': return json_(withLock_(function () { return { ok: true, product: upsertProduct_(req.product || {}, req.device) }; }));
      case 'removeItem': return json_(withLock_(function () { return removeItem_(req); }));
      case 'removeProduct': return json_(withLock_(function () { return removeProduct_(req); }));
      case 'uploadImage': return json_(withLock_(function () { return uploadImage_(req); }));
      case 'image': return json_(image_(req));
      case 'history': return json_({ ok: true, rows: history_(req.code, req.limit || 30) });
      case 'getRules': return json_({ ok: true, rules: getConfig_('rules_v2') || '' });
      case 'saveRules': return json_(withLock_(function () { setConfig_('rules_v2', req.rules || '[]'); log_('rules', '', '', 'อัปเดตกฎการอ่านค่า', req.device); return { ok: true }; }));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- actions ---------- */

function scan_(req) {
  var code = clean_(req.code);
  if (!code) return { ok: false, error: 'empty_code' };
  var hit = find_('Items', code);
  var item = null;
  if (hit) {
    var now = new Date();
    var c = colMap_('Items');
    var count = Number(hit.obj.scan_count || 0) + 1;
    hit.sheet.getRange(hit.idx + 2, c.scan_count + 1, 1, 2).setValues([[count, now]]); // scan_count, last_scan are adjacent
    item = hit.obj;
    item.scan_count = count;
    item.last_scan = now.toISOString();
  }
  var type = clean_(req.type_code || (item && item.type_code));
  var ph = type ? find_('Products', type) : null;
  var product = ph ? ph.obj : null;
  if (req.log !== false) log_('scan', code, req.raw, item ? 'พบในคลัง' : product ? 'รุ่นนี้มีแล้ว · ชิ้นใหม่' : 'ยังไม่ลงทะเบียน', req.device);
  return { ok: true, item: item, product: product };
}

function saveItem_(req) {
  var it = req.item || {};
  var code = clean_(it.code);
  var type = clean_(it.type_code);
  if (!code || !type) return { ok: false, error: 'empty_code' };
  var product = null;
  if (req.product) product = upsertProduct_(req.product, req.device);

  var hit = find_('Items', code);
  var idx = hit ? hit.idx : undefined;
  if (hit && req.mode === 'create') return { ok: false, error: 'duplicate_code', item: hit.obj };
  var cur = hit ? hit.obj : {};
  var now = new Date();
  var rec = {};
  SHEETS.Items.forEach(function (k) { rec[k] = it[k] !== undefined && it[k] !== null ? it[k] : (cur[k] !== undefined ? cur[k] : ''); });
  rec.code = code;
  rec.type_code = type;
  rec.qty = rec.qty === '' ? '' : Number(rec.qty);
  if (typeof rec.fields === 'object') rec.fields = JSON.stringify(rec.fields);
  rec.created_at = cur.created_at ? new Date(cur.created_at) : now;
  rec.updated_at = now;
  rec.scan_count = cur.scan_count || 0;
  rec.last_scan = cur.last_scan ? new Date(cur.last_scan) : '';
  writeRow_('Items', idx, rec);

  var detail = idx !== undefined ? 'แก้ไขข้อมูล' : 'ลงทะเบียนใหม่';
  if (it.qty !== undefined && String(it.qty) !== String(cur.qty === undefined ? '' : cur.qty)) detail += ' · จำนวน ' + (cur.qty === undefined || cur.qty === '' ? '-' : cur.qty) + ' → ' + rec.qty;
  if (it.note && it.note !== cur.note) detail += ' · note: ' + String(it.note).slice(0, 200);
  if (idx === undefined && it.format === 'OCR') detail += ' · ค่าจากการอ่านตัวหนังสือบนฉลาก (OCR) ผู้ใช้ยืนยันแล้ว';
  log_(idx !== undefined ? 'update' : 'create', code, it.raw_sample || '', detail, req.device);
  if (!product) {
    var ph = find_('Products', type);
    product = ph ? ph.obj : null;
  }
  return { ok: true, item: serialize_(rec), product: product };
}

function upsertProduct_(pr, device) {
  var type = clean_(pr.type_code);
  if (!type) throw new Error('empty_code');
  var hit = find_('Products', type);
  var idx = hit ? hit.idx : undefined;
  var cur = hit ? hit.obj : {};
  var now = new Date();
  var rec = {};
  SHEETS.Products.forEach(function (k) { rec[k] = pr[k] !== undefined && pr[k] !== null ? pr[k] : (cur[k] !== undefined ? cur[k] : ''); });
  rec.type_code = type;
  rec.created_at = cur.created_at ? new Date(cur.created_at) : now;
  rec.updated_at = now;
  writeRow_('Products', idx, rec);
  log_(idx !== undefined ? 'product_update' : 'product_create', type, '', (idx !== undefined ? 'แก้ไขประเภท ' : 'สร้างประเภท ') + (rec.name || ''), device);
  return serialize_(rec);
}

function removeItem_(req) {
  var code = clean_(req.code);
  var hit = find_('Items', code);
  if (!hit) return { ok: false, error: 'not_found' };
  hit.sheet.deleteRow(hit.idx + 2);
  log_('delete', code, '', 'ลบออกจากคลัง', req.device);
  return { ok: true };
}

function removeProduct_(req) {
  var type = clean_(req.type_code);
  if (find_('Items', type, 'type_code')) return { ok: false, error: 'has_items' };
  var hit = find_('Products', type);
  if (!hit) return { ok: false, error: 'not_found' };
  deleteImage_(hit.obj.image_id);
  hit.sheet.deleteRow(hit.idx + 2);
  log_('product_delete', type, '', 'ลบประเภท', req.device);
  return { ok: true };
}

function uploadImage_(req) {
  var type = clean_(req.type_code);
  var hit = find_('Products', type);
  if (!hit) return { ok: false, error: 'not_found' };
  var b64 = String(req.data || '');
  if (!b64 || b64.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(b64)) return { ok: false, error: 'bad_image' };
  var thumb = String(req.thumb || '');
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb) || thumb.length > CHUNK) thumb = '';
  var id = Utilities.getUuid();
  var rows = [];
  for (var i = 0, seq = 1; i < b64.length; i += CHUNK, seq++) rows.push([id, seq, type, 'image/jpeg', b64.slice(i, i + CHUNK)]);
  appendRows_('Images', rows);
  deleteImage_(hit.obj.image_id);
  var c = colMap_('Products');
  hit.sheet.getRange(hit.idx + 2, c.image_id + 1, 1, 2).setValues([[id, thumb]]); // image_id, thumb are adjacent
  hit.sheet.getRange(hit.idx + 2, c.updated_at + 1).setValue(new Date());
  log_('product_image', type, '', 'อัปโหลดรูป', req.device);
  return { ok: true, image_id: id, thumb: thumb };
}

function image_(req) {
  var id = clean_(req.id);
  if (!id) return { ok: false, error: 'not_found' };
  var parts = imageRows_(id);
  if (!parts.length) return { ok: false, error: 'not_found' };
  parts.sort(function (a, b) { return a.seq - b.seq; });
  return { ok: true, mime: parts[0].mime, data: parts.map(function (p) { return p.data; }).join('') };
}

// -> [{row, seq, mime, data}] for one image id
function imageRows_(id) {
  var sh = sheet_('Images');
  var n = sh.getLastRow() - 1;
  if (n < 1 || !id) return [];
  var out = [];
  sh.getRange(2, 1, n, SHEETS.Images.length).getValues().forEach(function (r, i) {
    if (String(r[0]) === id) out.push({ row: i + 2, seq: Number(r[1]), mime: r[3], data: String(r[4]) });
  });
  return out;
}

function deleteImage_(id) {
  if (!id) return;
  var sh = sheet_('Images');
  imageRows_(id).map(function (p) { return p.row; }).sort(function (a, b) { return b - a; })
    .forEach(function (row) { sh.deleteRow(row); });
}

function history_(code, limit) {
  code = clean_(code);
  var sh = sheet_('Log');
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, 1, n, SHEETS.Log.length).getValues();
  var out = [];
  for (var i = vals.length - 1; i >= 0 && out.length < limit; i--) {
    if (!code || String(vals[i][2]) === code) out.push(rowObj_(SHEETS.Log, vals[i]));
  }
  return out;
}

/* ---------- sheet helpers ---------- */

function ensureSheets_() {
  schemaOk_ = false;
  Object.keys(SHEETS).forEach(function (name) { sheet_(name); });
  PropertiesService.getScriptProperties().setProperty('SCHEMA_OK', VERSION);
  schemaOk_ = true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

var sheetCache_ = {};
var schemaOk_ = null;
function sheet_(name) {
  if (sheetCache_[name]) return sheetCache_[name];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  // header check costs one read per sheet per request — skip it once this VERSION has verified the layout
  if (schemaOk_ === null) schemaOk_ = PropertiesService.getScriptProperties().getProperty('SCHEMA_OK') === VERSION;
  if (sh && schemaOk_) return (sheetCache_[name] = sh);
  var cols = SHEETS[name];
  if (sh) {
    var head = sh.getRange(1, 1, 1, sh.getLastColumn() || 1).getValues()[0].slice(0, cols.length).join('|');
    if (head !== cols.join('|')) {
      if (sh.getLastRow() <= 1) { sh.clear(); formatSheet_(sh, name); }
      else { // older layout with data: keep it aside, start a fresh sheet
        sh.setName(name + '_old_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmm'));
        sh = null;
      }
    }
  }
  if (!sh) { sh = ss.insertSheet(name); formatSheet_(sh, name); }
  sheetCache_[name] = sh;
  return sh;
}

function formatSheet_(sh, name) {
  sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
  sh.setFrozenRows(1);
  (TEXT_COLS[name] || []).forEach(function (k) {
    sh.getRange(1, SHEETS[name].indexOf(k) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

// append one row, growing the grid (with text formatting) when it is full
function appendRow_(name, row) {
  var sh = sheet_(name);
  var next = sh.getLastRow() + 1;
  if (next > sh.getMaxRows()) {
    sh.insertRowsAfter(sh.getMaxRows(), 500);
    (TEXT_COLS[name] || []).forEach(function (k) {
      sh.getRange(next, SHEETS[name].indexOf(k) + 1, 500, 1).setNumberFormat('@');
    });
  }
  sh.getRange(next, 1, 1, row.length).setValues([row]);
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = sheet_(name);
  var next = sh.getLastRow() + 1;
  var need = next + rows.length - 1 - sh.getMaxRows();
  if (need > 0) {
    var add = Math.max(need, 500);
    var from = sh.getMaxRows() + 1;
    sh.insertRowsAfter(sh.getMaxRows(), add);
    (TEXT_COLS[name] || []).forEach(function (k) {
      sh.getRange(from, SHEETS[name].indexOf(k) + 1, add, 1).setNumberFormat('@');
    });
  }
  sh.getRange(next, 1, rows.length, rows[0].length).setValues(rows);
}

function writeRow_(name, idx, rec) {
  var row = SHEETS[name].map(function (k) { return rec[k]; });
  if (idx !== undefined) sheet_(name).getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else appendRow_(name, row);
}

function colMap_(name) {
  var m = {};
  SHEETS[name].forEach(function (k, i) { m[k] = i; });
  return m;
}

// -> {sheet, rows:[obj], index:{key: rowIndex}}  (key = first column)
function read_(name) {
  var sh = sheet_(name);
  var n = sh.getLastRow() - 1;
  var rows = [];
  var index = {};
  if (n > 0) {
    sh.getRange(2, 1, n, SHEETS[name].length).getValues().forEach(function (r, i) {
      var o = rowObj_(SHEETS[name], r);
      rows.push(o);
      var key = o[SHEETS[name][0]];
      if (key) index[key] = i;
    });
  }
  return { sheet: sh, rows: rows, index: index };
}

// one row by exact key (default: first column) without reading the whole sheet
// -> {sheet, idx (0-based data row), obj} or null
function find_(name, key, col) {
  key = clean_(key);
  if (!key) return null;
  var sh = sheet_(name);
  var n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var ci = col ? SHEETS[name].indexOf(col) : 0;
  var cell = sh.getRange(2, ci + 1, n, 1).createTextFinder(key).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  var idx = cell.getRow() - 2;
  var vals = sh.getRange(idx + 2, 1, 1, SHEETS[name].length).getValues()[0];
  return { sheet: sh, idx: idx, obj: rowObj_(SHEETS[name], vals) };
}

function rowObj_(cols, r) {
  var o = {};
  cols.forEach(function (k, i) {
    var v = r[i];
    o[k] = v instanceof Date ? v.toISOString() : ((TEXT_COLS_ALL_[k]) ? String(v) : v);
  });
  return o;
}
var TEXT_COLS_ALL_ = { code: 1, type_code: 1, serial: 1, lot: 1, ref: 1, mfg_date: 1, exp_date: 1 };

function serialize_(rec) {
  var o = {};
  Object.keys(rec).forEach(function (k) { o[k] = rec[k] instanceof Date ? rec[k].toISOString() : rec[k]; });
  return o;
}

function log_(action, code, raw, detail, device) {
  appendRow_('Log', [new Date(), action, String(code || ''), String(raw || '').slice(0, 2000), detail || '', String(device || '').slice(0, 60)]);
}

function getConfig_(key) {
  var d = read_('Config');
  return d.index[key] !== undefined ? String(d.rows[d.index[key]].value) : null;
}

function setConfig_(key, value) {
  var d = read_('Config');
  writeRow_('Config', d.index[key], { key: key, value: String(value) });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function clean_(s) { return String(s === undefined || s === null ? '' : s).trim(); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
