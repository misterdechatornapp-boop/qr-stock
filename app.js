/* QR Stock — UI */
(function () {
  'use strict';
  var APP_VERSION = '1.3.0';
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
  // 'YYYY-MM-DD' or 'YYYY-MM' (GS1 dates) → Thai date
  function fmtDay(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) return v ? String(v) : '-';
    return (m[3] ? Number(m[3]) + ' ' : '') + TH_MONTHS[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543);
  }
  function expBadge(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) return '';
    var end = m[3] ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(+m[1], +m[2], 0);
    var days = Math.floor((end - new Date().setHours(0, 0, 0, 0)) / 864e5);
    if (days < 0) return '<span class="badge bad">หมดอายุแล้ว</span>';
    if (days <= 90) return '<span class="badge warn">ใกล้หมดอายุ · ' + days + ' วัน</span>';
    return '';
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
  function kindOf(x) { return x.serial ? 'serial' : x.lot ? 'lot' : 'type'; }
  function isImg(s) { return /^data:image\/(jpeg|png|webp);base64,/.test(s || ''); }

  /* ---------- state ---------- */
  var cfg = store('cfg') || { url: '', key: '', device: '' };
  var opts = store('opts') || { beep: true, autoCam: false };
  var items = store('items2') || [];
  var products = store('products') || [];
  var rules = store('rules2') || R.defaultRules();
  var rulesDirty = false;
  var lastRaw = null;
  var current = null; // scan context, see parseCode()
  var stockMode = 'items';
  var byCode = {}, byType = {};

  function reindex() {
    byCode = {}; byType = {};
    items.forEach(function (it) { byCode[it.code] = it; });
    products.forEach(function (p) { byType[p.type_code] = p; });
  }
  function saveLocal() { reindex(); store('items2', items); store('products', products); renderStock(); fillDatalists(); }
  function putItem(it) {
    if (!it) return;
    var i = items.findIndex(function (x) { return x.code === it.code; });
    if (i >= 0) items[i] = it; else items.push(it);
    saveLocal();
  }
  function putProduct(p) {
    if (!p) return;
    var i = products.findIndex(function (x) { return x.type_code === p.type_code; });
    if (i >= 0) products[i] = p; else products.push(p);
    saveLocal();
  }
  function unitsOf(type) { return items.filter(function (it) { return it.type_code === type; }); }
  function totalOf(type) {
    var u = unitsOf(type);
    var n = u.reduce(function (s, it) { return s + (it.serial ? 1 : Number(it.qty) || 0); }, 0);
    var unit = u.every(function (it) { return it.serial; }) ? 'เครื่อง' : (u.filter(function (it) { return it.unit; })[0] || {}).unit || '';
    return n + (unit ? ' ' + unit : '');
  }

  /* ---------- server ---------- */
  var ERR_TH = {
    unauthorized: 'รหัสเข้าใช้ไม่ถูกต้อง', duplicate_code: 'รายการนี้มีอยู่ในคลังแล้ว', not_found: 'ไม่พบรายการนี้',
    empty_code: 'ยังไม่มีรหัส', no_config: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ (ไปที่ ตั้งค่า)', network: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้',
    has_items: 'ยังมีเครื่อง/ล็อตของประเภทนี้อยู่ในคลัง ลบรายการเหล่านั้นก่อน', bad_image: 'รูปใหญ่เกินไป',
    unknown_action: 'เซิร์ฟเวอร์ยังเป็นเวอร์ชันเก่า'
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
    if (!data.ok) {
      if (data.error === 'unauthorized') setConn('bad');
      var err = new Error(data.error || 'error'); err.data = data; throw err;
    }
    setConn('ok');
    return data;
  }

  function setConn(state) {
    var b = $('#connBadge');
    b.classList.remove('ok', 'bad');
    if (state) b.classList.add(state);
    $('#connText').textContent = state === 'ok' ? 'เชื่อมต่อแล้ว' : state === 'bad' ? 'เชื่อมต่อไม่ได้' : 'ยังไม่เชื่อมต่อ';
  }

  var lastSync = store('lastSync') || 0, syncing = false;
  async function syncAll(silent) {
    if (!cfg.url) { setConn(null); return; }
    if (syncing) return;
    syncing = true;
    try {
      var r = await Promise.all([api('list'), api('getRules')]);
      items = r[0].items || [];
      products = r[0].products || [];
      saveLocal();
      lastSync = Date.now(); store('lastSync', lastSync);
      var srvRules = r[1].rules ? JSON.parse(r[1].rules) : null;
      if (srvRules && srvRules.length && !rulesDirty) { rules = srvRules; store('rules2', rules); renderRules(); }
      if (!silent) toast('โหลดข้อมูลล่าสุดแล้ว');
    } catch (e) { if (!silent) toast(errText(e), true); }
    finally { syncing = false; }
  }
  // keep the local copy fresh so scan results can be shown instantly (other devices add items too)
  setInterval(function () { if (!document.hidden && cfg.url && cfg.key) syncAll(true); }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && cfg.url && cfg.key && Date.now() - lastSync > 30000) syncAll(true);
  });

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
  // Decoder: zxing-cpp (WebAssembly) behind the BarcodeDetector API. It reads small / glossy DataMatrix
  // labels that the old zxing-js engine missed. Both the script and the .wasm are served from vendor/
  // (same origin) — loading them from a CDN failed on iPhone Safari.
  var FORMATS = ['data_matrix', 'qr_code', 'micro_qr_code', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8',
    'upc_a', 'upc_e', 'itf', 'pdf417', 'aztec', 'databar', 'databar_expanded'];
  var detectorP = null;
  function getDetector() {
    if (!detectorP) {
      detectorP = (async function () {
        var lib = window.BarcodeDetectionAPI;
        if (!lib) throw new Error('decoder_script');
        if (typeof WebAssembly !== 'object') throw new Error('no_wasm');
        await lib.prepareZXingModule({
          overrides: {
            locateFile: function (path, prefix) {
              return /\.wasm$/.test(path) ? new URL('vendor/' + path, location.href).href : prefix + path;
            }
          },
          fireImmediately: true // load + compile now so failures surface here, not on the first frame
        });
        var BD = lib.BarcodeDetector;
        var sup = await BD.getSupportedFormats();
        return new BD({ formats: FORMATS.filter(function (f) { return sup.indexOf(f) >= 0; }) });
      })();
      detectorP.catch(function () { detectorP = null; }); // allow a retry after a failure
    }
    return detectorP;
  }
  function decoderError(e) {
    var m = String(e && e.message || e);
    if (m === 'decoder_script') return 'โหลดตัวอ่านบาร์โค้ดไม่สำเร็จ — รีเฟรชหน้าแล้วลองใหม่';
    if (m === 'no_wasm') return 'เบราว์เซอร์นี้ไม่รองรับ WebAssembly — อัปเดต iOS / เบราว์เซอร์';
    return 'ตัวอ่านบาร์โค้ดเริ่มทำงานไม่ได้: ' + m;
  }
  async function detectIn(source) {
    var det = await getDetector();
    var r = await det.detect(source);
    return r && r.length ? r[0] : null;
  }

  var SCAN_BOX = { x: 0.07, y: 0.12, w: 0.86, h: 0.76 }; // must match .guide in styles.css
  var MAX_DECODE = 1600; // px, longest side handed to the decoder per frame
  var HINT_AFTER = 4000; // ms without a hit before showing tips
  var cam = { stream: null, track: null, hwZoom: null, zoom: 1, torch: false, timer: 0, since: 0 };
  var camOn = false, paused = false;
  var video = $('#camVideo');
  var frameCanvas = document.createElement('canvas');

  async function startCam() {
    var btn = $('#btnCam');
    await busy(btn, async function () {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('เบราว์เซอร์นี้ไม่รองรับกล้อง (ต้องเปิดผ่าน https)');
        var detP = getDetector(); // start loading the decoder while the camera warms up
        detP.catch(function () {}); // handled below
        cam.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        cam.track = cam.stream.getVideoTracks()[0];
        video.srcObject = cam.stream;
        await video.play();
        try { await detP; } catch (e) { e.decoder = true; throw e; }
        setupCamControls();
        camOn = true; paused = false; cam.since = Date.now();
        $('#scannerIdle').hidden = true;
        $('#camGuide').hidden = false;
        $('#camCtrl').hidden = false;
        scanLoop();
      } catch (e) {
        stopStream();
        var msg = e && e.decoder ? decoderError(e)
          : e && e.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องให้เว็บนี้ในการตั้งค่าเบราว์เซอร์'
          : 'เปิดกล้องไม่ได้: ' + (e && e.message ? e.message : e);
        toast(msg, true);
      }
    });
    btn.textContent = camOn ? 'ปิดกล้อง' : 'เปิดกล้อง';
  }
  function stopStream() {
    clearTimeout(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    cam.stream = null; cam.track = null; cam.torch = false;
    video.srcObject = null;
  }
  async function stopCam() {
    if (!camOn) return;
    stopStream();
    camOn = false; paused = false;
    $('#scannerIdle').hidden = false;
    $('#camGuide').hidden = true;
    $('#camCtrl').hidden = true;
    $('#camHint').hidden = true;
    $('#btnCam').textContent = 'เปิดกล้อง';
  }
  function resumeCam() {
    if (camOn && paused) { paused = false; cam.since = Date.now(); $('#camGuide').classList.remove('hit'); scanLoop(); }
  }

  // decode the guide-box region of the visible (object-fit: cover, digitally zoomed) frame
  async function scanLoop() {
    clearTimeout(cam.timer);
    if (!camOn || paused) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      var box = video.parentNode.getBoundingClientRect();
      var digital = cam.hwZoom ? 1 : cam.zoom;
      var scale = Math.max(box.width / vw, box.height / vh) * digital;
      var visW = box.width / scale, visH = box.height / scale;
      var sx = (vw - visW) / 2 + visW * SCAN_BOX.x, sy = (vh - visH) / 2 + visH * SCAN_BOX.y;
      var sw = visW * SCAN_BOX.w, sh = visH * SCAN_BOX.h;
      var k = Math.min(1, MAX_DECODE / Math.max(sw, sh));
      frameCanvas.width = Math.round(sw * k); frameCanvas.height = Math.round(sh * k);
      frameCanvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, frameCanvas.width, frameCanvas.height);
      try {
        var hit = await detectIn(frameCanvas);
        if (hit && camOn && !paused) {
          paused = true;
          $('#camHint').hidden = true;
          $('#camGuide').classList.add('hit');
          handleRaw(hit.rawValue, String(hit.format || '').toUpperCase());
          return;
        }
      } catch (e) { /* keep scanning */ }
    }
    $('#camHint').hidden = Date.now() - cam.since < HINT_AFTER;
    cam.timer = setTimeout(scanLoop, 80);
  }

  // zoom: real optical/sensor zoom when the camera exposes it, otherwise a digital crop of the 1080p frame
  function setupCamControls() {
    var caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    var range = $('#zoomRange');
    cam.hwZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
    if (cam.hwZoom) {
      range.min = cam.hwZoom.min; range.max = Math.min(cam.hwZoom.max, 8); range.step = cam.hwZoom.step || 0.1;
    } else { range.min = 1; range.max = 4; range.step = 0.1; }
    range.value = cam.hwZoom ? Math.max(cam.hwZoom.min, Math.min(cam.zoom, range.max)) : cam.zoom;
    applyZoom(Number(range.value));
    $('#btnTorch').hidden = !caps.torch;
    $('#btnTorch').setAttribute('aria-pressed', 'false');
    if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
      cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    }
  }
  function applyZoom(z) {
    cam.zoom = z;
    $('#zoomLabel').textContent = (Math.round(z * 10) / 10) + '×';
    if (cam.hwZoom && cam.track) {
      video.style.transform = '';
      cam.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(function () {});
    } else {
      video.style.transform = z > 1 ? 'scale(' + z + ')' : '';
    }
  }
  $('#zoomRange').addEventListener('input', function () { applyZoom(Number(this.value)); });
  $('#btnTorch').addEventListener('click', function () {
    var b = this;
    if (!cam.track) return;
    cam.torch = !cam.torch;
    cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] })
      .then(function () { b.setAttribute('aria-pressed', String(cam.torch)); })
      .catch(function () { cam.torch = false; b.setAttribute('aria-pressed', 'false'); toast('เปิดไฟฉายไม่ได้', true); });
  });
  $('#btnCam').addEventListener('click', function () { camOn ? stopCam() : startCam(); });
  // release the camera when the app goes to the background (iOS keeps the green dot otherwise)
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCam(); });

  // photo path: the phone's camera app (macro + HDR) or an album picture → decode at a few sizes
  async function decodePhoto(f) {
    var bmp = await createImageBitmap(f);
    var longest = Math.max(bmp.width, bmp.height);
    var sizes = [Math.min(longest, 2000), longest, 1200].filter(function (v, i, a) { return v <= longest && a.indexOf(v) === i; });
    for (var i = 0; i < sizes.length; i++) {
      var k = sizes[i] / longest;
      var src = k === 1 ? bmp : await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      var hit = await detectIn(src);
      if (hit) return hit;
    }
    return null;
  }
  async function onPhotoPicked(e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (camOn) await stopCam();
    toast('กำลังอ่านรูป…');
    try { await getDetector(); } catch (err) { return toast(decoderError(err), true); }
    try {
      var hit = await decodePhoto(f);
      if (!hit) throw new Error('none');
      handleRaw(hit.rawValue, String(hit.format || '').toUpperCase());
    } catch (err) {
      toast(err && err.message === 'none' ? 'ไม่พบ QR / บาร์โค้ดในรูปนี้ — ลองถ่ายให้โค้ดเต็มกรอบและไม่มีแสงสะท้อน' : 'อ่านรูปไม่ได้: ' + (err && err.message || err), true);
    }
  }
  $('#fileCam').addEventListener('change', onPhotoPicked);
  $('#fileImg').addEventListener('change', onPhotoPicked);

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
  function parseCode(raw, format) {
    var a = R.apply(rules, raw, format);
    var ex = R.gs1Extras(raw) || {};
    return {
      raw: raw, format: format, type: a.type, serial: a.serial, lot: a.lot, used: a.used,
      ref: ex.ref || '', mfg_date: ex.mfg_date || '', exp_date: ex.exp_date || '', fields: ex.fields || null,
      info: R.inspect(raw, format)
    };
  }

  function handleRaw(raw, format) {
    raw = String(raw || '');
    if (raw.indexOf(SETUP_PREFIX) === 0) return applySetup(raw.slice(SETUP_PREFIX.length));
    beep();
    lastRaw = { raw: raw, format: format };
    current = parseCode(raw, format);
    resolveCurrent(true);
  }

  function resolveCurrent(log) {
    var c = current;
    c.code = R.itemKey(c.type, c.serial, c.lot);
    c.item = byCode[c.code] || null;
    c.product = byType[c.type] || null;
    // answer straight from the synced local copy; only wait for the server if we never synced
    c.status = c.item || !cfg.url || lastSync ? statusOf(c) : 'wait';
    c.verifying = !!cfg.url;
    renderResult();
    lookup(log);
  }

  function statusOf(c) { return c.item ? 'ok' : c.product ? 'known' : 'new'; }

  async function lookup(log) {
    var c = current;
    if (!c) return;
    if (!cfg.url) { c.status = statusOf(c); c.offline = true; renderResult(); return; }
    var shown = c.status;
    try {
      var r = await api('scan', { code: c.code, type_code: c.type, raw: c.raw, log: log !== false });
      if (c !== current) return;
      c.item = r.item || null;
      c.product = r.product || null;
      c.offline = false;
      if (c.item) putItem(c.item);
      else if (byCode[c.code]) { items = items.filter(function (x) { return x.code !== c.code; }); saveLocal(); }
      if (c.product) putProduct(c.product);
    } catch (e) {
      if (c !== current) return;
      c.offline = true;
      toast(errText(e) + ' — แสดงจากข้อมูลในเครื่อง', true);
    }
    c.verifying = false;
    c.status = statusOf(c);
    // re-render only when the answer changed (or for an item, to refresh its scan count) — never wipe a half-filled form
    if (c.status !== shown || c.status === 'ok' || c.offline) renderResult();
    else { var vn = $('#verifyNote'); if (vn) vn.remove(); }
  }

  function thumb(p, lg) {
    return p && isImg(p.thumb) ? '<img class="thumb' + (lg ? ' lg' : '') + '" src="' + esc(p.thumb) + '" alt="">' : '<div class="thumb' + (lg ? ' lg' : '') + '">📦</div>';
  }

  function productHead(p, type) {
    var sub = p ? [p.ref, p.category, p.brand].filter(Boolean).join(' · ') : '';
    return '<div class="product-head">' + thumb(p, true) + '<div style="min-width:0"><div class="t">' +
      (p && p.name ? esc(p.name) : '<span class="muted">ประเภทใหม่ (ยังไม่ตั้งชื่อ)</span>') + '</div>' +
      '<div class="small muted">' + esc(sub || type) + '</div></div></div>';
  }

  function idRows(c) {
    var it = c.item || {}, p = c.product || {};
    var used = c.used || {};
    var chip = function (role) { return used[role] ? ' <span class="chip">' + esc(used[role].name) + '</span>' : ''; };
    var ref = c.ref || it.ref || p.ref;
    var exp = c.exp_date || it.exp_date;
    var mfg = c.mfg_date || it.mfg_date;
    return '<dl class="kv">' +
      '<dt>ประเภท (GTIN)</dt><dd>' + esc(c.type) + (c.used && !used.type ? ' <span class="muted small">(ใช้ค่าทั้งหมด)</span>' : chip('type')) + '</dd>' +
      (ref ? '<dt>REF</dt><dd>' + esc(ref) + '</dd>' : '') +
      (c.serial ? '<dt>Serial</dt><dd><b>' + esc(c.serial) + '</b>' + chip('serial') + '</dd>' : '') +
      (c.lot ? '<dt>Lot</dt><dd><b>' + esc(c.lot) + '</b>' + chip('lot') + '</dd>' : '') +
      (mfg ? '<dt>วันผลิต</dt><dd>' + fmtDay(mfg) + '</dd>' : '') +
      (exp ? '<dt>วันหมดอายุ</dt><dd>' + fmtDay(exp) + ' ' + expBadge(exp) + '</dd>' : '') +
      '</dl>';
  }

  function infoBlock(c) {
    var rows = c.info.details.map(function (d) { return '<dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd>'; }).join('');
    if (!c.raw) return '';
    return '<details><summary>ข้อมูลทั้งหมดในโค้ด · <b>' + esc(c.info.label) + '</b>' + (c.format && c.format !== 'MANUAL' ? ' · ' + esc(c.format) : '') + '</summary>' +
      '<div class="raw" style="margin-top:8px">' + esc(c.raw.replace(/\u001d/g, '‹GS›')) + '</div>' +
      (rows ? '<dl class="kv" style="margin-top:8px">' + rows + '</dl>' : '') + '</details>';
  }

  var KIND_TH = { serial: 'เครื่องนี้', lot: 'ล็อตนี้', type: 'รายการนี้' };

  function renderResult() {
    var el = $('#result');
    var c = current;
    if (!c) { el.innerHTML = ''; return; }
    var kind = kindOf(c);
    var pill = {
      ok: '<span class="status-pill ok">✓ มีในคลังแล้ว</span>',
      known: '<span class="status-pill new">' + (kind === 'serial' ? 'เครื่องใหม่' : kind === 'lot' ? 'ล็อตใหม่' : 'ยังไม่อยู่ในคลัง') + ' · รู้จักรุ่นนี้แล้ว</span>',
      new: '<span class="status-pill new">ยังไม่เคยลงทะเบียน</span>',
      wait: '<span class="status-pill wait">กำลังตรวจสอบ…</span>'
    }[c.status];
    var h = '<div class="card result ' + (c.status === 'ok' ? 'ok' : c.status === 'wait' ? '' : 'new') + '">' + pill +
      productHead(c.product, c.type) + idRows(c);

    if (c.status === 'ok' && c.item) {
      var it = c.item;
      h += '<div class="section-label">' + KIND_TH[kind] + '</div><dl class="kv">' +
        (kind !== 'serial' ? '<dt>จำนวน</dt><dd><div class="qty-row"><button class="btn" type="button" data-act="minus" aria-label="ลด">−</button><b>' + esc(it.qty === '' ? 0 : it.qty) + '</b><button class="btn" type="button" data-act="plus" aria-label="เพิ่ม">+</button><span>' + esc(it.unit || '') + '</span></div></dd>' : '') +
        (it.location ? '<dt>ที่เก็บ</dt><dd>' + esc(it.location) + '</dd>' : '') +
        '<dt>ลงทะเบียนเมื่อ</dt><dd>' + fmtDate(it.created_at) + '</dd>' +
        '<dt>สแกนแล้ว</dt><dd>' + esc(it.scan_count || 0) + ' ครั้ง</dd></dl>' +
        (it.note ? '<div><div class="muted small">Note</div><div class="note-box">' + esc(it.note) + '</div></div>' : '') +
        '<div class="row-end"><button class="btn" type="button" data-act="history">ประวัติ</button>' +
        '<button class="btn" type="button" data-act="product">ข้อมูลประเภท</button>' +
        '<button class="btn primary" type="button" data-act="edit">แก้ไข / note</button></div>';
    } else if (c.status === 'known' || c.status === 'new') {
      h += '<form id="regForm" class="card" style="padding:0;border:0;box-shadow:none">';
      if (c.status === 'new') {
        h += '<div class="section-label">ประเภทสินค้า (ตั้งครั้งเดียว ใช้กับทุกชิ้นของรุ่นนี้)</div>' +
          '<label>ชื่อสินค้า *<input name="p_name" required placeholder="เช่น Colibrì Auxiliary Battery Kit"></label>' +
          '<div class="grid2"><label>หมวดหมู่<input name="p_category" list="dlCategory" placeholder="เช่น แบตเตอรี่"></label>' +
          '<label>ยี่ห้อ / ผู้ผลิต<input name="p_brand" list="dlBrand"></label></div>' +
          '<label>REF<input name="p_ref" value="' + esc(c.ref) + '"></label>' +
          '<label>Note ของรุ่นนี้<textarea name="p_note" rows="2"></textarea></label>' +
          '<label>รูปสินค้า<input name="p_photo" type="file" accept="image/*"></label>';
      }
      h += '<div class="section-label">' + KIND_TH[kind] + '</div>' +
        (kind !== 'serial' ? '<div class="grid2"><label>จำนวน<input name="qty" type="number" inputmode="decimal" step="any" value="1"></label>' +
          '<label>หน่วย<input name="unit" placeholder="ชิ้น / กล่อง"></label></div>' : '') +
        '<label>ที่เก็บ<input name="location" list="dlLocation" placeholder="เช่น ห้อง OR 2 / ชั้น A2"></label>' +
        '<label>Note ของ' + KIND_TH[kind].replace('นี้', '') + 'นี้<textarea name="note" rows="2" placeholder="สภาพ / ข้อสังเกต"></textarea></label>' +
        '<div class="row-end"><button class="btn primary" type="submit">บันทึกเข้าคลัง</button></div></form>';
    }
    h += infoBlock(c);
    h += '<div class="row-end">' +
      (c.raw ? '<button class="btn small" type="button" data-act="rule">ตั้งกฎจากโค้ดนี้</button>' : '') +
      '<button class="btn small" type="button" data-act="recode">แก้รหัส</button>' +
      (camOn ? '<button class="btn small primary" type="button" data-act="next">สแกนถัดไป</button>' : '') + '</div>';
    if (c.verifying && c.status !== 'wait') h += '<p class="small muted" id="verifyNote">ยืนยันกับ Google Sheet…</p>';
    if (c.offline && cfg.url) h += '<p class="small muted">แสดงจากข้อมูลในเครื่อง (ออฟไลน์)</p>';
    if (!cfg.url) h += '<p class="small muted">ยังไม่ได้เชื่อม Google Sheet — ไปที่ <a href="#" data-go="settings">ตั้งค่า</a></p>';
    h += '</div>';
    el.innerHTML = h;

    var form = $('#regForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); register(form, c); });
  }

  async function register(form, c) {
    var fd = new FormData(form);
    var kind = kindOf(c);
    var item = {
      code: c.code, type_code: c.type, serial: c.serial, lot: c.lot, ref: c.ref || (c.product && c.product.ref) || fd.get('p_ref') || '',
      mfg_date: c.mfg_date, exp_date: c.exp_date, fields: c.fields ? JSON.stringify(c.fields) : '', format: c.format, raw_sample: c.raw,
      qty: kind === 'serial' ? 1 : fd.get('qty'), unit: kind === 'serial' ? '' : fd.get('unit'), location: fd.get('location'), note: fd.get('note')
    };
    var product = c.product ? null : { type_code: c.type, name: fd.get('p_name'), category: fd.get('p_category'), brand: fd.get('p_brand'), ref: fd.get('p_ref'), note: fd.get('p_note') };
    var photo = form.p_photo && form.p_photo.files[0];
    await busy(form.querySelector('button[type=submit]'), async function () {
      try {
        var r = await api('saveItem', { item: item, product: product, mode: 'create' });
        putItem(r.item); putProduct(r.product);
        c.item = r.item; c.product = r.product; c.status = 'ok';
        toast('บันทึกเข้าคลังแล้ว');
        renderResult();
        if (photo) await uploadPhoto(c.type, photo);
      } catch (err) {
        if (err.message === 'duplicate_code' && err.data && err.data.item) {
          putItem(err.data.item);
          c.item = err.data.item; c.status = 'ok';
          renderResult();
          toast('รายการนี้มีคนบันทึกไว้แล้ว — แสดงข้อมูลที่มีอยู่', true);
        } else toast(errText(err), true);
      }
    });
  }

  async function changeQty(delta) {
    var c = current, it = c && c.item;
    if (!it) return;
    var q = Math.max(0, (Number(it.qty) || 0) + delta);
    try {
      var r = await api('saveItem', { item: { code: it.code, type_code: it.type_code, qty: q }, mode: 'update' });
      putItem(r.item);
      if (current === c) { c.item = r.item; renderResult(); }
      toast('จำนวน: ' + q);
    } catch (e) { toast(errText(e), true); }
  }

  $('#result').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || !current) return;
    var act = b.dataset.act;
    if (act === 'next') { current = null; renderResult(); resumeCam(); }
    else if (act === 'edit') openItem(current.item);
    else if (act === 'product') openProduct(current.product || { type_code: current.type });
    else if (act === 'history') openHistory(current.code);
    else if (act === 'plus' || act === 'minus') busy(b, function () { return changeQty(act === 'plus' ? 1 : -1); });
    else if (act === 'rule') { $('#ruleSample').value = current.raw; go('rules'); }
    else if (act === 'recode') recode();
  });

  async function recode(fresh) {
    var c = fresh ? { type: '', serial: '', lot: '' } : current;
    var r = await dialog('<h3>' + (fresh ? 'เพิ่มรายการเอง' : 'แก้รหัส') + '</h3>' +
      '<label>รหัสประเภท (GTIN หรือรหัสสินค้า) *<input name="type" required value="' + esc(c.type) + '"></label>' +
      '<label>Serial (ถ้ามี = นับรายเครื่อง)<input name="serial" value="' + esc(c.serial) + '"></label>' +
      '<label>Lot (ถ้ามี = นับตามล็อต)<input name="lot" value="' + esc(c.lot) + '"></label>',
      [['ยกเลิก'], ['ตรวจ', 'primary', 'ok']]);
    if (r.btn !== 'ok' || !r.data.type.trim()) return;
    if (fresh) {
      current = { raw: '', format: 'MANUAL', used: null, ref: '', mfg_date: '', exp_date: '', fields: null, info: { label: 'กรอกเอง', details: [] } };
      go('scan');
    }
    current.type = r.data.type.trim(); current.serial = r.data.serial.trim(); current.lot = r.data.lot.trim();
    current.used = null;
    resolveCurrent(false);
  }

  /* ---------- photos ---------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  function toJpeg(img, max, q) {
    var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    var cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  async function uploadPhoto(type, file) {
    toast('กำลังอัปโหลดรูป…');
    try {
      var img = await loadImage(file);
      // stored in the Sheet as text — keep it under the server's ~600k-char limit
      var full = toJpeg(img, 1024, 0.75);
      if (full.length > 560000) full = toJpeg(img, 800, 0.65);
      var th = toJpeg(img, 160, 0.7);
      var r = await api('uploadImage', { type_code: type, data: full.split(',')[1], thumb: th, mime: 'image/jpeg' });
      var p = Object.assign({}, byType[type], { image_id: r.image_id, thumb: th });
      imgCache[r.image_id] = full;
      putProduct(p);
      if (current && current.type === type) { current.product = p; renderResult(); }
      toast('อัปโหลดรูปแล้ว');
    } catch (e) { toast('อัปโหลดรูปไม่สำเร็จ: ' + errText(e), true); }
  }
  var imgCache = {};
  async function fullImage(id) {
    if (!id) return '';
    if (imgCache[id]) return imgCache[id];
    var r = await api('image', { id: id });
    return (imgCache[id] = 'data:' + r.mime + ';base64,' + r.data);
  }

  /* ---------- generic dialog (no native prompt/confirm) ---------- */
  function dialog(html, buttons) {
    var dlg = $('#dlg'), form = $('#dlgForm');
    form.innerHTML = html + '<div class="row-end">' + buttons.map(function (b) {
      return '<button class="btn ' + (b[1] || '') + '" value="' + (b[2] || 'cancel') + '"' + (b[2] && b[2] !== 'del' ? '' : ' formnovalidate') + '>' + esc(b[0]) + '</button>';
    }).join('') + '</div>';
    return new Promise(function (resolve) {
      // resolve on submit (immediate) rather than on the dialog's close event, which can lag
      function finish(btn) {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        var data = {};
        form.querySelectorAll('[name]').forEach(function (i) { data[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'file' ? i.files[0] : i.value; });
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

  /* ---------- unit (item) dialog ---------- */
  async function openItem(it) {
    if (!it) return;
    var p = byType[it.type_code];
    var kind = kindOf(it);
    var html = '<h3>' + (kind === 'serial' ? 'เครื่อง SN ' + esc(it.serial) : kind === 'lot' ? 'ล็อต ' + esc(it.lot) : 'รายการ') + '</h3>' +
      productHead(p, it.type_code) +
      '<dl class="kv"><dt>ประเภท (GTIN)</dt><dd>' + esc(it.type_code) + '</dd>' +
      (it.ref ? '<dt>REF</dt><dd>' + esc(it.ref) + '</dd>' : '') +
      (it.mfg_date ? '<dt>วันผลิต</dt><dd>' + fmtDay(it.mfg_date) + '</dd>' : '') +
      (it.exp_date ? '<dt>วันหมดอายุ</dt><dd>' + fmtDay(it.exp_date) + ' ' + expBadge(it.exp_date) + '</dd>' : '') +
      '<dt>ลงทะเบียน</dt><dd>' + fmtDate(it.created_at) + '</dd><dt>สแกน</dt><dd>' + esc(it.scan_count || 0) + ' ครั้ง</dd></dl>' +
      (kind !== 'serial' ? '<div class="grid2"><label>จำนวน<input name="qty" type="number" step="any" inputmode="decimal" value="' + esc(it.qty) + '"></label>' +
        '<label>หน่วย<input name="unit" value="' + esc(it.unit) + '"></label></div>' : '') +
      '<label>ที่เก็บ<input name="location" list="dlLocation" value="' + esc(it.location) + '"></label>' +
      '<label>Note<textarea name="note" rows="4">' + esc(it.note) + '</textarea></label>';
    var r = await dialog(html, [['ลบ', 'danger', 'del'], ['ประวัติ', '', 'hist'], ['ยกเลิก'], ['บันทึก', 'primary', 'save']]);
    if (r.btn === 'hist') return openHistory(it.code);
    if (r.btn === 'del') {
      if (await confirmBox('ลบ ' + (it.serial ? 'SN ' + it.serial : it.lot ? 'ล็อต ' + it.lot : it.code) + ' ออกจากคลัง? (ประวัติยังอยู่ใน Sheet)', 'ลบ')) {
        try {
          await api('removeItem', { code: it.code });
          items = items.filter(function (x) { return x.code !== it.code; }); saveLocal();
          toast('ลบแล้ว');
          if (current && current.code === it.code) { current.item = null; current.status = statusOf(current); renderResult(); }
        } catch (e) { toast(errText(e), true); }
      }
      return;
    }
    if (r.btn !== 'save') return;
    var d = r.data;
    var upd = { code: it.code, type_code: it.type_code, location: d.location, note: d.note };
    if (kind !== 'serial') { upd.qty = d.qty; upd.unit = d.unit; }
    toast('กำลังบันทึก…');
    try {
      var res = await api('saveItem', { item: upd, mode: 'update' });
      putItem(res.item);
      if (current && current.code === it.code) { current.item = res.item; renderResult(); }
      toast('บันทึกแล้ว');
    } catch (e) { toast(errText(e), true); }
  }

  /* ---------- product (type) dialog ---------- */
  async function openProduct(p) {
    var isNew = !byType[p.type_code];
    var units = unitsOf(p.type_code);
    var html = '<h3>' + (isNew ? 'ตั้งข้อมูลประเภทสินค้า' : 'ประเภทสินค้า') + '</h3>' +
      '<img id="dlgPhoto" class="photo-full" alt="" ' + (isImg(p.thumb) ? 'src="' + esc(p.thumb) + '"' : 'hidden') + '>' +
      '<label>รูปสินค้า (เลือกใหม่เพื่อเปลี่ยน)<input name="photo" type="file" accept="image/*"></label>' +
      '<label>รหัสประเภท (GTIN)<input value="' + esc(p.type_code) + '" disabled></label>' +
      '<label>ชื่อสินค้า *<input name="name" required value="' + esc(p.name) + '"></label>' +
      '<div class="grid2"><label>หมวดหมู่<input name="category" list="dlCategory" value="' + esc(p.category) + '"></label>' +
      '<label>ยี่ห้อ / ผู้ผลิต<input name="brand" list="dlBrand" value="' + esc(p.brand) + '"></label></div>' +
      '<label>REF<input name="ref" value="' + esc(p.ref) + '"></label>' +
      '<label>Note ของรุ่นนี้<textarea name="note" rows="3">' + esc(p.note) + '</textarea></label>' +
      (units.length ? '<div class="section-label">ในคลัง ' + units.length + ' รายการ · รวม ' + totalOf(p.type_code) + '</div><ul class="sub-list">' + units.map(function (u) {
        return '<li><button class="btn small" style="width:100%;justify-content:space-between" value="unit:' + esc(u.code) + '" formnovalidate><span>' +
          esc(u.serial ? 'SN ' + u.serial : u.lot ? 'LOT ' + u.lot : u.code) + '</span><span class="muted">' + esc(u.serial ? (u.location || '') : (u.qty + ' ' + (u.unit || ''))) + '</span></button></li>';
      }).join('') + '</ul>' : '');
    var pr = dialog(html, isNew ? [['ยกเลิก'], ['บันทึก', 'primary', 'save']] : [['ลบ', 'danger', 'del'], ['ยกเลิก'], ['บันทึก', 'primary', 'save']]);
    var photoEl = $('#dlgPhoto');
    if (p.image_id) fullImage(p.image_id).then(function (src) { if (photoEl.isConnected) { photoEl.src = src; photoEl.hidden = false; } }).catch(function () {});
    $('#dlgForm').photo.addEventListener('change', function () {
      var f = this.files[0];
      if (f) { photoEl.src = URL.createObjectURL(f); photoEl.hidden = false; }
    });
    var r = await pr;
    if (r.btn.indexOf('unit:') === 0) return openItem(byCode[r.btn.slice(5)]);
    if (r.btn === 'del') {
      if (units.length) return toast(ERR_TH.has_items, true);
      if (await confirmBox('ลบประเภท "' + (p.name || p.type_code) + '"?', 'ลบ')) {
        try {
          await api('removeProduct', { type_code: p.type_code });
          products = products.filter(function (x) { return x.type_code !== p.type_code; }); saveLocal();
          toast('ลบแล้ว');
        } catch (e) { toast(errText(e), true); }
      }
      return;
    }
    if (r.btn !== 'save') return;
    var d = r.data;
    toast('กำลังบันทึก…');
    try {
      var res = await api('saveProduct', { product: { type_code: p.type_code, name: d.name, category: d.category, brand: d.brand, ref: d.ref, note: d.note } });
      putProduct(res.product);
      if (current && current.type === p.type_code) { current.product = res.product; current.status = statusOf(current); renderResult(); }
      toast('บันทึกแล้ว');
      if (d.photo) await uploadPhoto(p.type_code, d.photo);
    } catch (e) { toast(errText(e), true); }
  }

  var ACT_TH = { scan: 'สแกน', create: 'ลงทะเบียน', update: 'แก้ไข', delete: 'ลบ', rules: 'กฎ', product_create: 'สร้างประเภท', product_update: 'แก้ประเภท', product_image: 'รูป', product_delete: 'ลบประเภท' };
  async function openHistory(code) {
    var p = dialog('<h3>ประวัติ</h3><p class="small muted" style="margin:0">' + esc(code) + '</p><div id="histBody" class="muted">กำลังโหลด…</div>', [['ปิด']]);
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
  function fillDatalists() {
    var uniq = function (arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }).sort(); };
    var opt = function (v) { return '<option value="' + esc(v) + '">'; };
    var cats = uniq(products.map(function (p) { return p.category; }));
    $('#dlCategory').innerHTML = cats.map(opt).join('');
    $('#dlBrand').innerHTML = uniq(products.map(function (p) { return p.brand; })).map(opt).join('');
    $('#dlLocation').innerHTML = uniq(items.map(function (i) { return i.location; })).map(opt).join('');
    var sel = $('#catFilter'), v = sel.value;
    sel.innerHTML = '<option value="">ทุกหมวดหมู่</option>' + cats.map(function (c) { return '<option' + (c === v ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }

  function renderStock() {
    var q = ($('#stockSearch').value || '').trim().toLowerCase();
    var cat = $('#catFilter').value;
    var hit = function (arr) { return !q || arr.join(' ').toLowerCase().indexOf(q) >= 0; };
    var list, html;
    if (stockMode === 'products') {
      list = products.filter(function (p) { return (!cat || p.category === cat) && hit([p.type_code, p.name, p.ref, p.category, p.brand, p.note]); })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'th'); });
      html = list.map(function (p) {
        var n = unitsOf(p.type_code).length;
        return '<li class="tap" data-type="' + esc(p.type_code) + '">' + thumb(p) + '<div class="main"><div class="t">' + esc(p.name || '(ไม่มีชื่อ)') + '</div>' +
          '<div class="s">' + esc([p.ref, p.category, p.brand].filter(Boolean).join(' · ') || p.type_code) + '</div></div>' +
          '<div class="qty">' + (n ? totalOf(p.type_code) : '<span class="muted small">ไม่มีของ</span>') + '</div></li>';
      }).join('');
      $('#stockCount').textContent = 'ประเภทสินค้า ' + products.length + ' รายการ' + (q || cat ? ' · พบ ' + list.length : '');
    } else {
      list = items.filter(function (it) {
        var p = byType[it.type_code] || {};
        return (!cat || p.category === cat) && hit([it.code, it.serial, it.lot, it.ref, it.location, it.note, p.name, p.category, p.brand]);
      }).sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
      html = list.map(function (it) {
        var p = byType[it.type_code];
        var id = it.serial ? 'SN ' + it.serial : it.lot ? 'LOT ' + it.lot : it.type_code;
        return '<li class="tap" data-code="' + esc(it.code) + '">' + thumb(p) + '<div class="main"><div class="t">' + esc((p && p.name) || it.type_code) + '</div>' +
          '<div class="s">' + esc([id, it.location, it.note].filter(Boolean).join(' · ')) + '</div>' + (it.exp_date ? '<div>' + expBadge(it.exp_date) + '</div>' : '') + '</div>' +
          (it.serial ? '' : '<div class="qty">' + esc(it.qty) + ' ' + esc(it.unit || '') + '</div>') + '</li>';
      }).join('');
      $('#stockCount').textContent = 'ในคลัง ' + items.length + ' รายการ' + (q || cat ? ' · พบ ' + list.length : '');
    }
    var empty = (stockMode === 'products' ? products : items).length ? 'ไม่พบรายการที่ค้นหา' : 'ยังไม่มีข้อมูล — ไปสแกนเพื่อลงทะเบียน';
    $('#stockList').innerHTML = html || '<li class="empty">' + empty + '</li>';
  }
  $('#stockSearch').addEventListener('input', renderStock);
  $('#catFilter').addEventListener('change', renderStock);
  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      stockMode = b.dataset.mode;
      document.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderStock();
    });
  });
  $('#stockList').addEventListener('click', function (e) {
    var li = e.target.closest('li.tap');
    if (!li) return;
    if (li.dataset.type) openProduct(byType[li.dataset.type]);
    else openItem(byCode[li.dataset.code]);
  });
  $('#btnRefresh').addEventListener('click', function () { var b = this; busy(b, function () { return syncAll(false); }); });
  $('#btnAddManual').addEventListener('click', function () { recode(true); });
  $('#btnExport').addEventListener('click', function () {
    var cols = ['type_code', 'name', 'category', 'brand', 'ref', 'serial', 'lot', 'mfg_date', 'exp_date', 'qty', 'unit', 'location', 'note', 'created_at', 'updated_at', 'scan_count', 'last_scan'];
    var cell = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var csv = '\ufeff' + cols.join(',') + '\n' + items.map(function (it) {
      var p = byType[it.type_code] || {};
      var row = Object.assign({}, it, { name: p.name, category: p.category, brand: p.brand, ref: it.ref || p.ref });
      return cols.map(function (k) { return cell(row[k]); }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'qr-stock-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ---------- rules ---------- */
  var ROLE_TH = { type: 'ประเภทสินค้า', serial: 'Serial (รายเครื่อง)', lot: 'Lot (ล็อต)' };
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
        '<div class="main tap" data-r="edit"><div class="t">' + esc(r.name) + '<span class="role-chip">' + esc(ROLE_TH[r.role || 'type']) + '</span></div><div class="s">' + esc(ruleSummary(r)) + '</div></div>' +
        '<div class="rule-btns"><button class="btn" type="button" data-r="up" aria-label="เลื่อนขึ้น">↑</button><button class="btn" type="button" data-r="down" aria-label="เลื่อนลง">↓</button></div></li>';
    }).join('') : '<li class="empty">ยังไม่มีกฎ — ระบบจะใช้ค่าทั้งหมดเป็นรหัสประเภท</li>';
    $('#btnSaveRules').disabled = !rulesDirty;
    renderRuleTest();
  }
  function markRules() { rulesDirty = true; store('rules2', rules); renderRules(); }

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
    var r = i >= 0 ? JSON.parse(JSON.stringify(rules[i])) : { id: 'r_' + Date.now().toString(36), name: '', role: 'type', enabled: true, match: { type: 'any' }, extract: { type: 'whole' }, post: {} };
    var m = r.match || {}, x = r.extract || {}, p = r.post || {};
    var html = '<h3>' + (i >= 0 ? 'แก้ไขกฎ' : 'เพิ่มกฎ') + '</h3>' +
      '<label>ชื่อกฎ<input name="name" value="' + esc(r.name) + '" placeholder="เช่น QR ใบส่งของ → ช่อง 2"></label>' +
      '<label>ค่าที่ได้ใช้เป็น<select name="role">' + opt(ROLE_TH, r.role || 'type') + '</select></label>' +
      '<fieldset class="card" style="box-shadow:none"><b>1) ใช้กับโค้ดแบบไหน</b>' +
      '<label>เงื่อนไข<select name="mtype">' + opt(MATCH_TH, m.type || 'any') + '</select></label>' +
      '<label data-show="mval">ค่า<input name="mval" value="' + esc(m.value) + '" placeholder="ข้อความ / regex / จำนวนหลัก"></label>' +
      '<label>ชนิดโค้ด (ไม่บังคับ)<input name="mformat" value="' + esc(m.format) + '" placeholder="เช่น QR_CODE, DATA_MATRIX, CODE_128"></label></fieldset>' +
      '<fieldset class="card" style="box-shadow:none"><b>2) อ่านค่าอะไร</b>' +
      '<label>วิธี<select name="xtype">' + opt(EXTRACT_TH, x.type || 'whole') + '</select></label>' +
      '<label data-show="gs1">GS1 AI<select name="ai">' + opt({ '01': '(01) GTIN', '21': '(21) Serial', '10': '(10) Lot/Batch', '240': '(240) REF / Additional ID', '17': '(17) วันหมดอายุ', '11': '(11) วันผลิต', '00': '(00) SSCC' }, x.ai || '01') + '</select></label>' +
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
      var nr = { id: r.id, name: f.name.trim() || 'กฎไม่มีชื่อ', role: f.role, enabled: r.enabled !== false, match: { type: f.mtype }, extract: { type: f.xtype }, post: {} };
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
      var role = ROLE_TH[r.role || 'type'];
      if (r.enabled === false) return '<div class="test-row skip"><span>' + esc(r.name) + '</span><span>ปิดอยู่</span></div>';
      var ok = R.matches(r, s, '');
      var v = ok ? R.post(r, R.extract(r, s)) : '';
      var win = a.used[r.role || 'type'] === r;
      return '<div class="test-row' + (win ? ' win' : ok ? '' : ' skip') + '"><span>' + (win ? '✓ ' : '') + esc(r.name) + '<span class="role-chip">' + esc(role) + '</span></span><span class="v">' + (ok ? (v ? esc(v) : '(ว่าง)') : 'ไม่ตรง') + '</span></div>';
    }).join('');
    out.innerHTML = '<p class="small" style="margin:6px 0">ชนิด: <b>' + esc(info.label) + '</b></p>' +
      (info.details.length ? '<dl class="kv">' + info.details.map(function (d) { return '<dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd>'; }).join('') + '</dl>' : '') +
      rows +
      '<div class="test-row win"><span>ประเภทสินค้า</span><span class="v">' + esc(a.type) + (a.used.type ? '' : ' (ค่าทั้งหมด)') + '</span></div>' +
      (a.serial ? '<div class="test-row win"><span>Serial → นับรายเครื่อง</span><span class="v">' + esc(a.serial) + '</span></div>' : '') +
      (a.lot ? '<div class="test-row win"><span>Lot' + (a.serial ? ' (เก็บไว้)' : ' → นับตามล็อต') + '</span><span class="v">' + esc(a.lot) + '</span></div>' : '') +
      (!a.serial && !a.lot ? '<div class="test-row"><span>ไม่มี Serial/Lot → นับจำนวนตามประเภท</span><span></span></div>' : '');
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
    cfg = { url: '', key: '', device: '' }; store('cfg', cfg);
    items = []; products = []; saveLocal(); fillSettings(); setConn(null);
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
  try { localStorage.removeItem('qrs.items'); localStorage.removeItem('qrs.rules'); } catch (e) { /* v1.0 leftovers */ }
  reindex();
  fillSettings();
  fillDatalists();
  renderStock();
  renderRules();
  if (cfg.url && cfg.key) syncAll(true); else setConn(null);
  if (opts.autoCam) startCam();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
