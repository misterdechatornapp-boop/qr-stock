/* QR Stock — rule engine + content inspector (pure functions, no DOM) */
(function (root) {
  'use strict';

  /* ---------- GS1 ---------- */
  // AI -> [name, fixed length or 0 (variable), max length for variable]
  var GS1_AI = {
    '00': ['SSCC', 18], '01': ['GTIN', 14], '02': ['GTIN สินค้าภายใน', 14],
    '10': ['Lot/Batch', 0, 20], '11': ['วันผลิต', 6], '12': ['วันครบกำหนดชำระ', 6], '13': ['วันบรรจุ', 6],
    '15': ['ควรบริโภคก่อน', 6], '16': ['วันขายก่อน', 6], '17': ['วันหมดอายุ', 6], '20': ['Variant', 2],
    '21': ['Serial', 0, 20], '22': ['CPV', 0, 20], '235': ['TPX', 0, 28], '240': ['Additional ID', 0, 30],
    '241': ['Customer part no.', 0, 30], '242': ['MTO variant', 0, 6], '250': ['Secondary serial', 0, 30],
    '251': ['Ref. to source', 0, 30], '30': ['จำนวน (Count)', 0, 8], '37': ['จำนวนหน่วย', 0, 8],
    '400': ['PO ลูกค้า', 0, 30], '401': ['GINC', 0, 30], '403': ['Routing code', 0, 30],
    '410': ['Ship to GLN', 13], '411': ['Bill to GLN', 13], '412': ['Purchased from GLN', 13],
    '413': ['Ship for GLN', 13], '414': ['Location GLN', 13], '415': ['Invoicing party GLN', 13],
    '420': ['Ship to postal', 0, 20], '422': ['Country of origin', 3],
    '7003': ['Expiry date+time', 10], '7240': ['Protocol ID', 0, 20],
    '8004': ['GIAI', 0, 30], '8005': ['Price per unit', 6], '8020': ['Payment slip ref', 0, 25],
    '90': ['Internal', 0, 30], '91': ['Internal', 0, 90], '92': ['Internal', 0, 90], '93': ['Internal', 0, 90],
    '94': ['Internal', 0, 90], '95': ['Internal', 0, 90], '96': ['Internal', 0, 90], '97': ['Internal', 0, 90],
    '98': ['Internal', 0, 90], '99': ['Internal', 0, 90]
  };
  // 4-digit measure AIs: 31nn–36nn (6 digits, nn = unit/decimals)
  function lookupAI(s, i) {
    var a4 = s.substr(i, 4);
    if (/^3[1-6]\d\d$/.test(a4)) return { ai: a4, def: ['ค่าวัด (' + a4 + ')', 6] };
    if (/^39[0-3]\d$/.test(a4)) return { ai: a4, def: ['ราคา/จำนวนเงิน', 0, 15] };
    if (GS1_AI[a4]) return { ai: a4, def: GS1_AI[a4] };
    var a3 = s.substr(i, 3);
    if (GS1_AI[a3]) return { ai: a3, def: GS1_AI[a3] };
    var a2 = s.substr(i, 2);
    if (GS1_AI[a2]) return { ai: a2, def: GS1_AI[a2] };
    return null;
  }

  // GS1 character set 82; anything else inside an element string is treated as an FNC1 separator
  var SEP_RE = /[^!"%&'()*+,\-./0-9:;<=>?A-Z_a-z]/;
  function isSep(ch) { return SEP_RE.test(ch); }
  function stripSymbology(raw) { return String(raw).replace(/^\](C1|e0|d2|Q3|J1)/, ''); }

  // returns {fields:[{ai,name,value}], ok:boolean} or null if it does not look like GS1
  function parseGS1(raw) {
    var s = stripSymbology(raw).trim();
    if (!s) return null;
    // Digital Link: https://host/01/0950.../10/ABC?17=...
    var dl = s.match(/^https?:\/\/[^/]+(\/.*)$/i);
    if (dl) {
      var parts = dl[1].split('?')[0].split('/').filter(Boolean);
      var at = parts.indexOf('01');
      if (at < 0) at = parts.indexOf('00');
      if (at < 0) return null;
      var f = [];
      for (var k = at; k + 1 < parts.length; k += 2) {
        var d = GS1_AI[parts[k]] || lookupAI(parts[k], 0) && lookupAI(parts[k], 0).def;
        f.push({ ai: parts[k], name: d ? d[0] : 'AI ' + parts[k], value: decodeURIComponent(parts[k + 1]) });
      }
      var q = (dl[1].split('?')[1] || '').split('&');
      q.forEach(function (kv) {
        var p = kv.split('=');
        if (p.length === 2 && /^\d{2,4}$/.test(p[0])) {
          var d2 = GS1_AI[p[0]];
          f.push({ ai: p[0], name: d2 ? d2[0] : 'AI ' + p[0], value: decodeURIComponent(p[1]) });
        }
      });
      return f.length ? { fields: f, ok: true, digitalLink: true } : null;
    }
    // Human readable: (01)09501101530003(17)250101(10)ABC
    if (/^\(\d{2,4}\)/.test(s)) {
      var fields = [];
      var re = /\((\d{2,4})\)([^(]*)/g, m;
      while ((m = re.exec(s))) {
        var dd = GS1_AI[m[1]] || (lookupAI(m[1], 0) || {}).def;
        fields.push({ ai: m[1], name: dd ? dd[0] : 'AI ' + m[1], value: m[2].trim() });
      }
      return fields.length ? { fields: fields, ok: true } : null;
    }
    // Raw element string. FNC1 normally arrives as GS (\u001d), but some scanners/phones turn it into
    // another char (seen: "Ï") — so any char outside GS1 character set 82 counts as a separator.
    if (!/^\d{2}/.test(s)) return null;
    // strong signal = symbology id or a real GS; a substitute separator still needs the structure check below
    var hadPrefix = /^\](C1|e0|d2|Q3|J1)/.test(String(raw)) || s.indexOf('\u001d') >= 0;
    var out = [], i = 0;
    while (i < s.length) {
      if (isSep(s[i])) { i++; continue; }
      var hit = lookupAI(s, i);
      if (!hit) return out.length ? { fields: out, ok: false, rest: s.slice(i) } : null;
      i += hit.ai.length;
      var val;
      if (hit.def[1]) { val = s.substr(i, hit.def[1]); i += hit.def[1]; }
      else {
        var end = i;
        while (end < s.length && end < i + hit.def[2] && !isSep(s[end])) end++;
        val = s.slice(i, end);
        i = end;
      }
      out.push({ ai: hit.ai, name: hit.def[0], value: val });
    }
    if (!out.length) return null;
    // without ]C1 / FNC1, plain numbers can "parse" by accident — demand a clean, checkable structure
    if (!hadPrefix && (out.length < 2 || !/^0[012]$/.test(out[0].ai) || !fieldsValid(out))) return null;
    return { fields: out, ok: true };
  }

  function fieldsValid(fields) {
    return fields.every(function (f) {
      if (!f.value) return false;
      if (/^(00|01|02)$/.test(f.ai)) return mod10Valid(f.value);
      if (/^1[1-7]$/.test(f.ai)) return /^\d\d(0[1-9]|1[0-2])(0\d|[12]\d|3[01])$/.test(f.value);
      return true;
    });
  }

  function gs1Value(raw, ai) {
    var g = parseGS1(raw);
    if (!g) return '';
    for (var i = 0; i < g.fields.length; i++) if (g.fields[i].ai === ai) return g.fields[i].value;
    return '';
  }

  function fmtYYMMDD(v) {
    if (!/^\d{6}$/.test(v)) return v;
    var y = 2000 + Number(v.slice(0, 2)), mo = v.slice(2, 4), d = v.slice(4, 6);
    return (d === '00' ? '' : d + '/') + mo + '/' + y;
  }

  /* ---------- checksums ---------- */
  function gtinValid(digits) {
    return /^\d{8}$|^\d{12,14}$/.test(digits) && mod10Valid(digits);
  }
  function mod10Valid(digits) {
    if (!/^\d{2,}$/.test(digits)) return false;
    var sum = 0, n = digits.length;
    for (var i = 0; i < n - 1; i++) {
      var w = ((n - 1 - i) % 2 === 1) ? 3 : 1;
      sum += Number(digits[i]) * w;
    }
    return (10 - (sum % 10)) % 10 === Number(digits[n - 1]);
  }

  function gs1Country(digits) {
    var d = digits.length === 14 ? digits.slice(1) : digits.length === 12 ? '0' + digits : digits;
    var p = Number(d.slice(0, 3));
    if (p === 885) return 'ไทย';
    if (p <= 19 || (p >= 30 && p <= 39) || (p >= 60 && p <= 139)) return 'สหรัฐฯ/แคนาดา';
    if (p >= 450 && p <= 459 || p >= 490 && p <= 499) return 'ญี่ปุ่น';
    if (p >= 690 && p <= 699) return 'จีน';
    if (p >= 880 && p <= 881) return 'เกาหลีใต้';
    if (p === 888) return 'สิงคโปร์';
    if (p === 899) return 'อินโดนีเซีย';
    if (p === 955) return 'มาเลเซีย';
    if (p === 893) return 'เวียดนาม';
    if (p >= 400 && p <= 440) return 'เยอรมนี';
    if (p >= 300 && p <= 379) return 'ฝรั่งเศส';
    if (p >= 500 && p <= 509) return 'สหราชอาณาจักร';
    if (p >= 930 && p <= 939) return 'ออสเตรเลีย';
    if (p >= 890 && p <= 890) return 'อินเดีย';
    if (p >= 200 && p <= 299) return 'รหัสใช้ภายในร้าน';
    return '';
  }

  /* ---------- what is this? ---------- */
  function inspect(raw, format) {
    var s = String(raw || '');
    var t = s.trim();
    var info = { kind: 'text', label: 'ข้อความ', details: [] };
    var fmt = String(format || '').toUpperCase();
    var g = parseGS1(s);

    if (/^0002010102/.test(t) || /^000201/.test(t) && /6304[0-9A-F]{4}$/i.test(t)) {
      info.kind = 'emv'; info.label = 'QR ชำระเงิน (EMVCo / PromptPay)';
      if (/A000000677010111/.test(t)) info.details.push(['ประเภท', 'PromptPay']);
      var amt = t.match(/54(\d{2})([\d.]+)/);
      if (amt) info.details.push(['จำนวนเงิน (ถ้ามี)', amt[2].slice(0, Number(amt[1]))]);
      return info;
    }
    if (g) {
      info.kind = 'gs1'; info.label = g.digitalLink ? 'GS1 Digital Link' : 'GS1 (ข้อมูลสินค้ามาตรฐาน)';
      g.fields.forEach(function (f) {
        var v = /^(11|12|13|15|16|17)$/.test(f.ai) ? fmtYYMMDD(f.value) + '  (' + f.value + ')' : f.value;
        info.details.push(['(' + f.ai + ') ' + f.name, v]);
      });
      if (!g.ok) info.details.push(['ส่วนที่อ่านไม่ออก', g.rest]);
      return info;
    }
    if (/^\d+$/.test(t) && (t.length === 8 || t.length === 12 || t.length === 13 || t.length === 14)) {
      var names = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' };
      var ok = gtinValid(t);
      info.kind = 'gtin'; info.label = 'บาร์โค้ดสินค้า ' + names[t.length];
      info.details.push(['เลขตรวจสอบ (check digit)', ok ? 'ถูกต้อง ✓' : 'ไม่ตรง — อาจเป็นรหัสภายใน']);
      if (ok) { var c = gs1Country(t); if (c) info.details.push(['ประเทศที่ลงทะเบียน GS1', c]); }
      return info;
    }
    if (/^https?:\/\//i.test(t)) {
      info.kind = 'url'; info.label = 'ลิงก์เว็บ (URL)';
      try {
        var u = new URL(t);
        info.details.push(['โดเมน', u.hostname]);
        if (u.pathname && u.pathname !== '/') info.details.push(['path', u.pathname]);
        u.searchParams.forEach(function (v, k) { info.details.push(['?' + k, v]); });
      } catch (e) { /* keep label */ }
      return info;
    }
    if (/^WIFI:/i.test(t)) {
      info.kind = 'wifi'; info.label = 'QR Wi-Fi';
      var ss = t.match(/S:([^;]*)/); if (ss) info.details.push(['ชื่อ Wi-Fi', ss[1]]);
      return info;
    }
    if (/^BEGIN:VCARD/i.test(t)) { info.kind = 'vcard'; info.label = 'นามบัตร (vCard)'; return info; }
    if (/^(mailto:|tel:|sms:|geo:)/i.test(t)) { info.kind = 'uri'; info.label = 'ลิงก์ ' + t.split(':')[0]; return info; }
    if (/^\s*[{[]/.test(t)) {
      try { var j = JSON.parse(t); info.kind = 'json'; info.label = 'ข้อมูล JSON';
        if (j && typeof j === 'object' && !Array.isArray(j)) Object.keys(j).slice(0, 12).forEach(function (k) { info.details.push([k, typeof j[k] === 'object' ? JSON.stringify(j[k]) : String(j[k])]); });
        return info;
      } catch (e) { /* not json */ }
    }
    if (/[|;,\t]/.test(t) && t.length < 400) {
      var del = ['|', ';', '\t', ','].filter(function (d) { return t.indexOf(d) >= 0; })[0];
      info.kind = 'delimited'; info.label = 'ข้อความหลายช่อง (คั่นด้วย ' + (del === '\t' ? 'Tab' : del) + ')';
      t.split(del).forEach(function (p, i) { info.details.push(['ช่องที่ ' + (i + 1), p]); });
      return info;
    }
    if (/^[A-Z0-9\-_.\/]+$/i.test(t)) { info.kind = 'code'; info.label = 'รหัส (ตัวอักษร/ตัวเลข)'; }
    if (fmt) info.details.push(['ชนิดโค้ด', fmt]);
    return info;
  }

  /* ---------- rules ---------- */
  // rule: {id,name,enabled,match:{type,value,format}, extract:{type,...}, post:{trim,upper,stripZeros,prefix,suffix,maxLen}}
  function matches(rule, raw, format) {
    var m = rule.match || { type: 'any' };
    var s = String(raw);
    if (m.format && String(format || '').toUpperCase().indexOf(String(m.format).toUpperCase()) < 0) return false;
    switch (m.type) {
      case 'contains': return s.indexOf(m.value || '') >= 0;
      case 'startsWith': return s.indexOf(m.value || '') === 0;
      case 'regex': try { return new RegExp(m.value || '', 'i').test(s); } catch (e) { return false; }
      case 'gs1': return !!parseGS1(s);
      case 'url': return /^https?:\/\//i.test(s.trim());
      case 'digits': return /^\d+$/.test(s.trim()) && (!m.value || s.trim().length === Number(m.value));
      default: return true;
    }
  }

  function extract(rule, raw) {
    var x = rule.extract || { type: 'whole' };
    var s = String(raw);
    switch (x.type) {
      case 'regex': {
        try {
          var mm = new RegExp(x.pattern || '', x.flags || '').exec(s);
          if (!mm) return '';
          var gi = x.group === undefined || x.group === '' ? (mm.length > 1 ? 1 : 0) : Number(x.group);
          return mm[gi] || '';
        } catch (e) { return ''; }
      }
      case 'split': {
        var parts = s.split(x.delimiter === '\\t' ? '\t' : (x.delimiter || '|'));
        var idx = Number(x.index || 1);
        var p = idx < 0 ? parts[parts.length + idx] : parts[idx - 1];
        return p === undefined ? '' : p;
      }
      case 'substring': {
        var start = Math.max(0, Number(x.start || 1) - 1);
        return x.length ? s.substr(start, Number(x.length)) : s.slice(start);
      }
      case 'between': {
        var a = s.indexOf(x.after || '');
        if (x.after && a < 0) return '';
        var from = x.after ? a + x.after.length : 0;
        var b = x.before ? s.indexOf(x.before, from) : -1;
        return b < 0 ? s.slice(from) : s.slice(from, b);
      }
      case 'urlParam': {
        try { return new URL(s.trim()).searchParams.get(x.param || 'id') || ''; } catch (e) { return ''; }
      }
      case 'urlPath': {
        try {
          var segs = new URL(s.trim()).pathname.split('/').filter(Boolean);
          var n = Number(x.index || -1);
          return (n < 0 ? segs[segs.length + n] : segs[n - 1]) || '';
        } catch (e) { return ''; }
      }
      case 'gs1': return gs1Value(s, x.ai || '01');
      case 'jsonKey': {
        try { var o = JSON.parse(s); return String((x.key || '').split('.').reduce(function (acc, k) { return acc == null ? acc : acc[k]; }, o) || ''); }
        catch (e) { return ''; }
      }
      default: return s;
    }
  }

  function post(rule, v) {
    var p = rule.post || {};
    v = String(v || '');
    if (p.trim !== false) v = v.trim();
    if (p.upper) v = v.toUpperCase();
    if (p.stripZeros) v = v.replace(/^0+(?=.)/, '');
    if (p.maxLen) v = v.slice(0, Number(p.maxLen));
    if (v && p.prefix) v = p.prefix + v;
    if (v && p.suffix) v = v + p.suffix;
    return v;
  }

  // what each rule fills in: the product type (GTIN), the individual unit (serial) or the lot
  var ROLES = ['type', 'serial', 'lot'];

  // first enabled rule per role that matches and yields a value
  // -> {type, serial, lot, used:{role: rule}, typeFromRule:boolean}
  function apply(rules, raw, format) {
    var out = { type: '', serial: '', lot: '', used: {} };
    (rules || []).forEach(function (r) {
      if (r.enabled === false) return;
      var role = r.role || 'type';
      if (out[role] || !matches(r, raw, format)) return;
      var v = post(r, extract(r, raw));
      if (v) { out[role] = v; out.used[role] = r; }
    });
    out.typeFromRule = !!out.type;
    if (!out.type) out.type = String(raw || '').trim(); // no rule → the whole code is the type
    return out;
  }

  // unique key of one stock row: per unit (serial), per lot, or per type
  function itemKey(type, serial, lot) {
    if (serial) return type + '|SN:' + serial;
    if (lot) return type + '|LOT:' + lot;
    return type;
  }

  // YYMMDD → YYYY-MM-DD (day 00 = whole month → YYYY-MM)
  function gs1Date(v) {
    if (!/^\d{6}$/.test(v || '')) return v || '';
    var y = '20' + v.slice(0, 2), m = v.slice(2, 4), d = v.slice(4, 6);
    return d === '00' ? y + '-' + m : y + '-' + m + '-' + d;
  }

  // extra GS1 facts kept on the stock row
  function gs1Extras(raw) {
    var g = parseGS1(raw);
    if (!g) return null;
    var map = {};
    g.fields.forEach(function (f) { map[f.ai] = f.value; });
    return { fields: map, ref: map['240'] || '', mfg_date: gs1Date(map['11']), exp_date: gs1Date(map['17'] || map['7003'] && map['7003'].slice(0, 6)) };
  }

  function defaultRules() {
    return [
      { id: 'r_gs1_type', name: 'GS1 (01) GTIN → ประเภทสินค้า', role: 'type', enabled: true, match: { type: 'gs1' }, extract: { type: 'gs1', ai: '01' }, post: {} },
      { id: 'r_gs1_sn', name: 'GS1 (21) Serial → รายเครื่อง', role: 'serial', enabled: true, match: { type: 'gs1' }, extract: { type: 'gs1', ai: '21' }, post: {} },
      { id: 'r_gs1_lot', name: 'GS1 (10) Lot → ล็อต', role: 'lot', enabled: true, match: { type: 'gs1' }, extract: { type: 'gs1', ai: '10' }, post: {} },
      { id: 'r_url_id', name: 'ลิงก์ที่มี ?id= → ประเภทสินค้า', role: 'type', enabled: false, match: { type: 'url' }, extract: { type: 'urlParam', param: 'id' }, post: {} }
    ];
  }

  var api = { parseGS1: parseGS1, inspect: inspect, apply: apply, matches: matches, extract: extract, post: post, gtinValid: gtinValid,
    defaultRules: defaultRules, itemKey: itemKey, gs1Extras: gs1Extras, gs1Date: gs1Date, ROLES: ROLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QRRules = api;
})(this);
