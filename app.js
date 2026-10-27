/* QR Stock — UI */
(function () {
  'use strict';
  var APP_VERSION = '1.6.1';
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
  var stockMode = store('stockMode') || 'items';
  var groups = store('groups') || [];
  var members = store('members') || []; // [{group_id, code}]
  var byCode = {}, byType = {};

  function reindex() {
    byCode = {}; byType = {};
    items.forEach(function (it) { byCode[it.code] = it; });
    products.forEach(function (p) { byType[p.type_code] = p; });
  }
  function saveLocal() {
    reindex(); store('items2', items); store('products', products); store('groups', groups); store('members', members);
    renderStock(); fillDatalists(); if (window.__qrsBatchReady) renderBatch();
  }
  function groupsOf(code) { var ids = members.filter(function (m) { return m.code === code; }).map(function (m) { return m.group_id; }); return groups.filter(function (g) { return ids.indexOf(g.group_id) >= 0; }); }
  function membersOf(gid) { return members.filter(function (m) { return m.group_id === gid; }).map(function (m) { return byCode[m.code]; }).filter(Boolean); }
  function addMembers(list) { (list || []).forEach(function (m) { if (!members.some(function (x) { return x.group_id === m.group_id && x.code === m.code; })) members.push({ group_id: m.group_id, code: m.code }); }); }
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
      groups = r[0].groups || [];
      members = (r[0].members || []).map(function (m) { return { group_id: m.group_id, code: m.code }; });
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
  async function detectAll(source) {
    var det = await getDetector();
    return (await det.detect(source)) || [];
  }
  async function detectIn(source) {
    var r = await detectAll(source);
    return r.length ? r[0] : null;
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
    clearOverlay();
    $('#scannerIdle').hidden = false;
    $('#camGuide').hidden = true;
    $('#camCtrl').hidden = true;
    $('#camHint').hidden = true;
    $('#btnCam').textContent = 'เปิดกล้อง';
  }
  function resumeCam() {
    if (camOn && paused) { paused = false; cam.since = Date.now(); clearOverlay(); $('#camGuide').classList.remove('hit'); scanLoop(); }
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
        var hits = await detectAll(frameCanvas);
        var map = { sx: sx, sy: sy, k: k, offX: (vw - visW) / 2, offY: (vh - visH) / 2, scale: scale };
        if (hits.length && camOn && !paused) {
          cam.since = Date.now();
          $('#camHint').hidden = true;
          if (batchMode || hits.length > 1) {
            // several codes, or batch mode: collect them all and keep the camera running
            var states = hits.map(function (h) { return batchAdd(h.rawValue, String(h.format || '').toUpperCase()); });
            drawHits(hits, map, states);
            if (!batchMode) { setMode('batch'); toast('พบ ' + hits.length + ' โค้ดในภาพ — เพิ่มเข้ารายการรอตรวจ'); }
          } else {
            paused = true;
            drawHits(hits, map, ['new']);
            $('#camGuide').classList.add('hit');
            handleRaw(hits[0].rawValue, String(hits[0].format || '').toUpperCase());
            return;
          }
        } else if (Date.now() - overlayAt > 500) clearOverlay();
      } catch (e) { /* keep scanning */ }
    }
    $('#camHint').hidden = Date.now() - cam.since < HINT_AFTER;
    cam.timer = setTimeout(scanLoop, batchMode ? 120 : 80);
  }

  // outline detected codes on top of the live video (green = just added, teal = already in the list)
  var overlay = $('#camOverlay'), overlayAt = 0;
  function clearOverlay() { var g = overlay.getContext('2d'); g.clearRect(0, 0, overlay.width, overlay.height); }
  function drawHits(hits, m, states) {
    var dpr = window.devicePixelRatio || 1, r = overlay.getBoundingClientRect();
    overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
    var g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    var pt = function (p) { return [(m.sx + p.x / m.k - m.offX) * m.scale, (m.sy + p.y / m.k - m.offY) * m.scale]; };
    hits.forEach(function (h, i) {
      var pts = h.cornerPoints && h.cornerPoints.length ? h.cornerPoints : [
        { x: h.boundingBox.x, y: h.boundingBox.y }, { x: h.boundingBox.x + h.boundingBox.width, y: h.boundingBox.y },
        { x: h.boundingBox.x + h.boundingBox.width, y: h.boundingBox.y + h.boundingBox.height }, { x: h.boundingBox.x, y: h.boundingBox.y + h.boundingBox.height }];
      var col = states[i] === 'new' || states[i] === 'count' ? '#22c55e' : '#2dd4bf';
      g.beginPath();
      pts.forEach(function (p, j) { var q = pt(p); if (j) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
      g.closePath();
      g.lineWidth = 3; g.strokeStyle = col; g.fillStyle = col + '33';
      g.fill(); g.stroke();
    });
    overlayAt = Date.now();
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
  // -> every distinct code; big and small codes can need different sizes, so the first two sizes are merged
  async function decodePhoto(f) {
    var bmp = await createImageBitmap(f);
    var longest = Math.max(bmp.width, bmp.height);
    var sizes = [Math.min(longest, 2000), longest, 1200].filter(function (v, i, a) {
      return v <= longest && a.slice(0, i).every(function (u) { return Math.abs(u - v) > v * 0.15; }); // skip near-duplicate sizes
    });
    var found = {}, list = [];
    for (var i = 0; i < sizes.length; i++) {
      if (i === 2 && list.length) break; // the small fallback size only when nothing was found yet
      var k = sizes[i] / longest;
      var src = k === 1 ? bmp : await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      (await detectAll(src)).forEach(function (h) { if (!found[h.rawValue]) { found[h.rawValue] = 1; list.push(h); } });
    }
    return list;
  }
  async function onPhotoPicked(e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (camOn) await stopCam();
    toast('กำลังอ่านรูป…');
    try { await getDetector(); } catch (err) { return toast(decoderError(err), true); }
    getOcr().catch(function () {}); // warm the OCR engine in parallel in case the code turns out unreadable
    try {
      var hits = await decodePhoto(f);
      if (hits.length > 1 || (hits.length && batchMode)) {
        var added = hits.map(function (h) { return batchAdd(h.rawValue, String(h.format || '').toUpperCase()); })
          .filter(function (x) { return x === 'new'; }).length;
        setMode('batch');
        toast('พบ ' + hits.length + ' โค้ดในรูป — เพิ่มใหม่ ' + added + ' รายการ');
        return;
      }
      if (hits.length) return handleRaw(hits[0].rawValue, String(hits[0].format || '').toUpperCase());
      // code unreadable → read the printed "(01)… (21)…" text on the label instead
      if (await ocrLabel(f)) return;
      throw new Error('none');
    } catch (err) {
      toast(err && err.message === 'none' ? 'ไม่พบ QR / บาร์โค้ดในรูปนี้ — ลองถ่ายให้โค้ดเต็มกรอบและไม่มีแสงสะท้อน' : 'อ่านรูปไม่ได้: ' + (err && err.message || err), true);
    }
  }
  $('#fileCam').addEventListener('change', onPhotoPicked);
  $('#fileImg').addEventListener('change', onPhotoPicked);

  /* ---------- OCR fallback: read the human-readable UDI text ---------- */
  // tesseract.js + LSTM core + English model are served from vendor/tesseract (≈7 MB, loaded on first use only)
  var ocrP = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src; el.onload = resolve; el.onerror = function () { reject(new Error('โหลด ' + src + ' ไม่ได้')); };
      document.head.appendChild(el);
    });
  }
  function getOcr() {
    if (!ocrP) {
      ocrP = (async function () {
        if (!window.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
        var base = new URL('vendor/tesseract/', location.href).href;
        var w = await Tesseract.createWorker('eng', 1, {
          workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', gzip: true, workerBlobURL: false,
          logger: function (m) {
            if (/load/.test(m.status) && m.progress < 1) toast('กำลังโหลดตัวอ่านตัวหนังสือ (ครั้งแรกเท่านั้น)…');
          }
        });
        await w.setParameters({ tessedit_char_whitelist: '0123456789()ABCDEFGHIJKLMNOPQRSTUVWXYZ-./ ', tessedit_pageseg_mode: '11' });
        return w;
      })();
      ocrP.catch(function () { ocrP = null; });
    }
    return ocrP;
  }
  // scale (small photos up, big ones down — tesseract likes ~2400 px) and rotate onto a white canvas
  function ocrCanvas(bmp, deg, target) {
    var s = Math.max(0.3, Math.min(2.2, target / Math.max(bmp.width, bmp.height)));
    var W = bmp.width * s, H = bmp.height * s, a = deg * Math.PI / 180;
    var cw = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a)), ch = Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a));
    var cv = document.createElement('canvas');
    cv.width = Math.round(cw); cv.height = Math.round(ch);
    var g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    g.imageSmoothingQuality = 'high';
    g.translate(cw / 2, ch / 2); g.rotate(a); g.drawImage(bmp, -W / 2, -H / 2, W, H);
    return cv;
  }
  // straight first, then tilted photos: stop as soon as GTIN checks out and a serial/lot is present
  // [page-seg mode, rotation°, longest side px] — a quick pass first, bigger/rotated ones only when needed
  var OCR_PASSES = [['11', 0, 1600], ['3', 0, 2400], ['3', 12, 2400], ['3', -12, 2400], ['3', 20, 2400], ['3', -20, 2400]];
  // good enough when the GTIN passes its own check digit (plus serial/lot), or — if it only snapped to a known
  // product — when the serial/lot also matches a stock row exactly; otherwise keep trying more passes
  function ocrGood(fields) {
    if (R.hriComplete(fields)) return true;
    var res = R.parseHri(R.hriString(fields), { types: products, items: items });
    var g = res.checks['01'];
    return !!(g && g.status === 'fixed' && res.suggestions.length && res.suggestions[0].dist === 0 && res.suggestions[0].sameType);
  }
  async function ocrRead(file) {
    var bmp = await createImageBitmap(file);
    var w = await getOcr();
    var texts = [], found = [];
    for (var i = 0; i < OCR_PASSES.length; i++) {
      toast('กำลังอ่านตัวหนังสือ… รอบ ' + (i + 1) + '/' + OCR_PASSES.length);
      await w.setParameters({ tessedit_pageseg_mode: OCR_PASSES[i][0] });
      var r = await w.recognize(ocrCanvas(bmp, OCR_PASSES[i][1], OCR_PASSES[i][2]));
      texts.push(r.data.text || '');
      found.push(R.parseHri(r.data.text, {}).fields);
      if (ocrGood(R.mergeHri(found))) break;
    }
    return { fields: R.mergeHri(found), text: texts.join('\n— — —\n') };
  }
  // -> true when handled (dialog shown or error reported), false when nothing usable was read
  async function ocrLabel(file) {
    toast('ไม่พบโค้ด — ลองอ่านตัวหนังสือบนฉลาก…');
    var o;
    try { o = await ocrRead(file); } catch (e) { toast('อ่านตัวหนังสือไม่ได้: ' + (e && e.message || e), true); return true; }
    var res = R.parseHri(R.hriString(o.fields), { types: products, items: items });
    if (!res.found) return false;
    await confirmOcr(res, o.text);
    return true;
  }

  var OCR_FIELDS = [['01', 'GTIN (01)'], ['240', 'REF (240)'], ['11', 'วันผลิต (11) YYMMDD'], ['17', 'วันหมดอายุ (17) YYMMDD'], ['10', 'Lot (10)'], ['21', 'Serial (21)']];
  var CHECK_BADGE = { ok: 'ok', fixed: 'warn', bad: 'bad', unverified: 'warn' };
  var CHECK_TH = { ok: '✓', fixed: 'แก้ให้แล้ว', bad: 'ผิด', unverified: 'ยังไม่ยืนยัน' };

  // nothing from OCR is used until the user ticks the box and presses "ใช้ค่านี้" (or picks a stock row)
  async function confirmOcr(res, text) {
    var html = '<h3>อ่านจากตัวหนังสือบนฉลาก</h3>' +
      '<p class="small" style="margin:0">⚠️ ค่าเหล่านี้มาจากการอ่านตัวหนังสือ (OCR) อาจผิดได้ — ตรวจกับฉลากทีละช่องก่อนใช้</p>' +
      OCR_FIELDS.map(function (f) {
        var ck = res.checks[f[0]];
        if (!res.fields[f[0]] && ['17', '10'].indexOf(f[0]) >= 0) return ''; // optional fields the label did not have
        var badge = ck ? ' <span class="badge ' + CHECK_BADGE[ck.status] + '">' + CHECK_TH[ck.status] + '</span>' : '';
        var note = ck && ck.note ? '<span class="small muted">' + esc(ck.note) + '</span>' : '';
        return '<label>' + esc(f[1]) + badge + '<input name="f' + f[0] + '" value="' + esc(res.fields[f[0]] || '') + '" autocapitalize="characters" spellcheck="false">' + note + '</label>';
      }).join('') +
      (res.suggestions.length ? '<div class="section-label">ใกล้เคียงในคลัง — กดเพื่อใช้รายการนั้น</div><ul class="sub-list">' + res.suggestions.map(function (sg) {
        var it = sg.item, p = byType[it.type_code];
        return '<li><button class="btn small" style="width:100%;justify-content:space-between" value="sug:' + esc(it.code) + '" formnovalidate><span>' +
          esc(it.serial ? 'SN ' + it.serial : 'LOT ' + it.lot) + ' · ' + esc((p && p.name) || it.type_code) + '</span><span class="muted">' +
          (sg.dist === 0 ? 'ตรงกัน' : 'ต่าง ' + sg.dist + ' ตัว') + '</span></button></li>';
      }).join('') + '</ul>' : '') +
      '<details><summary>ข้อความที่อ่านได้ทั้งหมด</summary><div class="raw" style="margin-top:8px">' + esc(text.trim()) + '</div></details>' +
      '<label class="check"><input type="checkbox" name="checked" required> ตรวจแล้ว ค่าตรงกับฉลาก</label>';
    var r = await dialog(html, [['ยกเลิก'], ['ใช้ค่านี้', 'primary', 'ok']]);
    if (r.btn.indexOf('sug:') === 0) {
      var it = byCode[r.btn.slice(4)];
      if (it) useOcrValues({ '01': it.type_code, '240': it.ref, '21': it.serial, '10': it.lot });
      return;
    }
    if (r.btn !== 'ok') return;
    var f = {};
    OCR_FIELDS.forEach(function (x) { var v = (r.data['f' + x[0]] || '').trim().toUpperCase(); if (v) f[x[0]] = v; });
    if (!f['01'] && !f['21'] && !f['10']) return toast('ไม่มีค่าให้ใช้', true);
    useOcrValues(f);
  }

  function useOcrValues(fields) {
    var raw = R.hriString(fields);
    if (batchMode) { batchAdd(raw, 'OCR', { ocr: true }); toast('เพิ่มเข้ารายการรอตรวจแล้ว'); return; }
    beep();
    lastRaw = { raw: raw, format: 'OCR' };
    current = parseCode(raw, 'OCR');
    current.ocr = true;
    go('scan');
    resolveCurrent(true);
  }

  $('#manualForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#manualInput').value;
    if (!v.trim()) return;
    $('#manualInput').value = '';
    if (batchMode && v.indexOf(SETUP_PREFIX) !== 0) { batchAdd(v, 'MANUAL'); return; }
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
      var r = await api('scan', { code: c.code, type_code: c.type, raw: (c.ocr ? '[OCR] ' : '') + c.raw, log: log !== false });
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
      (c.ocr ? '<p class="small" style="margin:0"><span class="badge warn">อ่านจากตัวหนังสือ (OCR)</span> ตรวจค่ากับฉลากก่อนกดบันทึก</p>' : '') +
      productHead(c.product, c.type) + idRows(c);

    if (c.status === 'ok' && c.item) {
      var it = c.item;
      h += '<div class="section-label">' + KIND_TH[kind] + '</div><dl class="kv">' +
        (kind !== 'serial' ? '<dt>จำนวน</dt><dd><div class="qty-row"><button class="btn" type="button" data-act="minus" aria-label="ลด">−</button><b>' + esc(it.qty === '' ? 0 : it.qty) + '</b><button class="btn" type="button" data-act="plus" aria-label="เพิ่ม">+</button><span>' + esc(it.unit || '') + '</span></div></dd>' : '') +
        (it.location ? '<dt>ที่เก็บ</dt><dd>' + esc(it.location) + '</dd>' : '') +
        (groupsOf(it.code).length ? '<dt>อยู่ในกลุ่ม</dt><dd class="chips">' + groupsOf(it.code).map(function (g) {
          return '<button type="button" class="chip chip-btn" data-act="group" data-gid="' + esc(g.group_id) + '">👥 ' + esc(g.name) +
            (g.place ? ' → ' + esc(g.place) : '') + '</button>' + (g.date ? ' ' + dueBadge(g.date) : '');
        }).join(' ') + '</dd>' : '') +
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
        batchRemove(c.code);
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
    else if (act === 'group') openGroup(b.dataset.gid);
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
  function dialog(html, buttons, onOpen) {
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
        form.querySelectorAll('[name]').forEach(function (i) {
          if (i.type === 'checkbox' && i.value !== 'on') { data[i.name] = data[i.name] || []; if (i.checked) data[i.name].push(i.value); return; }
          data[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'file' ? i.files[0] : i.value;
        });
        if (dlg.open) dlg.close(btn);
        resolve({ btn: btn, data: data });
      }
      function onSubmit(e) { e.preventDefault(); finish(e.submitter ? e.submitter.value : 'cancel'); }
      function onClose() { if (!dlg.open) finish('cancel'); } // ignore a late close event from the previous dialog
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      if (onOpen) onOpen(form);
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
      '<label>Note<textarea name="note" rows="4">' + esc(it.note) + '</textarea></label>' +
      (groupsOf(it.code).length ? '<div class="small">กลุ่ม: ' + groupsOf(it.code).map(function (g) { return '<span class="chip">' + esc(g.name) + '</span>'; }).join(' ') + '</div>' : '');
    var r = await dialog(html, [['ลบ', 'danger', 'del'], ['ประวัติ', '', 'hist'], ['คัดลอก', '', 'copy'], ['ยกเลิก'], ['บันทึก', 'primary', 'save']]);
    if (r.btn === 'hist') return openHistory(it.code);
    if (r.btn === 'copy') return copyText(itemLine(it, true));
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

  /* ---------- batch: scan many, check and save later (kept on this device) ---------- */
  var batchMode = !!store('batchMode');
  var batch = store('batch') || [];
  var RECOUNT_GAP = 2000; // a lot/type code must leave the view this long before it counts as another box

  function setMode(m) {
    batchMode = m === 'batch';
    store('batchMode', batchMode);
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.scanmode === m); });
    if (batchMode) { current = null; renderResult(); resumeCam(); }
    renderBatch();
  }
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.addEventListener('click', function () { setMode(b.dataset.scanmode); }); });

  function batchSave() { store('batch', batch.map(function (e) { var o = Object.assign({}, e); return o; })); renderBatch(); }
  function batchRemove(code) {
    var n = batch.length;
    batch = batch.filter(function (e) { return e.code !== code; });
    if (batch.length !== n) batchSave();
  }
  // -> 'new' | 'count' (another box of a lot) | 'seen' (already listed)
  function batchAdd(raw, format, extra) {
    var c = parseCode(raw, format);
    var code = R.itemKey(c.type, c.serial, c.lot);
    var now = Date.now();
    var e = batch.filter(function (x) { return x.code === code; })[0];
    if (e) {
      var gone = now - e.lastSeen > RECOUNT_GAP;
      e.lastSeen = now;
      if (!e.serial && gone && format !== 'MANUAL' || (!e.serial && format === 'MANUAL')) { e.count++; beep(); batchSave(); flashRow(code); return 'count'; }
      return 'seen';
    }
    batch.unshift({
      code: code, type: c.type, serial: c.serial, lot: c.lot, ref: c.ref, mfg_date: c.mfg_date, exp_date: c.exp_date,
      fields: c.fields, raw: raw, format: format, ocr: !!(extra && extra.ocr), count: 1, ts: now, lastSeen: now,
      qty: '', unit: '', location: '', note: ''
    });
    beep();
    batchSave();
    flashRow(code);
    return 'new';
  }
  function flashRow(code) {
    var li = document.querySelector('#batchList li[data-code="' + (window.CSS && CSS.escape ? CSS.escape(code) : code) + '"]');
    if (li) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
  }
  function rowStatus(e) { return byCode[e.code] ? 'ok' : byType[e.type] ? 'known' : 'new'; }
  var ROW_CHIP = { ok: '<span class="badge ok">มีในคลังแล้ว</span>', known: '<span class="badge warn">ชิ้นใหม่ · รู้จักรุ่น</span>', new: '<span class="badge bad">รุ่นใหม่</span>' };

  function renderBatch() {
    var n = batch.length;
    $('#batchCount').textContent = n; $('#batchCount').hidden = !n;
    $('#batchPanel').hidden = !batchMode && !n;
    if ($('#batchPanel').hidden) return;
    $('#batchN').textContent = n ? '(' + n + ')' : '';
    var st = { ok: 0, known: 0, new: 0 };
    batch.forEach(function (e) { st[rowStatus(e)]++; });
    var newTypes = {};
    batch.forEach(function (e) { if (!byType[e.type]) newTypes[e.type] = 1; });
    $('#batchSummary').textContent = n ? 'มีในคลังแล้ว ' + st.ok + ' · ชิ้นใหม่ ' + (st.known + st.new) + (Object.keys(newTypes).length ? ' (รุ่นใหม่ ' + Object.keys(newTypes).length + ' รุ่น ต้องตั้งชื่อตอนบันทึก)' : '')
      : (camOn ? 'สแกนไปเรื่อยๆ ได้เลย — แต่ละโค้ดจะเข้ารายการนี้ (ไม่ซ้ำ)' : 'เปิดกล้องหรือถ่ายรูป แล้วสแกนไปเรื่อยๆ — แต่ละโค้ดจะเข้ารายการนี้');
    $('#btnBatchSave').disabled = !n; $('#btnBatchClear').disabled = !n;
    var tg = batchGroup && groups.filter(function (g) { return g.group_id === batchGroup; })[0];
    if (batchGroup && !tg) batchGroup = '';
    $('#btnBatchGroup').innerHTML = tg ? '👥 ' + esc(tg.name) : '👥 ใส่กลุ่ม';
    $('#btnBatchGroup').classList.toggle('primary', !!tg);
    $('#batchList').innerHTML = batch.map(function (e) {
      var p = byType[e.type], s = rowStatus(e);
      var id = e.serial ? 'SN ' + e.serial : e.lot ? 'LOT ' + e.lot : e.type;
      var extra = [e.location, e.note].filter(Boolean).join(' · ');
      return '<li class="batch-row" data-code="' + esc(e.code) + '">' + thumb(p) +
        '<div class="main" data-b="open"><div class="t">' + esc((p && p.name) || e.type) + '</div>' +
        '<div class="s">' + esc(id) + (extra ? ' · ' + esc(extra) : '') + '</div>' +
        '<div class="chips">' + ROW_CHIP[s] + (e.ocr ? '<span class="badge warn">OCR</span>' : '') + (e.exp_date ? expBadge(e.exp_date) : '') +
        groupsOf(e.code).map(function (g) { return '<span class="chip">👥 ' + esc(g.name) + '</span>'; }).join('') + '</div></div>' +
        (e.serial ? '' : '<div class="qty">×' + esc(e.qty || e.count) + '</div>') +
        '<div class="acts"><button class="btn" type="button" data-b="edit" aria-label="แก้รายชิ้น">✎</button><button class="btn" type="button" data-b="del" aria-label="เอาออก">×</button></div></li>';
    }).join('') || '';
  }

  $('#batchList').addEventListener('click', async function (ev) {
    var t = ev.target.closest('[data-b]'); if (!t) return;
    var code = t.closest('li').dataset.code;
    var e = batch.filter(function (x) { return x.code === code; })[0];
    if (!e) return;
    if (t.dataset.b === 'del') { batchRemove(code); return; }
    if (t.dataset.b === 'open') {
      // look at / register this one on its own
      setMode('single');
      current = parseCode(e.raw, e.format);
      current.ocr = e.ocr;
      resolveCurrent(false);
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    var r = await dialog('<h3>แก้รายชิ้น</h3><p class="small muted" style="margin:0">' + esc(e.serial ? 'SN ' + e.serial : e.lot ? 'LOT ' + e.lot : e.type) + '</p>' +
      (e.serial ? '' : '<div class="grid2"><label>จำนวน<input name="qty" type="number" step="any" inputmode="decimal" value="' + esc(e.qty || e.count) + '"></label>' +
        '<label>หน่วย<input name="unit" value="' + esc(e.unit) + '"></label></div>') +
      '<label>ที่เก็บ (ว่าง = ใช้ค่ารวมตอนบันทึก)<input name="location" list="dlLocation" value="' + esc(e.location) + '"></label>' +
      '<label>Note<textarea name="note" rows="2">' + esc(e.note) + '</textarea></label>', [['ยกเลิก'], ['ตกลง', 'primary', 'ok']]);
    if (r.btn !== 'ok') return;
    if (!e.serial) { e.qty = r.data.qty; e.unit = r.data.unit; }
    e.location = r.data.location.trim(); e.note = r.data.note.trim();
    batchSave();
  });

  $('#btnBatchClear').addEventListener('click', async function () {
    if (!batch.length) return;
    if (!(await confirmBox('ล้างรายการรอตรวจทั้งหมด ' + batch.length + ' รายการ? (ยังไม่ได้บันทึกเข้าคลัง)', 'ล้าง'))) return;
    batch = []; batchSave();
  });

  var batchGroup = store('batchGroup') || '';
  function setBatchGroup(id) { batchGroup = id || ''; store('batchGroup', batchGroup); renderBatch(); }
  $('#btnBatchGroup').addEventListener('click', async function () {
    var r = await chooseGroup('ใส่ทุกรายการที่บันทึกเข้ากลุ่ม', batchGroup, true);
    if (!r) return;
    if (r.clear) return setBatchGroup('');
    if (r.group_id) return setBatchGroup(r.group_id);
    try { var g = await createGroup(r.newGroup); setBatchGroup(g.group_id); toast('สร้างกลุ่ม "' + g.name + '" แล้ว — กดบันทึกทั้งหมดเพื่อใส่รายการ'); }
    catch (e) { toast(errText(e), true); }
  });

  $('#btnBatchSave').addEventListener('click', async function () {
    var btn = this;
    if (!batch.length) return;
    if (!cfg.url) return toast(ERR_TH.no_config, true);
    var newTypes = {};
    batch.forEach(function (e) { if (!byType[e.type]) (newTypes[e.type] = newTypes[e.type] || []).push(e); });
    var types = Object.keys(newTypes);
    var st = { ok: 0, fresh: 0 };
    batch.forEach(function (e) { if (rowStatus(e) === 'ok') st.ok++; else st.fresh++; });
    var html = '<h3>บันทึก ' + batch.length + ' รายการ</h3>' +
      '<p class="small" style="margin:0">ชิ้นใหม่ ' + st.fresh + ' → ลงทะเบียนเข้าคลัง · มีในคลังแล้ว ' + st.ok + ' → บันทึกว่าตรวจนับแล้ว</p>' +
      '<label>ที่เก็บ (ใช้กับทุกชิ้นที่ยังไม่ได้ใส่)<input name="location" list="dlLocation" placeholder="เช่น คลังกลาง"></label>' +
      '<label>Note (ใช้กับทุกชิ้นที่ยังไม่ได้ใส่)<textarea name="note" rows="2"></textarea></label>' +
      types.map(function (t, i) {
        var ref = newTypes[t].map(function (e) { return e.ref; }).filter(Boolean)[0] || '';
        return '<fieldset class="card" style="box-shadow:none"><b>รุ่นใหม่ ' + esc(t) + (ref ? ' · REF ' + esc(ref) : '') + ' · ' + newTypes[t].length + ' ชิ้น</b>' +
          '<label>ชื่อสินค้า *<input name="pn' + i + '" required></label>' +
          '<div class="grid2"><label>หมวดหมู่<input name="pc' + i + '" list="dlCategory"></label><label>ยี่ห้อ / ผู้ผลิต<input name="pb' + i + '" list="dlBrand"></label></div></fieldset>';
      }).join('') +
      (batch.some(function (e) { return e.ocr; }) ? '<p class="small" style="margin:0"><span class="badge warn">OCR</span> บางรายการอ่านจากตัวหนังสือ — ตรวจแล้วตอนเพิ่มเข้ารายการ</p>' : '') +
      groupPickerHtml(batchGroup, 'ใส่ทุกรายการเข้ากลุ่ม');
    var r = await dialog(html, [['ยกเลิก'], ['บันทึกทั้งหมด', 'primary', 'ok']], wireGroupPicker);
    if (r.btn !== 'ok') return;
    var d = r.data;
    var newProducts = types.map(function (t, i) {
      return { type_code: t, name: d['pn' + i], category: d['pc' + i], brand: d['pb' + i], ref: newTypes[t].map(function (e) { return e.ref; }).filter(Boolean)[0] || '' };
    });
    var entries = batch.map(function (e) {
      return {
        code: e.code, type_code: e.type, serial: e.serial, lot: e.lot, ref: e.ref || (byType[e.type] && byType[e.type].ref) || '',
        mfg_date: e.mfg_date, exp_date: e.exp_date, fields: e.fields ? JSON.stringify(e.fields) : '', format: e.ocr ? 'OCR' : e.format,
        raw_sample: e.raw, qty: e.serial ? 1 : (e.qty || e.count), unit: e.serial ? '' : e.unit,
        location: e.location || d.location.trim(), note: e.note || d.note.trim()
      };
    });
    await busy(btn, async function () {
      var made = 0, checked = 0, failed = 0, gid = '';
      try {
        gid = await groupFromPicker(d);
        for (var i = 0; i < entries.length; i += 40) {
          toast('กำลังบันทึก… ' + Math.min(i + 40, entries.length) + '/' + entries.length);
          var res = await api('saveBatch', { products: i === 0 ? newProducts : [], entries: entries.slice(i, i + 40), group_id: gid });
          (res.products || []).forEach(putProduct);
          addMembers(res.members);
          res.results.forEach(function (x) {
            if (x.status === 'created' || x.status === 'exists') { if (x.item) putItem(x.item); batchRemove(x.code); }
            if (x.status === 'created') made++; else if (x.status === 'exists') checked++; else if (x.status !== 'duplicate') failed++;
          });
        }
        if (gid) setBatchGroup('');
        saveLocal();
        var gname = gid ? (groups.filter(function (g) { return g.group_id === gid; })[0] || {}).name : '';
        toast('บันทึกแล้ว: ใหม่ ' + made + ' · ตรวจนับ ' + checked + (gname ? ' · เข้ากลุ่ม "' + gname + '"' : '') + (failed ? ' · ผิดพลาด ' + failed : ''), !!failed);
      } catch (err) { toast(errText(err) + ' — รายการที่ยังไม่บันทึกยังอยู่ในรายการ', true); }
    });
  });

  /* ---------- stock: filters, sort, multi-select, groups, copy ---------- */
  function fillDatalists() {
    var uniq = function (arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }).sort(); };
    var opt = function (v) { return '<option value="' + esc(v) + '">'; };
    $('#dlCategory').innerHTML = uniq(products.map(function (p) { return p.category; })).map(opt).join('');
    $('#dlBrand').innerHTML = uniq(products.map(function (p) { return p.brand; })).map(opt).join('');
    $('#dlLocation').innerHTML = uniq(items.map(function (i) { return i.location; })).map(opt).join('');
    $('#dlPlace').innerHTML = uniq(groups.map(function (g) { return g.place; })).map(opt).join('');
  }

  /* text for LINE / email: "1. Battery Pack EU5094 SN 12756806M001" */
  function itemId(it) { return it.serial ? 'SN ' + it.serial : it.lot ? 'LOT ' + it.lot : it.type_code; }
  function itemName(it) { var p = byType[it.type_code]; return (p && p.name) || it.type_code; }
  function itemLine(it, detailed) {
    var name = itemName(it), ref = it.ref || (byType[it.type_code] || {}).ref || '';
    var parts = [name];
    if (ref && name.indexOf(ref) < 0) parts.push(ref);
    parts.push(itemId(it));
    if (!it.serial && it.qty !== '' && it.qty != null) parts.push('× ' + it.qty + (it.unit ? ' ' + it.unit : ''));
    var line = parts.join(' ');
    if (detailed) {
      var more = [];
      if (it.mfg_date) more.push('ผลิต ' + fmtDay(it.mfg_date));
      if (it.exp_date) more.push('หมดอายุ ' + fmtDay(it.exp_date));
      if (it.location) more.push(it.location);
      if (it.note) more.push(it.note.replace(/\s*\n\s*/g, ' / '));
      if (more.length) line += ' · ' + more.join(' · ');
    }
    return line;
  }
  function listText(list, g) {
    var head = g ? g.name + (g.place ? ' → ' + g.place : '') + (g.date ? ' · ' + fmtDay(g.date) : '') + '\n' : '';
    return head + list.map(function (it, i) { return (i + 1) + '. ' + itemLine(it); }).join('\n') + '\nรวม ' + list.length + ' รายการ';
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว'); return; } catch (e) { /* fall back to a selectable box */ }
    await dialog('<h3>คัดลอกข้อความ</h3><p class="small muted" style="margin:0">กดค้างในกล่องแล้วเลือก "คัดลอก"</p><textarea id="copyBox" rows="10" readonly>' + esc(text) + '</textarea>',
      [['ปิด']], function () { var t = $('#copyBox'); t.focus(); t.select(); });
  }
  function exportCsv(list, name) {
    var cols = ['type_code', 'name', 'category', 'brand', 'ref', 'serial', 'lot', 'mfg_date', 'exp_date', 'qty', 'unit', 'location', 'note', 'groups', 'created_at', 'updated_at', 'scan_count', 'last_scan'];
    var cell = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var csv = '﻿' + cols.join(',') + '\n' + list.map(function (it) {
      var p = byType[it.type_code] || {};
      var row = Object.assign({}, it, { name: p.name, category: p.category, brand: p.brand, ref: it.ref || p.ref, groups: groupsOf(it.code).map(function (g) { return g.name; }).join(' | ') });
      return cols.map(function (k) { return cell(row[k]); }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = (name || 'qr-stock') + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* dates */
  function daysTo(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) return null;
    var end = m[3] ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(+m[1], +m[2], 0);
    return Math.floor((end - new Date().setHours(0, 0, 0, 0)) / 864e5);
  }
  function dueBadge(date) {
    var d = daysTo(date);
    if (d === null) return '';
    if (d < 0) return '<span class="badge bad">เลยกำหนด ' + (-d) + ' วัน</span>';
    if (d === 0) return '<span class="badge warn">วันนี้</span>';
    if (d <= 3) return '<span class="badge warn">อีก ' + d + ' วัน</span>';
    return '<span class="badge ok">' + fmtDay(date) + '</span>';
  }

  /* filters + sort (remembered per device) */
  var filt = store('filt') || {};
  var SORTS = {
    items: {
      updated: ['แก้ไขล่าสุด', function (a, b) { return cmpDesc(a.updated_at, b.updated_at); }],
      created: ['ลงทะเบียนล่าสุด', function (a, b) { return cmpDesc(a.created_at, b.created_at); }],
      name: ['ชื่อ ก→ฮ / A→Z', function (a, b) { return itemName(a).localeCompare(itemName(b), 'th') || nat(itemId(a), itemId(b)); }],
      sn: ['SN / Lot', function (a, b) { return nat(itemId(a), itemId(b)); }],
      mfg_desc: ['วันผลิต ใหม่→เก่า', function (a, b) { return cmpDesc(a.mfg_date, b.mfg_date); }],
      mfg_asc: ['วันผลิต เก่า→ใหม่', function (a, b) { return cmpAsc(a.mfg_date, b.mfg_date); }],
      exp: ['หมดอายุก่อน', function (a, b) { return cmpAsc(a.exp_date, b.exp_date); }],
      scan: ['สแกนล่าสุด', function (a, b) { return cmpDesc(a.last_scan, b.last_scan); }],
      location: ['ที่เก็บ', function (a, b) { return cmpAsc(a.location, b.location) || nat(itemId(a), itemId(b)); }]
    },
    products: {
      name: ['ชื่อ ก→ฮ / A→Z', function (a, b) { return String(a.name).localeCompare(String(b.name), 'th'); }],
      count: ['จำนวนมาก→น้อย', function (a, b) { return unitsOf(b.type_code).length - unitsOf(a.type_code).length; }],
      category: ['หมวดหมู่', function (a, b) { return cmpAsc(a.category, b.category) || String(a.name).localeCompare(String(b.name), 'th'); }]
    },
    groups: {
      date: ['วันที่ใกล้สุด', function (a, b) { return cmpAsc(a.date, b.date) || String(a.name).localeCompare(String(b.name), 'th'); }],
      updated: ['แก้ไขล่าสุด', function (a, b) { return cmpDesc(a.updated_at, b.updated_at); }],
      name: ['ชื่อ', function (a, b) { return String(a.name).localeCompare(String(b.name), 'th'); }]
    }
  };
  var sortBy = store('sortBy') || { items: 'updated', products: 'name', groups: 'date' };
  // empty values always sink to the bottom
  function cmpAsc(a, b) { a = a || ''; b = b || ''; if (!a !== !b) return a ? -1 : 1; return String(a).localeCompare(String(b), 'th', { numeric: true }); }
  function cmpDesc(a, b) { a = a || ''; b = b || ''; if (!a !== !b) return a ? -1 : 1; return String(b).localeCompare(String(a), 'th', { numeric: true }); }
  function nat(a, b) { return String(a).localeCompare(String(b), 'en', { numeric: true }); }

  var FILTER_TH = { category: 'หมวดหมู่', type: 'รุ่น', location: 'ที่เก็บ', group: 'กลุ่ม', kind: 'ชนิด', exp: 'วันหมดอายุ' };
  var KIND_OPT = { serial: 'รายเครื่อง (SN)', lot: 'ตามล็อต', type: 'ตามประเภท' };
  var EXP_OPT = { soon: 'ใกล้หมดอายุ (≤ 90 วัน)', expired: 'หมดอายุแล้ว', none: 'ไม่มีวันหมดอายุ' };
  function filterLabel(k, v) {
    if (k === 'type') return (byType[v] || {}).name || v;
    if (k === 'group') return (groups.filter(function (g) { return g.group_id === v; })[0] || {}).name || v;
    if (k === 'kind') return KIND_OPT[v];
    if (k === 'exp') return EXP_OPT[v];
    if (k === 'location' && v === '__none') return '(ไม่ระบุ)';
    return v;
  }
  function passFilter(it) {
    var p = byType[it.type_code] || {};
    if (filt.category && p.category !== filt.category) return false;
    if (filt.type && it.type_code !== filt.type) return false;
    if (filt.location && (filt.location === '__none' ? it.location : it.location !== filt.location)) return false;
    if (filt.group && !members.some(function (m) { return m.group_id === filt.group && m.code === it.code; })) return false;
    if (filt.kind && kindOf(it) !== filt.kind) return false;
    if (filt.exp) {
      var d = daysTo(it.exp_date);
      if (filt.exp === 'soon' && !(d !== null && d >= 0 && d <= 90)) return false;
      if (filt.exp === 'expired' && !(d !== null && d < 0)) return false;
      if (filt.exp === 'none' && it.exp_date) return false;
    }
    return true;
  }
  function setFilter(k, v) { if (v) filt[k] = v; else delete filt[k]; store('filt', filt); renderStock(); }

  async function openFilters() {
    var uniq = function (arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }).sort(function (a, b) { return String(a).localeCompare(String(b), 'th'); }); };
    var sel = function (name, opts, cur) {
      return '<select name="' + name + '"><option value="">ทั้งหมด</option>' + opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    };
    var html = '<h3>ตัวกรอง</h3>' +
      '<label>หมวดหมู่' + sel('category', uniq(products.map(function (p) { return p.category; })).map(function (c) { return [c, c]; }), filt.category) + '</label>' +
      '<label>รุ่น / ประเภทสินค้า' + sel('type', products.slice().sort(SORTS.products.name[1]).map(function (p) { return [p.type_code, (p.name || p.type_code) + (p.ref ? ' · ' + p.ref : '')]; }), filt.type) + '</label>' +
      '<label>ที่เก็บ' + sel('location', uniq(items.map(function (i) { return i.location; })).map(function (l) { return [l, l]; }).concat([['__none', '(ไม่ระบุ)']]), filt.location) + '</label>' +
      '<label>กลุ่ม' + sel('group', groups.slice().sort(SORTS.groups.date[1]).map(function (g) { return [g.group_id, g.name]; }), filt.group) + '</label>' +
      '<div class="grid2"><label>ชนิด' + sel('kind', Object.keys(KIND_OPT).map(function (k) { return [k, KIND_OPT[k]]; }), filt.kind) + '</label>' +
      '<label>วันหมดอายุ' + sel('exp', Object.keys(EXP_OPT).map(function (k) { return [k, EXP_OPT[k]]; }), filt.exp) + '</label></div>';
    var r = await dialog(html, [['ล้างทั้งหมด', '', 'clear'], ['ยกเลิก'], ['ใช้ตัวกรอง', 'primary', 'ok']]);
    if (r.btn === 'clear') filt = {};
    else if (r.btn === 'ok') { filt = {}; Object.keys(FILTER_TH).forEach(function (k) { if (r.data[k]) filt[k] = r.data[k]; }); }
    else return;
    store('filt', filt);
    if (stockMode === 'groups') setStockMode('items'); else renderStock();
  }

  /* multi-select (item rows) */
  var selectMode = false, selected = {};
  // in the order shown on screen (current sort), so copied lists match what the user sees
  function selectedItems() {
    var shown = lastList.filter(function (it) { return selected[it.code]; });
    return shown.concat(items.filter(function (it) { return selected[it.code] && shown.indexOf(it) < 0; }));
  }
  function setSelectMode(on) {
    selectMode = on; selected = {};
    document.body.classList.toggle('selecting', on);
    $('#btnSelect').textContent = on ? 'ยกเลิกเลือก' : 'เลือก';
    renderStock();
  }
  function renderSelBar() {
    var n = Object.keys(selected).length;
    $('#selBar').hidden = !selectMode;
    $('#selN').textContent = 'เลือก ' + n + ' รายการ';
    document.querySelectorAll('#selBar [data-sa]').forEach(function (b) { b.disabled = !n; });
  }

  var lastList = [];
  function renderStock() {
    var mode = stockMode;
    document.querySelectorAll('#stockSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
    var q = ($('#stockSearch').value || '').trim().toLowerCase();
    var hit = function (arr) { return !q || arr.join(' ').toLowerCase().indexOf(q) >= 0; };
    var sorts = SORTS[mode], cur = sorts[sortBy[mode]] ? sortBy[mode] : Object.keys(sorts)[0];
    $('#sortSel').innerHTML = Object.keys(sorts).map(function (k) { return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>เรียง: ' + esc(sorts[k][0]) + '</option>'; }).join('');
    $('#btnFilter').hidden = mode === 'groups';
    $('#btnSelect').hidden = mode !== 'items';
    $('#btnNewGroup').hidden = mode !== 'groups';
    $('#btnAddManual').hidden = mode === 'groups';
    var nf = mode === 'groups' ? 0 : Object.keys(filt).length;
    $('#filterCount').textContent = nf; $('#filterCount').hidden = !nf;
    $('#activeFilters').innerHTML = nf ? Object.keys(filt).map(function (k) {
      return '<button type="button" class="fchip" data-clear="' + k + '">' + esc(FILTER_TH[k]) + ': ' + esc(filterLabel(k, filt[k])) + ' ✕</button>';
    }).join('') : '';
    renderSummary();
    var html = '', count = '';
    if (mode === 'products') {
      var plist = products.filter(function (p) { return (!filt.category || p.category === filt.category) && hit([p.type_code, p.name, p.ref, p.category, p.brand, p.note]); })
        .sort(sorts[cur][1]);
      html = plist.map(function (p) {
        var n = unitsOf(p.type_code).length;
        return '<li class="tap" data-type="' + esc(p.type_code) + '">' + thumb(p) + '<div class="main"><div class="t">' + esc(p.name || '(ไม่มีชื่อ)') + '</div>' +
          '<div class="s">' + esc([p.ref, p.category, p.brand].filter(Boolean).join(' · ') || p.type_code) + '</div></div>' +
          '<div class="qty">' + (n ? esc(totalOf(p.type_code)) : '<span class="muted small">ไม่มีของ</span>') + '</div></li>';
      }).join('');
      count = 'ประเภทสินค้า ' + products.length + ' รายการ' + (q || filt.category ? ' · พบ ' + plist.length : '');
    } else if (mode === 'groups') {
      var glist = groups.filter(function (g) { return hit([g.name, g.place, g.note]); }).sort(sorts[cur][1]);
      html = glist.map(function (g) {
        var n = membersOf(g.group_id).length;
        return '<li class="tap" data-group="' + esc(g.group_id) + '"><div class="thumb">👥</div><div class="main"><div class="t">' + esc(g.name) + '</div>' +
          '<div class="s">' + esc([g.place ? '→ ' + g.place : '', g.note].filter(Boolean).join(' · ') || '—') + '</div>' +
          (g.date ? '<div class="chips">' + dueBadge(g.date) + '</div>' : '') + '</div><div class="qty">' + n + '</div></li>';
      }).join('');
      count = 'กลุ่ม ' + groups.length + (q ? ' · พบ ' + glist.length : '');
    } else {
      var list = items.filter(function (it) {
        var p = byType[it.type_code] || {};
        return passFilter(it) && hit([it.code, it.serial, it.lot, it.ref, it.location, it.note, p.name, p.category, p.brand]);
      }).sort(sorts[cur][1]);
      lastList = list;
      html = list.map(function (it) {
        var p = byType[it.type_code], gs = groupsOf(it.code);
        return '<li class="tap' + (selected[it.code] ? ' selected' : '') + '" data-code="' + esc(it.code) + '">' +
          (selectMode ? '<span class="sel-box" aria-hidden="true">' + (selected[it.code] ? '✓' : '') + '</span>' : '') + thumb(p) +
          '<div class="main"><div class="t">' + esc((p && p.name) || it.type_code) + '</div>' +
          '<div class="s">' + esc([itemId(it), it.location, it.note].filter(Boolean).join(' · ')) + '</div>' +
          ((it.exp_date || gs.length) ? '<div class="chips">' + (it.exp_date ? expBadge(it.exp_date) : '') +
            gs.map(function (g) { return '<span class="chip">👥 ' + esc(g.name) + '</span>'; }).join('') + '</div>' : '') + '</div>' +
          (it.serial ? '' : '<div class="qty">' + esc(it.qty) + ' ' + esc(it.unit || '') + '</div>') + '</li>';
      }).join('');
      count = 'ในคลัง ' + items.length + ' รายการ' + (q || nf ? ' · พบ ' + list.length : '');
    }
    $('#stockCount').textContent = count;
    var empty = mode === 'groups' ? (groups.length ? 'ไม่พบกลุ่มที่ค้นหา' : 'ยังไม่มีกลุ่ม — กด "+ สร้างกลุ่ม"')
      : (mode === 'products' ? products : items).length ? 'ไม่พบรายการที่ตรงกับคำค้น/ตัวกรอง' : 'ยังไม่มีข้อมูล — ไปสแกนเพื่อลงทะเบียน';
    $('#stockList').innerHTML = html || '<li class="empty">' + empty + '</li>';
    renderSelBar();
  }

  function renderSummary() {
    var soon = 0, expired = 0;
    items.forEach(function (it) { var d = daysTo(it.exp_date); if (d !== null) { if (d < 0) expired++; else if (d <= 90) soon++; } });
    var due = groups.filter(function (g) { var d = daysTo(g.date); return d !== null && d <= 0; }).length;
    $('#stockSummary').innerHTML =
      '<button type="button" class="sum" data-sum="all"><b>' + items.length + '</b><span>ในคลัง</span></button>' +
      '<button type="button" class="sum' + (soon ? ' warn' : '') + '" data-sum="soon"><b>' + soon + '</b><span>ใกล้หมดอายุ</span></button>' +
      '<button type="button" class="sum' + (expired ? ' bad' : '') + '" data-sum="expired"><b>' + expired + '</b><span>หมดอายุแล้ว</span></button>' +
      '<button type="button" class="sum' + (due ? ' warn' : '') + '" data-sum="groups"><b>' + groups.length + '</b><span>กลุ่ม' + (due ? ' · ถึงกำหนด ' + due : '') + '</span></button>';
  }
  $('#stockSummary').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sum]'); if (!b) return;
    var k = b.dataset.sum;
    if (k === 'groups') return setStockMode('groups');
    filt = k === 'all' ? {} : { exp: k };
    store('filt', filt);
    sortBy.items = k === 'all' ? sortBy.items : 'exp'; store('sortBy', sortBy);
    setStockMode('items');
  });

  function setStockMode(m) {
    stockMode = m; store('stockMode', m);
    if (m !== 'items' && selectMode) setSelectMode(false); else renderStock();
  }
  document.querySelectorAll('#stockSeg button').forEach(function (b) { b.addEventListener('click', function () { setStockMode(b.dataset.mode); }); });
  $('#stockSearch').addEventListener('input', renderStock);
  $('#sortSel').addEventListener('change', function () { sortBy[stockMode] = this.value; store('sortBy', sortBy); renderStock(); });
  $('#btnFilter').addEventListener('click', openFilters);
  $('#activeFilters').addEventListener('click', function (e) { var b = e.target.closest('[data-clear]'); if (b) setFilter(b.dataset.clear, ''); });
  $('#btnSelect').addEventListener('click', function () { setSelectMode(!selectMode); });
  $('#btnSelDone').addEventListener('click', function () { setSelectMode(false); });
  $('#btnSelAll').addEventListener('click', function () {
    var all = lastList.length && lastList.every(function (it) { return selected[it.code]; });
    lastList.forEach(function (it) { if (all) delete selected[it.code]; else selected[it.code] = true; });
    renderStock();
  });
  $('#stockList').addEventListener('click', function (e) {
    var li = e.target.closest('li.tap');
    if (!li) return;
    if (li.dataset.group) return openGroup(li.dataset.group);
    if (li.dataset.type) return openProduct(byType[li.dataset.type]);
    if (selectMode) {
      var c = li.dataset.code;
      if (selected[c]) delete selected[c]; else selected[c] = true;
      return renderStock();
    }
    openItem(byCode[li.dataset.code]);
  });
  $('#btnRefresh').addEventListener('click', function () { var b = this; busy(b, function () { return syncAll(false); }); });
  $('#btnAddManual').addEventListener('click', function () { recode(true); });
  $('#btnExport').addEventListener('click', function () {
    if (stockMode === 'items') exportCsv(lastList, Object.keys(filt).length ? 'qr-stock-filtered' : 'qr-stock');
    else exportCsv(items, 'qr-stock');
  });
  $('#btnNewGroup').addEventListener('click', async function () {
    var g = await editGroup(null);
    if (g) openGroup(g.group_id);
  });

  /* bulk actions on the selection */
  $('#selBar').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-sa]'); if (!b) return;
    var list = selectedItems(), codes = list.map(function (it) { return it.code; });
    if (!list.length) return;
    var act = b.dataset.sa;
    if (act === 'copy') return copyText(listText(list));
    if (act === 'csv') return exportCsv(list, 'qr-stock-selected');
    if (act === 'group') {
      var r = await chooseGroup('ใส่ ' + list.length + ' รายการเข้ากลุ่ม', '', false);
      if (!r) return;
      await busy(b, async function () {
        try {
          if (r.newGroup) { r.newGroup.codes = codes; var g = await createGroup(r.newGroup); toast('สร้างกลุ่ม "' + g.name + '" พร้อม ' + list.length + ' รายการ'); }
          else {
            var res = await api('groupAdd', { group_id: r.group_id, codes: codes });
            addMembers(res.members); saveLocal();
            toast('เพิ่มเข้ากลุ่มแล้ว ' + res.members.length + ' รายการ' + (res.members.length < list.length ? ' (ที่เหลืออยู่ในกลุ่มแล้ว)' : ''));
          }
          setSelectMode(false);
        } catch (err) { toast(errText(err), true); }
      });
      return;
    }
    if (act === 'edit') {
      var ed = await dialog('<h3>แก้ไข ' + list.length + ' รายการพร้อมกัน</h3><p class="small muted" style="margin:0">ช่องที่เว้นว่าง = ไม่เปลี่ยน</p>' +
        '<label>ที่เก็บ<input name="location" list="dlLocation"></label>' +
        '<label>หน่วย (เฉพาะรายการที่นับจำนวน)<input name="unit"></label>' +
        '<label>Note<textarea name="note" rows="3"></textarea></label>' +
        '<label class="check"><input type="checkbox" name="replace"> แทนที่ note เดิม (ไม่ติ๊ก = ต่อท้าย)</label>', [['ยกเลิก'], ['บันทึก', 'primary', 'ok']]);
      if (ed.btn !== 'ok') return;
      var set = {};
      if (ed.data.location.trim()) set.location = ed.data.location.trim();
      if (ed.data.unit.trim()) set.unit = ed.data.unit.trim();
      if (ed.data.note.trim()) set.note = ed.data.note.trim();
      if (!Object.keys(set).length) return toast('ไม่ได้ใส่ค่าที่จะแก้', true);
      await busy(b, async function () {
        try {
          var res = await api('bulkUpdate', { codes: codes, set: set, noteMode: ed.data.replace ? 'replace' : 'append' });
          res.items.forEach(putItem);
          toast('แก้ไขแล้ว ' + res.items.length + ' รายการ');
          setSelectMode(false);
        } catch (err) { toast(errText(err), true); }
      });
      return;
    }
    if (act === 'del') {
      if (!(await confirmBox('ลบ ' + list.length + ' รายการออกจากคลัง? (ประวัติยังอยู่ใน Sheet)', 'ลบ'))) return;
      await busy(b, async function () {
        try {
          await api('removeItems', { codes: codes });
          items = items.filter(function (it) { return !selected[it.code]; });
          members = members.filter(function (m) { return codes.indexOf(m.code) < 0; });
          saveLocal();
          toast('ลบแล้ว ' + list.length + ' รายการ');
          setSelectMode(false);
        } catch (err) { toast(errText(err), true); }
      });
    }
  });

  /* ---------- groups ---------- */
  function groupFields(g) {
    g = g || {};
    return '<label>ชื่อกลุ่ม *<input name="gname" required value="' + esc(g.name) + '" placeholder="เช่น ส่ง OR 2 วันพุธ"></label>' +
      '<div class="grid2"><label>ส่งไป / ใช้ที่<input name="gplace" list="dlPlace" value="' + esc(g.place) + '"></label>' +
      '<label>วันที่<input name="gdate" type="date" value="' + esc(g.date) + '"></label></div>' +
      '<label>Note<textarea name="gnote" rows="2">' + esc(g.note) + '</textarea></label>';
  }
  async function createGroup(g) {
    var res = await api('saveGroup', { group: { name: g.name, place: g.place, date: g.date, note: g.note }, codes: g.codes || [] });
    groups.push(res.group);
    addMembers(res.members);
    saveLocal();
    return res.group;
  }
  // create (g = null) or edit; -> saved group or null
  async function editGroup(g) {
    var r = await dialog('<h3>' + (g ? 'แก้ไขกลุ่ม' : 'สร้างกลุ่ม') + '</h3>' + groupFields(g), [['ยกเลิก'], [g ? 'บันทึก' : 'สร้างกลุ่ม', 'primary', 'ok']]);
    if (r.btn !== 'ok') return null;
    var d = { name: r.data.gname.trim(), place: r.data.gplace.trim(), date: r.data.gdate, note: r.data.gnote };
    try {
      if (!g) { var made = await createGroup(d); toast('สร้างกลุ่มแล้ว'); return made; }
      var res = await api('saveGroup', { group: Object.assign({ group_id: g.group_id }, d) });
      groups = groups.map(function (x) { return x.group_id === g.group_id ? res.group : x; });
      saveLocal();
      toast('บันทึกแล้ว');
      return res.group;
    } catch (e) { toast(errText(e), true); return null; }
  }
  // "choose a group or make a new one" block used by batch save, bulk add and the batch chip
  function groupPickerHtml(cur, label) {
    var opts = groups.slice().sort(SORTS.groups.date[1]).map(function (g) {
      return '<option value="' + esc(g.group_id) + '"' + (g.group_id === cur ? ' selected' : '') + '>' + esc(g.name + (g.place ? ' → ' + g.place : '')) + '</option>';
    }).join('');
    return '<fieldset class="card" style="box-shadow:none"><b>' + esc(label || 'กลุ่ม') + '</b>' +
      '<select name="gsel"><option value="">— ไม่ใส่กลุ่ม —</option>' + opts + '<option value="__new">+ สร้างกลุ่มใหม่…</option></select>' +
      '<div data-newgroup hidden>' + groupFields(null) + '</div></fieldset>';
  }
  function wireGroupPicker(form) {
    var sel = form.querySelector('[name=gsel]'), box = form.querySelector('[data-newgroup]');
    if (!sel) return;
    var sync = function () { var on = sel.value === '__new'; box.hidden = !on; form.querySelector('[name=gname]').required = on; };
    sel.addEventListener('change', sync); sync();
  }
  async function groupFromPicker(d) {
    if (d.gsel === '__new') return (await createGroup({ name: d.gname.trim(), place: d.gplace.trim(), date: d.gdate, note: d.gnote })).group_id;
    return d.gsel || '';
  }
  // -> {group_id} | {newGroup} | {clear} | null
  async function chooseGroup(title, cur, allowClear) {
    var btns = [['ยกเลิก']];
    if (allowClear && cur) btns.push(['ไม่ใส่กลุ่ม', '', 'clear']);
    btns.push(['ตกลง', 'primary', 'ok']);
    var r = await dialog('<h3>' + esc(title) + '</h3>' + groupPickerHtml(cur, 'เลือกกลุ่ม'), btns, wireGroupPicker);
    if (r.btn === 'clear') return { clear: true };
    if (r.btn !== 'ok') return null;
    if (r.data.gsel === '__new') return { newGroup: { name: r.data.gname.trim(), place: r.data.gplace.trim(), date: r.data.gdate, note: r.data.gnote } };
    if (!r.data.gsel) return allowClear ? { clear: true } : null;
    return { group_id: r.data.gsel };
  }

  // search the stock and tick items to add
  async function pickItems(title, exclude) {
    var pool = items.filter(function (it) { return !exclude[it.code]; }).sort(SORTS.items.name[1]);
    if (!pool.length) { toast('ไม่มีรายการอื่นในคลังให้เพิ่ม', true); return []; }
    var html = '<h3>' + esc(title) + '</h3><input id="pickQ" type="search" placeholder="ค้นหา ชื่อ SN Lot REF ที่เก็บ" autocomplete="off">' +
      '<div class="toolbar"><button type="button" class="btn small" id="pickAll">เลือกทั้งหมดที่แสดง</button><span class="small muted" id="pickN"></span></div>' +
      '<ul class="pick-list">' + pool.map(function (it) {
        var key = [itemName(it), itemId(it), it.ref, it.location, it.note, it.type_code].join(' ').toLowerCase();
        return '<li data-k="' + esc(key) + '"><label class="check"><input type="checkbox" name="pick" value="' + esc(it.code) + '"> <span>' + esc(itemLine(it)) +
          (it.location ? ' <span class="muted small">· ' + esc(it.location) + '</span>' : '') + '</span></label></li>';
      }).join('') + '</ul>';
    var r = await dialog(html, [['ยกเลิก'], ['เพิ่มที่เลือก', 'primary', 'ok']], function (form) {
      var q = $('#pickQ');
      var count = function () { $('#pickN').textContent = 'เลือก ' + form.querySelectorAll('[name=pick]:checked').length; };
      q.addEventListener('input', function () {
        var v = q.value.trim().toLowerCase();
        form.querySelectorAll('.pick-list li').forEach(function (li) { li.hidden = v && li.dataset.k.indexOf(v) < 0; });
      });
      $('#pickAll').addEventListener('click', function () {
        form.querySelectorAll('.pick-list li:not([hidden]) input').forEach(function (i) { i.checked = true; });
        count();
      });
      form.addEventListener('change', count);
      count();
    });
    return r.btn === 'ok' ? (r.data.pick || []) : [];
  }

  async function openGroup(gid) {
    for (;;) {
      var g = groups.filter(function (x) { return x.group_id === gid; })[0];
      if (!g) return;
      var list = membersOf(gid).sort(SORTS.items.name[1]);
      var html = '<h3>👥 ' + esc(g.name) + '</h3>' +
        '<p class="small" style="margin:0">' + [g.place ? 'ส่งไป / ใช้ที่ <b>' + esc(g.place) + '</b>' : '', g.date ? dueBadge(g.date) : '', list.length + ' รายการ'].filter(Boolean).join(' · ') + '</p>' +
        (g.note ? '<div class="note-box">' + esc(g.note) + '</div>' : '') +
        '<div class="row-start">' +
        '<button class="btn small" value="copy" formnovalidate' + (list.length ? '' : ' disabled') + '>📋 คัดลอกรายการ</button>' +
        '<button class="btn small" value="pick" formnovalidate>🔎 เพิ่มจากคลัง</button>' +
        '<button class="btn small" value="scan" formnovalidate>📷 สแกนเข้ากลุ่ม</button></div>' +
        (list.length ? '<ol class="group-list">' + list.map(function (it, i) {
          return '<li><span class="num">' + (i + 1) + '.</span><button class="linkish" value="open:' + esc(it.code) + '" formnovalidate>' + esc(itemLine(it)) +
            (it.location ? ' <span class="muted small">· ' + esc(it.location) + '</span>' : '') + '</button>' +
            '<button class="btn small" value="rm:' + esc(it.code) + '" formnovalidate aria-label="เอาออกจากกลุ่ม">✕</button></li>';
        }).join('') + '</ol>' : '<p class="muted">ยังไม่มีรายการ — กด "เพิ่มจากคลัง" หรือ "สแกนเข้ากลุ่ม"</p>');
      var r = await dialog(html, [['ลบกลุ่ม', 'danger', 'delg'], ['แก้ไข', '', 'edit'], ['CSV', '', 'csv'], ['ปิด']]);
      var b = r.btn;
      if (b === 'copy') { await copyText(listText(list, g)); continue; }
      if (b === 'csv') { exportCsv(list, 'group-' + g.name.replace(/[^\w฀-๿-]+/g, '_')); continue; }
      if (b === 'edit') { await editGroup(g); continue; }
      if (b === 'scan') { setBatchGroup(gid); setMode('batch'); go('scan'); toast('สแกนได้เลย — กด "บันทึกทั้งหมด" แล้วรายการจะเข้ากลุ่ม "' + g.name + '"'); return; }
      if (b === 'pick') {
        var ex = {}; list.forEach(function (it) { ex[it.code] = 1; });
        var codes = await pickItems('เพิ่มเข้ากลุ่ม "' + g.name + '"', ex);
        if (codes.length) {
          try { var res = await api('groupAdd', { group_id: gid, codes: codes }); addMembers(res.members); saveLocal(); toast('เพิ่มแล้ว ' + res.members.length + ' รายการ'); }
          catch (e) { toast(errText(e), true); }
        }
        continue;
      }
      if (b.indexOf('rm:') === 0) {
        var code = b.slice(3);
        try { await api('groupRemove', { group_id: gid, codes: [code] }); members = members.filter(function (m) { return !(m.group_id === gid && m.code === code); }); saveLocal(); toast('เอาออกจากกลุ่มแล้ว'); }
        catch (e) { toast(errText(e), true); }
        continue;
      }
      if (b.indexOf('open:') === 0) { await openItem(byCode[b.slice(5)]); continue; }
      if (b === 'delg') {
        if (await confirmBox('ลบกลุ่ม "' + g.name + '"? (ของในคลังไม่ถูกลบ)', 'ลบกลุ่ม')) {
          try { await api('removeGroup', { group_id: gid }); groups = groups.filter(function (x) { return x.group_id !== gid; }); members = members.filter(function (m) { return m.group_id !== gid; }); saveLocal(); toast('ลบกลุ่มแล้ว'); }
          catch (e) { toast(errText(e), true); }
          return;
        }
        continue;
      }
      return;
    }
  }

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
  window.__qrsBatchReady = true;
  setMode(batchMode ? 'batch' : 'single');
  fillSettings();
  fillDatalists();
  renderStock();
  renderRules();
  if (cfg.url && cfg.key) syncAll(true); else setConn(null);
  if (opts.autoCam) startCam();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
