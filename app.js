/* QR Stock — UI */
(function () {
  'use strict';
  var APP_VERSION = '1.0.0';
  var SETUP_PREFIX = 'QRSTOCK-SETUP:';
  var R = window.QRRules;

  /* ---------- tiny helpers ---------- */
  var $ = function (s, el) { return (el || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem('qrs.' + k)); localStorage.setItem('qrs.' + k, JSON.stringify(v)); } catch (e) { return null; } }
  var TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function fmtDate(iso, withTime) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var s = d.getDate() + ' ' + TH_MONTHS[d.getMonth()] + ' ' + (d.getFullYear() + 543);
    if (withTime !== false) s += ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return s;
  }
  var toastTimer;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 4200 : 2400);
  }
  async function busy(btn, fn) {
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try { return await fn(); } finally { if (btn) { btn.classList.remove('loading'); btn.disabled = false; } }
  }

  /* ---------- state ---------- */
  var cfg = store('cfg') || { url: '', key: '', device: '' };
  var opts = store('opts') || { beep: true, autoCam: false };
  var items = store('items') || [];
  var rules = store('rules') || R.defaultRules();
  var rulesDirty = false;
  var lastRaw = null;
  var current = null; // {raw, format, code, rule, info, item, status}

  function indexItems() { var m = {}; items.forEach(function (it) { m[it.code] = it; }); return m; }
  var byCode = indexItems();
  function setItems(list) { items = list; byCode = indexItems(); store('items', items); renderStock(); }
  function putItem(it) {
    var i = items.findIndex(function (x) { return x.code === it.code; });
    if (i >= 0) items[i] = it; else items.push(it);
    setItems(items);
  }

  /* ---------- server ---------- */
  var ERR_TH = {
    unauthorized: 'รหัสเข้าใช้ไม่ถูกต้อง', duplicate_code: 'รหัสนี้มีอยู่ในคลังแล้ว', not_found: 'ไม่พบรายการนี้',
    empty_code: 'ยังไม่มีรหัสสินค้า', no_config: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ (ไปที่ ตั้งค่า)', network: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'
  };
  function errText(e) { var m = (e && e.message) || String(e); return ERR_TH[m] || m; }

  async function api(action, payload) {
    if (!cfg.url || !cfg.key) throw new Error('no_config');
    var body = Object.assign({ action: action, key: cfg.key, device: cfg.device || '' }, payload || {});
    var res;
    try {
      // text/plain keeps this a "simple" request → no CORS preflight (Apps Script can't answer one)
      res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
    } catch (e) { setConn('bad'); throw new Error('network'); }
    var data;
    try { data = await res.json(); } catch (e) { setConn('bad'); throw new Error('network'); }
    if (!data.ok) { if (data.error === 'unauthorized') setConn('bad'); throw new Error(data.error || 'error'); }
    setConn('ok');
    return data;
  }

  function setConn(state) {
    var b = $('#connBadge');
    b.classList.remove('ok', 'bad');
    if (state) b.classList.add(state);
    $('#connText').textContent = state === 'ok' ? 'เชื่อมต่อแล้ว' : state === 'bad' ? 'เชื่อมต่อไม่ได้' : 'ยังไม่เชื่อมต่อ';
  }

  async function syncAll(silent) {
    if (!cfg.url) { setConn(null); return; }
    try {
      var r = await Promise.all([api('list'), api('getRules')]);
      setItems(r[0].items || []);
      var srvRules = JSON.parse(r[1].rules || '[]');
      if (srvRules.length && !rulesDirty) { rules = srvRules; store('rules', rules); renderRules(); }
      if (!silent) toast('โหลดข้อมูลล่าสุดแล้ว');
    } catch (e) { if (!silent) toast(errText(e), true); }
  }

  /* ---------- navigation ---------- */
  function go(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === view); });
    if (view !== 'scan') stopCam();
    else if (opts.autoCam && !camOn) startCam();
    if (view === 'rules') renderRuleTest();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-go]');
    if (b) { e.preventDefault(); go(b.dataset.go); }
  });

  /* ---------- camera ---------- */
  var scanner = null, camOn = false, paused = false;
  function getScanner() {
    if (!scanner) {
      if (!window.Html5Qrcode) { toast('โหลดตัวสแกนไม่สำเร็จ ตรวจอินเทอร์เน็ต', true); return null; }
      scanner = new Html5Qrcode('reader', { verbose: false, useBarCodeDetectorIfSupported: true });
    }
    return scanner;
  }
  async function startCam() {
    var s = getScanner(); if (!s) return;
    var btn = $('#btnCam');
    await busy(btn, async function () {
      try {
        await s.start({ facingMode: 'environment' }, {
          fps: 12,
          qrbox: function (w, h) { return { width: Math.floor(Math.min(w * 0.86, 420)), height: Math.floor(Math.min(h * 0.62, 260)) }; }
        }, onCamDecode, function () {});
        camOn = true; paused = false;
        $('#scannerIdle').hidden = true;
      } catch (e) {
        toast('เปิดกล้องไม่ได้: ' + (e && e.message ? e.message : e), true);
      }
    });
    btn.textContent = camOn ? 'ปิดกล้อง' : 'เปิดกล้อง';
  }
  async function stopCam() {
    if (!scanner || !camOn) return;
    try { await scanner.stop(); } catch (e) { /* already stopped */ }
    camOn = false; paused = false;
    $('#scannerIdle').hidden = false;
    $('#btnCam').textContent = 'เปิดกล้อง';
  }
  function resumeCam() {
    if (scanner && camOn && paused) { try { scanner.resume(); } catch (e) { /* ignore */ } paused = false; }
  }
  function onCamDecode(text, result) {
    if (paused) return;
    var fmt = result && result.result && result.result.format ? result.result.format.formatName : '';
    try { scanner.pause(true); paused = true; } catch (e) { /* ignore */ }
    handleRaw(text, fmt);
  }
  $('#btnCam').addEventListener('click', function () { camOn ? stopCam() : startCam(); });

  $('#fileImg').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    var s = getScanner(); if (!s) return;
    if (camOn) await stopCam();
    try {
      var r = s.scanFileV2 ? await s.scanFileV2(f, false) : { decodedText: await s.scanFile(f, false) };
      var fmt = r.result && r.result.format ? r.result.format.formatName : '';
      handleRaw(r.decodedText, fmt);
    } catch (err) {
      toast('ไม่พบ QR / บาร์โค้ดในรูปนี้', true);
    }
  });

  $('#manualForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#manualInput').value;
    if (!v.trim()) return;
    $('#manualInput').value = '';
    handleRaw(v, 'MANUAL');
  });

  function beep() {
    if (navigator.vibrate) navigator.vibrate(60);
    if (!opts.beep) return;
    try {
      var ac = beep.ac || (beep.ac = new (window.AudioContext || window.webkitAudioContext)());
      var o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 1320; g.gain.value = 0.08;
      o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.09);
    } catch (e) { /* no audio */ }
  }

  /* ---------- scan handling ---------- */
  function handleRaw(raw, format) {
    raw = String(raw || '');
    if (raw.indexOf(SETUP_PREFIX) === 0) return applySetup(raw.slice(SETUP_PREFIX.length));
    beep();
    lastRaw = { raw: raw, format: format };
    var a = R.apply(rules, raw, format);
    current = { raw: raw, format: format, code: a.code, rule: a.rule, info: R.inspect(raw, format), item: byCode[a.code] || null, status: 'wait' };
    renderResult();
    lookup(true);
  }

  async function lookup(log) {
    var c = current;
    if (!c) return;
    c.item = byCode[c.code] || null;
    if (!cfg.url) { c.status = c.item ? 'ok' : 'new'; c.offline = true; renderResult(); return; }
    c.status = c.item ? 'ok' : 'wait';
    renderResult();
    try {
      var r = await api('scan', { code: c.code, raw: c.raw, log: log !== false });
      if (c !== current) return;
      c.item = r.item || null;
      c.status = c.item ? 'ok' : 'new';
      c.offline = false;
      if (c.item) putItem(c.item);
      else if (byCode[c.code]) setItems(items.filter(function (x) { return x.code !== c.code; }));
    } catch (e) {
      if (c !== current) return;
      c.status = c.item ? 'ok' : 'new'; c.offline = true;
      toast(errText(e) + ' — แสดงจากข้อมูลในเครื่อง', true);
    }
    renderResult();
  }

  function infoBlock(info, raw, format) {
    var rows = info.details.map(function (d) { return '<dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd>'; }).join('');
    return '<details' + (current && current.status === 'new' ? ' open' : '') + '><summary>QR นี้คืออะไร · <b>' + esc(info.label) + '</b>' + (format && format !== 'MANUAL' ? ' · ' + esc(format) : '') + '</summary>' +
      '<div class="raw" style="margin-top:8px">' + esc(raw.replace(/\u001d/g, '‹GS›')) + '</div>' +
      (rows ? '<dl class="kv" style="margin-top:8px">' + rows + '</dl>' : '') + '</details>';
  }

  function renderResult() {
    var el = $('#result');
    var c = current;
    if (!c) { el.innerHTML = ''; return; }
    var pill = c.status === 'ok' ? '<span class="status-pill ok">✓ มีในคลังแล้ว</span>'
      : c.status === 'new' ? '<span class="status-pill new">ยังไม่เคยลงทะเบียน</span>'
      : '<span class="status-pill wait">กำลังตรวจสอบ…</span>';
    var ruleTxt = c.rule ? 'ใช้กฎ: <span class="chip">' + esc(c.rule.name) + '</span>' : '<span class="muted">ไม่มีกฎที่ตรง → ใช้ค่าทั้งหมด</span>';
    var h = '<div class="card result ' + c.status + '">' + pill +
      '<div><div class="muted small">รหัสสินค้า</div><div class="code-big">' + esc(c.code || '—') + '</div><div class="small">' + ruleTxt + '</div></div>';

    if (c.status === 'ok' && c.item) {
      var it = c.item;
      h += '<dl class="kv">' +
        '<dt>ชื่อ</dt><dd><b>' + esc(it.name || '-') + '</b></dd>' +
        (it.qty !== '' && it.qty != null ? '<dt>จำนวน</dt><dd>' + esc(it.qty) + ' ' + esc(it.unit || '') + '</dd>' : '') +
        (it.location ? '<dt>ที่เก็บ</dt><dd>' + esc(it.location) + '</dd>' : '') +
        '<dt>ลงทะเบียนเมื่อ</dt><dd>' + fmtDate(it.created_at) + '</dd>' +
        '<dt>สแกนแล้ว</dt><dd>' + esc(it.scan_count || 0) + ' ครั้ง</dd></dl>' +
        (it.note ? '<div><div class="muted small">Note</div><div class="note-box">' + esc(it.note) + '</div></div>' : '') +
        '<div class="row-end"><button class="btn" type="button" data-act="history">ประวัติ</button>' +
        '<button class="btn primary" type="button" data-act="edit">แก้ไข / เพิ่ม note</button></div>';
    } else if (c.status === 'new') {
      h += '<form id="regForm" class="card" style="padding:0;border:0;box-shadow:none">' +
        '<label>รหัสสินค้า (แก้ได้)<input name="code" value="' + esc(c.code) + '" required></label>' +
        '<label>ชื่อสินค้า<input name="name" placeholder="เช่น ถุงมือยาง ไซซ์ M"></label>' +
        '<label>Note<textarea name="note" rows="2" placeholder="รายละเอียด / ข้อสังเกต"></textarea></label>' +
        '<div class="grid2"><label>จำนวน<input name="qty" type="number" inputmode="decimal" step="any"></label>' +
        '<label>หน่วย<input name="unit" placeholder="ชิ้น / กล่อง"></label></div>' +
        '<label>ที่เก็บ<input name="location" placeholder="เช่น ชั้น A2"></label>' +
        '<div class="row-end"><button class="btn primary" type="submit">บันทึกเข้าคลัง</button></div></form>';
    }
    h += infoBlock(c.info, c.raw, c.format);
    h += '<div class="row-end">' +
      '<button class="btn small" type="button" data-act="rule">ตั้งกฎจากโค้ดนี้</button>' +
      (c.status !== 'new' ? '<button class="btn small" type="button" data-act="recode">แก้รหัสแล้วตรวจใหม่</button>' : '') +
      (camOn ? '<button class="btn small primary" type="button" data-act="next">สแกนถัดไป</button>' : '') + '</div>';
    if (c.offline && cfg.url) h += '<p class="small muted">แสดงจากข้อมูลในเครื่อง (ออฟไลน์)</p>';
    if (!cfg.url) h += '<p class="small muted">ยังไม่ได้เชื่อม Google Sheet — ไปที่ <a href="#" data-go="settings">ตั้งค่า</a></p>';
    h += '</div>';
    el.innerHTML = h;

    var form = $('#regForm');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var it = { code: fd.get('code').trim(), name: fd.get('name'), note: fd.get('note'), qty: fd.get('qty'), unit: fd.get('unit'), location: fd.get('location'), format: c.format, raw_sample: c.raw };
      busy(form.querySelector('button[type=submit]'), async function () {
        try {
          var r = await api('save', { item: it, mode: 'create' });
          putItem(r.item);
          c.code = r.item.code; c.item = r.item; c.status = 'ok';
          toast('บันทึกเข้าคลังแล้ว');
          renderResult();
        } catch (err) { toast(errText(err), true); }
      });
    });
  }

  $('#result').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || !current) return;
    var act = b.dataset.act;
    if (act === 'next') { current = null; renderResult(); resumeCam(); }
    else if (act === 'edit') openItem(current.item);
    else if (act === 'history') openHistory(current.code);
    else if (act === 'rule') { $('#ruleSample').value = current.raw; go('rules'); }
    else if (act === 'recode') {
      dialog('<h3>แก้รหัสแล้วตรวจใหม่</h3><label>รหัสสินค้า<input name="code" value="' + esc(current.code) + '"></label>',
        [['ยกเลิก'], ['ตรวจ', 'primary', 'ok']]).then(function (r) {
        if (r && r.btn === 'ok' && r.data.code.trim()) { current.code = r.data.code.trim(); current.rule = null; lookup(false); }
      });
    }
  });

  /* ---------- generic dialog (no native prompt/confirm) ---------- */
  function dialog(html, buttons) {
    var dlg = $('#dlg'), form = $('#dlgForm');
    form.innerHTML = html + '<div class="row-end">' + buttons.map(function (b) {
      return '<button class="btn ' + (b[1] || '') + '" value="' + (b[2] || 'cancel') + '"' + (b[2] ? '' : ' formnovalidate') + '>' + esc(b[0]) + '</button>';
    }).join('') + '</div>';
    return new Promise(function (resolve) {
      // resolve on submit (immediate) rather than on the dialog's close event, which can lag
      function finish(btn) {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        var data = {};
        form.querySelectorAll('[name]').forEach(function (i) { data[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
        if (dlg.open) dlg.close(btn);
        resolve({ btn: btn, data: data });
      }
      function onSubmit(e) { e.preventDefault(); finish(e.submitter ? e.submitter.value : 'cancel'); }
      function onClose() { if (!dlg.open) finish('cancel'); } // ignore a late close event from the previous dialog
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      var first = form.querySelector('input,textarea,select');
      if (first && window.matchMedia('(pointer:fine)').matches) first.focus();
    });
  }
  function confirmBox(msg, okLabel) {
    return dialog('<h3>ยืนยัน</h3><p style="margin:0">' + esc(msg) + '</p>', [['ยกเลิก'], [okLabel || 'ตกลง', 'primary danger', 'ok']])
      .then(function (r) { return r.btn === 'ok'; });
  }

  /* ---------- item edit / history ---------- */
  function itemFields(it) {
    it = it || {};
    return '<label>รหัสสินค้า<input name="code" value="' + esc(it.code) + '" required></label>' +
      '<label>ชื่อสินค้า<input name="name" value="' + esc(it.name) + '"></label>' +
      '<label>Note<textarea name="note" rows="4">' + esc(it.note) + '</textarea></label>' +
      '<div class="grid2"><label>จำนวน<input name="qty" type="number" step="any" inputmode="decimal" value="' + esc(it.qty) + '"></label>' +
      '<label>หน่วย<input name="unit" value="' + esc(it.unit) + '"></label></div>' +
      '<label>ที่เก็บ<input name="location" value="' + esc(it.location) + '"></label>';
  }

  async function openItem(it) {
    var isNew = !it;
    var meta = it ? '<p class="small muted" style="margin:0">ลงทะเบียน ' + fmtDate(it.created_at) + ' · แก้ไขล่าสุด ' + fmtDate(it.updated_at) + ' · สแกน ' + (it.scan_count || 0) + ' ครั้ง</p>' : '';
    var btns = isNew ? [['ยกเลิก'], ['บันทึก', 'primary', 'save']] : [['ลบ', 'danger', 'del'], ['ยกเลิก'], ['บันทึก', 'primary', 'save']];
    var r = await dialog('<h3>' + (isNew ? 'เพิ่มรายการเอง' : 'แก้ไขรายการ') + '</h3>' + meta + itemFields(it), btns);
    if (r.btn === 'del') {
      if (await confirmBox('ลบ "' + (it.name || it.code) + '" ออกจากคลัง? (ประวัติยังอยู่ใน Sheet)', 'ลบ')) {
        try { await api('remove', { code: it.code }); setItems(items.filter(function (x) { return x.code !== it.code; })); toast('ลบแล้ว'); if (current && current.code === it.code) { current.item = null; current.status = 'new'; renderResult(); } }
        catch (e) { toast(errText(e), true); }
      }
      return;
    }
    if (r.btn !== 'save') return;
    var d = r.data;
    if (!d.code.trim()) return toast('ต้องมีรหัสสินค้า', true);
    toast('กำลังบันทึก…');
    try {
      var res = await api('save', { item: d, originalCode: isNew ? '' : it.code, mode: isNew ? 'create' : 'update' });
      if (!isNew && it.code !== res.item.code) items = items.filter(function (x) { return x.code !== it.code; });
      putItem(res.item);
      if (current && (current.code === (it && it.code) || current.code === res.item.code)) { current.code = res.item.code; current.item = res.item; current.status = 'ok'; renderResult(); }
      toast('บันทึกแล้ว');
    } catch (e) { toast(errText(e), true); }
  }

  var ACT_TH = { scan: 'สแกน', create: 'ลงทะเบียน', update: 'แก้ไข', delete: 'ลบ', rules: 'กฎ' };
  async function openHistory(code) {
    var p = dialog('<h3>ประวัติ · ' + esc(code) + '</h3><div id="histBody" class="muted">กำลังโหลด…</div>', [['ปิด']]);
    try {
      var r = await api('history', { code: code, limit: 40 });
      var b = $('#histBody');
      if (b) b.outerHTML = r.rows.length ? '<ul class="history">' + r.rows.map(function (x) {
        return '<li><b>' + esc(ACT_TH[x.action] || x.action) + '</b> · ' + fmtDate(x.ts) + (x.device ? ' · ' + esc(x.device) : '') + '<br><span class="muted">' + esc(x.detail) + '</span></li>';
      }).join('') + '</ul>' : '<p class="muted">ยังไม่มีประวัติ</p>';
    } catch (e) { var b2 = $('#histBody'); if (b2) b2.textContent = errText(e); }
    return p;
  }

  /* ---------- stock list ---------- */
  function renderStock() {
    var q = ($('#stockSearch').value || '').trim().toLowerCase();
    var list = items.slice().sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
    if (q) list = list.filter(function (it) { return [it.code, it.name, it.note, it.location].join(' ').toLowerCase().indexOf(q) >= 0; });
    $('#stockCount').textContent = 'ทั้งหมด ' + items.length + ' รายการ' + (q ? ' · พบ ' + list.length : '');
    $('#stockList').innerHTML = list.length ? list.map(function (it) {
      return '<li class="tap" data-code="' + esc(it.code) + '"><div class="main"><div class="t">' + esc(it.name || '(ไม่มีชื่อ)') + '</div>' +
        '<div class="s">' + esc(it.code) + (it.location ? ' · ' + esc(it.location) : '') + (it.note ? ' · ' + esc(it.note) : '') + '</div></div>' +
        (it.qty !== '' && it.qty != null ? '<div class="qty">' + esc(it.qty) + ' ' + esc(it.unit || '') + '</div>' : '') + '</li>';
    }).join('') : '<li class="empty">' + (items.length ? 'ไม่พบรายการที่ค้นหา' : 'ยังไม่มีสินค้าในคลัง — ไปสแกนเพื่อลงทะเบียน') + '</li>';
  }
  $('#stockSearch').addEventListener('input', renderStock);
  $('#stockList').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-code]');
    if (li) openItem(byCode[li.dataset.code]);
  });
  $('#btnRefresh').addEventListener('click', function () { var b = this; busy(b, function () { return syncAll(false); }); });
  $('#btnAddManual').addEventListener('click', function () { openItem(null); });
  $('#btnExport').addEventListener('click', function () {
    var cols = ['code', 'name', 'note', 'qty', 'unit', 'location', 'format', 'created_at', 'updated_at', 'scan_count', 'last_scan'];
    var csv = '\ufeff' + cols.join(',') + '\n' + items.map(function (it) {
      return cols.map(function (k) { var v = it[k] == null ? '' : String(it[k]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'qr-stock-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ---------- rules ---------- */
  var MATCH_TH = { any: 'ทุกโค้ด', gs1: 'เป็น GS1', url: 'เป็นลิงก์ URL', digits: 'เป็นตัวเลขล้วน', contains: 'มีข้อความ', startsWith: 'ขึ้นต้นด้วย', regex: 'ตรงกับ Regex' };
  var EXTRACT_TH = { whole: 'ใช้ค่าทั้งหมด', gs1: 'ค่าจาก GS1 AI', split: 'แยกด้วยตัวคั่น เอาช่องที่…', between: 'ข้อความระหว่าง…', substring: 'ตัดตามตำแหน่งตัวอักษร', urlParam: 'ค่าพารามิเตอร์ใน URL (?x=)', urlPath: 'ส่วนของ path ใน URL', jsonKey: 'ค่าจาก JSON key', regex: 'Regex (กลุ่มที่จับได้)' };

  function ruleSummary(r) {
    var m = r.match || {}, x = r.extract || {};
    var a = MATCH_TH[m.type || 'any'] + (m.value && m.type !== 'gs1' && m.type !== 'url' ? ' "' + m.value + '"' : '') + (m.format ? ' · ' + m.format : '');
    var b = EXTRACT_TH[x.type || 'whole'];
    if (x.type === 'gs1') b += ' (' + (x.ai || '01') + ')';
    if (x.type === 'split') b += ' "' + (x.delimiter || '|') + '" ช่อง ' + (x.index || 1);
    if (x.type === 'urlParam') b += ' ' + (x.param || 'id');
    if (x.type === 'between') b += ' "' + (x.after || '') + '" … "' + (x.before || '') + '"';
    if (x.type === 'substring') b += ' ตัวที่ ' + (x.start || 1) + (x.length ? ' ยาว ' + x.length : '');
    return 'ถ้า' + a + ' → ' + b;
  }

  function renderRules() {
    $('#ruleList').innerHTML = rules.length ? rules.map(function (r, i) {
      return '<li class="' + (r.enabled === false ? 'off' : '') + '" data-i="' + i + '">' +
        '<label class="check" style="min-height:0"><input type="checkbox" data-r="toggle" ' + (r.enabled === false ? '' : 'checked') + ' aria-label="เปิดใช้"></label>' +
        '<div class="main tap" data-r="edit"><div class="t">' + (i + 1) + '. ' + esc(r.name) + '</div><div class="s">' + esc(ruleSummary(r)) + '</div></div>' +
        '<div class="rule-btns"><button class="btn" type="button" data-r="up" aria-label="เลื่อนขึ้น">↑</button><button class="btn" type="button" data-r="down" aria-label="เลื่อนลง">↓</button></div></li>';
    }).join('') : '<li class="empty">ยังไม่มีกฎ — ระบบจะใช้ค่าทั้งหมดเป็นรหัส</li>';
    $('#btnSaveRules').disabled = !rulesDirty;
    renderRuleTest();
  }
  function markRules() { rulesDirty = true; store('rules', rules); renderRules(); }

  $('#ruleList').addEventListener('click', function (e) {
    var t = e.target.closest('[data-r]'); if (!t) return;
    var i = Number(t.closest('li').dataset.i);
    var act = t.dataset.r;
    if (act === 'toggle') { rules[i].enabled = t.checked; markRules(); }
    else if (act === 'up' && i > 0) { rules.splice(i - 1, 0, rules.splice(i, 1)[0]); markRules(); }
    else if (act === 'down' && i < rules.length - 1) { rules.splice(i + 1, 0, rules.splice(i, 1)[0]); markRules(); }
    else if (act === 'edit') editRule(i);
  });
  $('#btnAddRule').addEventListener('click', function () { editRule(-1); });
  $('#btnSaveRules').addEventListener('click', function () {
    var b = this;
    busy(b, async function () {
      try { await api('saveRules', { rules: JSON.stringify(rules) }); rulesDirty = false; toast('บันทึกกฎแล้ว ทุกเครื่องจะใช้กฎนี้'); }
      catch (e) { toast(errText(e), true); }
    }).then(function () { b.disabled = !rulesDirty; });
  });

  function opt(map, sel) { return Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>'; }).join(''); }

  async function editRule(i) {
    var r = i >= 0 ? JSON.parse(JSON.stringify(rules[i])) : { id: 'r_' + Date.now().toString(36), name: '', enabled: true, match: { type: 'any' }, extract: { type: 'whole' }, post: {} };
    var m = r.match || {}, x = r.extract || {}, p = r.post || {};
    var html = '<h3>' + (i >= 0 ? 'แก้ไขกฎ' : 'เพิ่มกฎ') + '</h3>' +
      '<label>ชื่อกฎ<input name="name" value="' + esc(r.name) + '" placeholder="เช่น QR ใบส่งของ → ช่องที่ 2"></label>' +
      '<fieldset class="card" style="box-shadow:none"><b>1) ใช้กับโค้ดแบบไหน</b>' +
      '<label>เงื่อนไข<select name="mtype">' + opt(MATCH_TH, m.type || 'any') + '</select></label>' +
      '<label data-show="mval">ค่า<input name="mval" value="' + esc(m.value) + '" placeholder="ข้อความ / regex / จำนวนหลัก"></label>' +
      '<label>ชนิดโค้ด (ไม่บังคับ)<input name="mformat" value="' + esc(m.format) + '" placeholder="เช่น QR_CODE, EAN_13, CODE_128"></label></fieldset>' +
      '<fieldset class="card" style="box-shadow:none"><b>2) อ่านค่าอะไรมาเป็นรหัสสินค้า</b>' +
      '<label>วิธี<select name="xtype">' + opt(EXTRACT_TH, x.type || 'whole') + '</select></label>' +
      '<label data-show="gs1">GS1 AI<select name="ai">' + opt({ '01': '(01) GTIN', '10': '(10) Lot/Batch', '21': '(21) Serial', '17': '(17) วันหมดอายุ', '240': '(240) Additional ID', '00': '(00) SSCC' }, x.ai || '01') + '</select></label>' +
      '<div class="grid2" data-show="split"><label>ตัวคั่น<input name="delimiter" value="' + esc(x.delimiter || '|') + '" placeholder="| , ; \\t"></label><label>ช่องที่ (−1 = สุดท้าย)<input name="sindex" type="number" value="' + esc(x.index || 1) + '"></label></div>' +
      '<div class="grid2" data-show="between"><label>หลังข้อความ<input name="after" value="' + esc(x.after) + '"></label><label>ก่อนข้อความ<input name="before" value="' + esc(x.before) + '"></label></div>' +
      '<div class="grid2" data-show="substring"><label>เริ่มตัวที่<input name="start" type="number" min="1" value="' + esc(x.start || 1) + '"></label><label>ความยาว (ว่าง = ถึงท้าย)<input name="length" type="number" min="1" value="' + esc(x.length) + '"></label></div>' +
      '<label data-show="urlParam">ชื่อพารามิเตอร์<input name="param" value="' + esc(x.param || 'id') + '"></label>' +
      '<label data-show="urlPath">ส่วนที่ (−1 = สุดท้าย)<input name="pindex" type="number" value="' + esc(x.index || -1) + '"></label>' +
      '<label data-show="jsonKey">Key (ซ้อนใช้จุด เช่น item.sku)<input name="jkey" value="' + esc(x.key) + '"></label>' +
      '<div class="grid2" data-show="regex"><label>Pattern<input name="pattern" value="' + esc(x.pattern) + '" placeholder="SKU:(\\w+)"></label><label>กลุ่มที่<input name="group" type="number" min="0" value="' + esc(x.group) + '" placeholder="1"></label></div></fieldset>' +
      '<fieldset class="card" style="box-shadow:none"><b>3) ปรับแต่งผลลัพธ์</b>' +
      '<label class="check"><input type="checkbox" name="upper" ' + (p.upper ? 'checked' : '') + '> ตัวพิมพ์ใหญ่ทั้งหมด</label>' +
      '<label class="check"><input type="checkbox" name="stripZeros" ' + (p.stripZeros ? 'checked' : '') + '> ตัด 0 นำหน้า</label>' +
      '<div class="grid2"><label>เติมข้างหน้า<input name="prefix" value="' + esc(p.prefix) + '"></label><label>เติมข้างหลัง<input name="suffix" value="' + esc(p.suffix) + '"></label></div></fieldset>' +
      '<div class="card" style="box-shadow:none"><b>ทดสอบ</b><textarea name="sample" rows="2" placeholder="วางค่าตัวอย่าง">' + esc($('#ruleSample').value || (lastRaw && lastRaw.raw) || '') + '</textarea><div id="rulePreview" class="code-big"></div></div>';
    var btns = i >= 0 ? [['ลบกฎ', 'danger', 'del'], ['ยกเลิก'], ['ใช้กฎนี้', 'primary', 'ok']] : [['ยกเลิก'], ['เพิ่มกฎ', 'primary', 'ok']];
    var pr = dialog(html, btns);

    var form = $('#dlgForm');
    function read() {
      var f = {}; form.querySelectorAll('[name]').forEach(function (el) { f[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
      var nr = { id: r.id, name: f.name.trim() || 'กฎไม่มีชื่อ', enabled: r.enabled !== false, match: { type: f.mtype }, extract: { type: f.xtype }, post: {} };
      if (f.mval && ['contains', 'startsWith', 'regex', 'digits'].indexOf(f.mtype) >= 0) nr.match.value = f.mval;
      if (f.mformat.trim()) nr.match.format = f.mformat.trim().toUpperCase();
      var X = nr.extract;
      if (f.xtype === 'gs1') X.ai = f.ai;
      if (f.xtype === 'split') { X.delimiter = f.delimiter; X.index = Number(f.sindex || 1); }
      if (f.xtype === 'between') { X.after = f.after; X.before = f.before; }
      if (f.xtype === 'substring') { X.start = Number(f.start || 1); if (f.length) X.length = Number(f.length); }
      if (f.xtype === 'urlParam') X.param = f.param;
      if (f.xtype === 'urlPath') X.index = Number(f.pindex || -1);
      if (f.xtype === 'jsonKey') X.key = f.jkey;
      if (f.xtype === 'regex') { X.pattern = f.pattern; if (f.group !== '') X.group = Number(f.group); }
      if (f.upper) nr.post.upper = true;
      if (f.stripZeros) nr.post.stripZeros = true;
      if (f.prefix) nr.post.prefix = f.prefix;
      if (f.suffix) nr.post.suffix = f.suffix;
      return { rule: nr, sample: f.sample };
    }
    function refresh() {
      var f = read();
      form.querySelectorAll('[data-show]').forEach(function (el) {
        var k = el.dataset.show;
        el.hidden = k === 'mval' ? ['contains', 'startsWith', 'regex', 'digits'].indexOf(f.rule.match.type) < 0 : k !== f.rule.extract.type;
      });
      var out = $('#rulePreview');
      if (!f.sample) { out.innerHTML = '<span class="muted small">ใส่ค่าตัวอย่างเพื่อดูผล</span>'; return; }
      if (!R.matches(f.rule, f.sample, '')) { out.innerHTML = '<span class="muted small">ค่าตัวอย่างไม่ตรงเงื่อนไขข้อ 1</span>'; return; }
      var v = R.post(f.rule, R.extract(f.rule, f.sample));
      out.innerHTML = v ? '→ ' + esc(v) : '<span class="muted small">อ่านค่าไม่ได้ (ว่าง)</span>';
    }
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();

    var res = await pr;
    form.removeEventListener('input', refresh);
    form.removeEventListener('change', refresh);
    if (res.btn === 'del') {
      if (await confirmBox('ลบกฎ "' + r.name + '"?', 'ลบ')) { rules.splice(i, 1); markRules(); }
      return;
    }
    if (res.btn !== 'ok') return;
    var nr = read().rule;
    if (i >= 0) rules[i] = nr; else rules.push(nr);
    markRules();
    toast('อย่าลืมกด "บันทึกกฎ" เพื่อใช้ร่วมทุกเครื่อง');
  }

  function renderRuleTest() {
    var s = $('#ruleSample').value;
    var out = $('#ruleTest');
    if (!s) { out.innerHTML = ''; return; }
    var info = R.inspect(s, '');
    var a = R.apply(rules, s, '');
    var rows = rules.map(function (r) {
      if (r.enabled === false) return '<div class="test-row skip"><span>' + esc(r.name) + '</span><span>ปิดอยู่</span></div>';
      var ok = R.matches(r, s, '');
      var v = ok ? R.post(r, R.extract(r, s)) : '';
      var win = a.rule && a.rule.id === r.id;
      return '<div class="test-row' + (win ? ' win' : ok ? '' : ' skip') + '"><span>' + (win ? '✓ ' : '') + esc(r.name) + '</span><span class="v">' + (ok ? (v ? esc(v) : '(ว่าง)') : 'ไม่ตรง') + '</span></div>';
    }).join('');
    out.innerHTML = '<p class="small" style="margin:6px 0">ชนิด: <b>' + esc(info.label) + '</b></p>' +
      (info.details.length ? '<dl class="kv">' + info.details.map(function (d) { return '<dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd>'; }).join('') + '</dl>' : '') +
      rows + '<div class="test-row win"><span>รหัสสินค้าที่ได้</span><span class="v">' + esc(a.code) + '</span></div>';
  }
  $('#ruleSample').addEventListener('input', renderRuleTest);

  /* ---------- settings ---------- */
  function fillSettings() {
    $('#cfgUrl').value = cfg.url || '';
    $('#cfgKey').value = cfg.key || '';
    $('#cfgDevice').value = cfg.device || '';
    $('#optBeep').checked = opts.beep !== false;
    $('#optAutoCam').checked = !!opts.autoCam;
    $('#appVer').textContent = 'v' + APP_VERSION;
  }
  async function testConn(btn) {
    var st = $('#cfgStatus');
    st.textContent = 'กำลังทดสอบ…';
    await busy(btn, async function () {
      try {
        var r = await api('ping');
        st.innerHTML = '✓ เชื่อมต่อสำเร็จ (backend v' + esc(r.version) + ') · <a href="' + esc(r.sheet) + '" target="_blank" rel="noopener">เปิด Google Sheet</a>';
        await syncAll(true);
      } catch (e) { st.textContent = '✗ ' + errText(e); }
    });
  }
  $('#btnSaveCfg').addEventListener('click', function () {
    cfg = { url: $('#cfgUrl').value.trim(), key: $('#cfgKey').value.trim(), device: $('#cfgDevice').value.trim() };
    store('cfg', cfg);
    testConn(this);
  });
  $('#btnClearCfg').addEventListener('click', async function () {
    if (!(await confirmBox('ล้างการตั้งค่าการเชื่อมต่อและข้อมูลที่เก็บไว้ในเครื่องนี้? (ข้อมูลใน Google Sheet ไม่หาย)', 'ล้าง'))) return;
    cfg = { url: '', key: '', device: '' }; store('cfg', cfg); setItems([]); fillSettings(); setConn(null);
    $('#cfgStatus').textContent = 'ล้างแล้ว';
  });
  $('#optBeep').addEventListener('change', function () { opts.beep = this.checked; store('opts', opts); });
  $('#optAutoCam').addEventListener('change', function () { opts.autoCam = this.checked; store('opts', opts); });

  function applySetup(json) {
    try {
      var s = JSON.parse(json);
      if (!s.u || !s.k) throw new Error('bad');
      cfg.url = s.u; cfg.key = s.k;
      store('cfg', cfg);
      fillSettings();
      toast('ตั้งค่าการเชื่อมต่อจาก QR แล้ว');
      stopCam();
      go('settings');
      testConn($('#btnSaveCfg'));
    } catch (e) { toast('QR ตั้งค่าไม่ถูกต้อง', true); resumeCam(); }
  }

  /* ---------- boot ---------- */
  fillSettings();
  renderStock();
  renderRules();
  if (cfg.url && cfg.key) syncAll(true); else setConn(null);
  if (opts.autoCam) startCam();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
