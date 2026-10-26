/**
 * QR Stock — backend (Google Apps Script, bound to the "QR Stock" spreadsheet)
 * Web app: execute as owner, access anyone. Every call (except init/ping) must carry API_KEY.
 * API_KEY lives in Script Properties only — never in the repo.
 */
var VERSION = '1.0.0';

var SHEETS = {
  Items: ['code', 'name', 'note', 'qty', 'unit', 'location', 'format', 'raw_sample', 'created_at', 'updated_at', 'scan_count', 'last_scan'],
  Log: ['ts', 'action', 'code', 'raw', 'detail', 'device'],
  Config: ['key', 'value']
};
// columns that must stay text (barcodes lose leading zeros otherwise)
var TEXT_COLS = { Items: ['code', 'raw_sample'], Log: ['code', 'raw'], Config: ['key', 'value'] };

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
    switch (req.action) {
      case 'ping': return json_({ ok: true, version: VERSION, sheet: SpreadsheetApp.getActiveSpreadsheet().getUrl() });
      case 'list': return json_({ ok: true, items: readItems_().items });
      case 'scan': return json_(withLock_(function () { return scan_(req); }));
      case 'save': return json_(withLock_(function () { return save_(req); }));
      case 'remove': return json_(withLock_(function () { return remove_(req); }));
      case 'history': return json_({ ok: true, rows: history_(req.code, req.limit || 30) });
      case 'getRules': return json_({ ok: true, rules: getConfig_('rules') || '[]' });
      case 'saveRules': return json_(withLock_(function () { setConfig_('rules', req.rules || '[]'); log_('rules', '', '', 'อัปเดตกฎการอ่านค่า', req.device); return { ok: true }; }));
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
  var data = readItems_();
  var idx = data.index[code];
  var now = new Date();
  var item = null;
  if (idx !== undefined) {
    var row = idx + 2;
    var sh = data.sheet;
    var c = colMap_('Items');
    var count = Number(data.items[idx].scan_count || 0) + 1;
    sh.getRange(row, c.scan_count + 1).setValue(count);
    sh.getRange(row, c.last_scan + 1).setValue(now);
    item = data.items[idx];
    item.scan_count = count;
    item.last_scan = now.toISOString();
  }
  if (req.log !== false) log_('scan', code, req.raw, item ? 'พบในคลัง' : 'ยังไม่ลงทะเบียน', req.device);
  return { ok: true, item: item };
}

function save_(req) {
  var it = req.item || {};
  var code = clean_(it.code);
  if (!code) return { ok: false, error: 'empty_code' };
  var orig = clean_(req.originalCode || '');
  var data = readItems_();
  var sh = data.sheet;
  var now = new Date();

  if (orig && orig !== code && data.index[code] !== undefined) return { ok: false, error: 'duplicate_code' };
  var idx = data.index[orig || code];
  if (!orig && idx !== undefined && req.mode === 'create') return { ok: false, error: 'duplicate_code' };

  var cur = idx !== undefined ? data.items[idx] : {};
  var rec = {
    code: code,
    name: str_(it.name, cur.name),
    note: str_(it.note, cur.note),
    qty: it.qty === '' || it.qty === undefined || it.qty === null ? (cur.qty === undefined ? '' : cur.qty) : Number(it.qty),
    unit: str_(it.unit, cur.unit),
    location: str_(it.location, cur.location),
    format: str_(it.format, cur.format),
    raw_sample: str_(it.raw_sample, cur.raw_sample),
    created_at: cur.created_at ? new Date(cur.created_at) : now,
    updated_at: now,
    scan_count: cur.scan_count || 0,
    last_scan: cur.last_scan ? new Date(cur.last_scan) : ''
  };
  var values = [SHEETS.Items.map(function (k) { return rec[k]; })];
  if (idx !== undefined) {
    sh.getRange(idx + 2, 1, 1, SHEETS.Items.length).setValues(values);
  } else {
    appendRow_('Items', values[0]);
  }
  var detail = idx !== undefined ? (orig && orig !== code ? 'เปลี่ยนรหัสจาก ' + orig : 'แก้ไขข้อมูล') : 'ลงทะเบียนใหม่';
  if (it.note && it.note !== cur.note) detail += ' · note: ' + String(it.note).slice(0, 200);
  log_(idx !== undefined ? 'update' : 'create', code, it.raw_sample || '', detail, req.device);
  return { ok: true, item: serialize_(rec) };
}

function remove_(req) {
  var code = clean_(req.code);
  var data = readItems_();
  var idx = data.index[code];
  if (idx === undefined) return { ok: false, error: 'not_found' };
  data.sheet.deleteRow(idx + 2);
  log_('delete', code, '', 'ลบออกจากคลัง', req.device);
  return { ok: true };
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
  Object.keys(SHEETS).forEach(function (name) { sheet_(name); });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    (TEXT_COLS[name] || []).forEach(function (k) {
      sh.getRange(1, SHEETS[name].indexOf(k) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
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

function colMap_(name) {
  var m = {};
  SHEETS[name].forEach(function (k, i) { m[k] = i; });
  return m;
}

function readItems_() {
  var sh = sheet_('Items');
  var n = sh.getLastRow() - 1;
  var items = [];
  var index = {};
  if (n > 0) {
    var vals = sh.getRange(2, 1, n, SHEETS.Items.length).getValues();
    vals.forEach(function (r, i) {
      var o = rowObj_(SHEETS.Items, r);
      items.push(o);
      if (o.code) index[o.code] = i;
    });
  }
  return { sheet: sh, items: items, index: index };
}

function rowObj_(cols, r) {
  var o = {};
  cols.forEach(function (k, i) {
    var v = r[i];
    o[k] = v instanceof Date ? v.toISOString() : (k === 'code' ? String(v) : v);
  });
  return o;
}

function serialize_(rec) {
  var o = {};
  Object.keys(rec).forEach(function (k) { o[k] = rec[k] instanceof Date ? rec[k].toISOString() : rec[k]; });
  return o;
}

function log_(action, code, raw, detail, device) {
  appendRow_('Log', [new Date(), action, String(code || ''), String(raw || '').slice(0, 2000), detail || '', String(device || '').slice(0, 60)]);
}

function getConfig_(key) {
  var sh = sheet_('Config');
  var n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var vals = sh.getRange(2, 1, n, 2).getValues();
  for (var i = 0; i < vals.length; i++) if (vals[i][0] === key) return String(vals[i][1]);
  return null;
}

function setConfig_(key, value) {
  var sh = sheet_('Config');
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    var keys = sh.getRange(2, 1, n, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i][0] === key) { sh.getRange(i + 2, 2).setValue(String(value)); return; }
    }
  }
  appendRow_('Config', [key, String(value)]);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function clean_(s) { return String(s === undefined || s === null ? '' : s).trim(); }
function str_(v, fallback) { return v === undefined || v === null ? (fallback === undefined ? '' : fallback) : String(v); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
