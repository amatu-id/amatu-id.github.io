/* Amatu — session, PIN guard and per-account sync shared by the portal and every app on amatu-id.github.io.
   Apps load it as the first script in <head>. It records every localStorage / IndexedDB write of the app,
   pushes the changes to the signed-in account and pulls other devices' changes. Values over 2 KB are stored as files
   in the Portal's Google Drive (Edge Function amatu-drive, 10 GB shared by the apps); Supabase keeps the index. */
(function () {
  'use strict';
  if (window.AMATU) return;

  const SB_URL = 'https://ieyqxmzztoxgpvwexbkj.supabase.co';
  const SB_KEY = 'sb_publishable_o-PQxhkJJ8FG4mHYTUqEBw_uXv9n-eG';
  const PORTAL = '/';
  const DRIVE_FN = SB_URL + '/functions/v1/amatu-drive/';
  const MAX_ROW = 25000000;     // bigger records stay on this device only
  const BATCH = 3000000;
  const isPortal = location.pathname === PORTAL || location.pathname === '/index.html';
  const APP = isPortal ? 'portal' : (location.pathname.split('/')[1] || 'portal').toLowerCase();   // repo = Drive folder (one shared 10 GB pool)

  // ---------- raw storage (never tracked) ----------
  const LS = window.localStorage;
  const SP = Storage.prototype;
  const raw = { get: SP.getItem, set: SP.setItem, del: SP.removeItem, clear: SP.clear };
  const lget = k => { try { return raw.get.call(LS, k); } catch { return null; } };
  const lset = (k, v) => { try { raw.set.call(LS, k, v); return true; } catch { return false; } };
  const ldel = k => { try { raw.del.call(LS, k); } catch { } };
  const jget = (k, d) => { try { const v = lget(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const jset = (k, v) => lset(k, JSON.stringify(v));
  const local = k => k.startsWith('pt.');           // device-only keys of the portal itself
  const lsKeys = () => { const a = []; try { for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k != null) a.push(k); } } catch { } return a; };

  // ---------- page transitions: same-origin navigations cross-fade instead of flashing an empty frame ----------
  // (Chrome / Safari cross-document View Transitions; the portal adds its own app-close zoom on top of this)
  const vt = document.createElement('style');
  vt.id = 'amatu-vt';
  vt.textContent = '@view-transition{navigation:auto}' +
    '::view-transition-group(root){animation-duration:.26s;animation-timing-function:cubic-bezier(.22,.9,.28,1)}' +
    '@media (prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}';
  (document.head || document.documentElement).appendChild(vt);

  const DEV = lget('pt.dev') || (() => { const d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); lset('pt.dev', d); return d; })();

  // ---------- session ----------
  const sess = () => jget('pt.sess', null);                         // {u, t, c}
  const owner = () => lget('pt.owner');                             // account whose app data lives on this device
  const idleMin = () => { const p = jget('amatu.portal', null), v = p && p.idle; return v === 0 ? Infinity : v || 15; };   // 0 = never lock
  function unlocked() {
    const s = sess(), k = jget('pt.unlock', null);
    return !!(s && k && k.u === s.u && owner() === s.u && Date.now() - k.at < idleMin() * 60000);
  }
  let lastTouch = 0;
  function touch() {
    const now = Date.now();
    if (now - lastTouch < 15000) return;
    lastTouch = now;
    const k = jget('pt.unlock', null), s = sess();
    if (k && s && k.u === s.u && now - k.at < idleMin() * 60000) jset('pt.unlock', { u: k.u, at: now });
  }

  async function rpc(fn, args) {
    const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    });
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { }
    if (!r.ok) { const e = new Error((j && j.message) || ('HTTP ' + r.status)); e.code = (j && j.message) || 'net'; throw e; }
    return j;
  }
  const tok = () => { const s = sess(); return s && s.t; };
  async function drive(route, body) {
    const r = await fetch(DRIVE_FN + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch { }
    if (!r.ok) { const e = new Error((j && j.error) || ('HTTP ' + r.status)); e.code = (j && j.error) || 'net'; throw e; }
    return j;
  }

  // ---------- value encoding (structured-clone values → JSON) ----------
  const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  async function enc(v) {
    if (v === undefined) return { $u: 1 };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
    if (typeof v === 'bigint') return { $bi: v.toString() };
    if (v instanceof Date) return { $d: v.getTime() };
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      const o = { $b: v.type, d: b64(await v.arrayBuffer()) };
      if (typeof File !== 'undefined' && v instanceof File) { o.n = v.name; o.m = v.lastModified; }
      return o;
    }
    if (v instanceof ArrayBuffer) return { $ab: b64(v) };
    if (ArrayBuffer.isView(v)) return { $ta: v.constructor.name, d: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (v instanceof Map) { const a = []; for (const [k, x] of v) a.push([await enc(k), await enc(x)]); return { $m: a }; }
    if (v instanceof Set) { const a = []; for (const x of v) a.push(await enc(x)); return { $s: a }; }
    if (v instanceof RegExp) return { $r: [v.source, v.flags] };
    if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) a[i] = await enc(v[i]); return a; }
    if (typeof v === 'object') {
      const o = {}; let tagged = false;
      for (const k of Object.keys(v)) { if (k[0] === '$') tagged = true; o[k] = await enc(v[k]); }
      return tagged ? { $o: o } : o;
    }
    return null;
  }
  function dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    if ('$u' in v) return undefined;
    if ('$n' in v) return Number(v.$n);
    if ('$bi' in v) return BigInt(v.$bi);
    if ('$d' in v) return new Date(v.$d);
    if ('$b' in v) { const buf = unb64(v.d); return v.n != null && typeof File !== 'undefined' ? new File([buf], v.n, { type: v.$b, lastModified: v.m }) : new Blob([buf], { type: v.$b }); }
    if ('$ab' in v) return unb64(v.$ab);
    if ('$ta' in v) { const C = window[v.$ta]; const buf = unb64(v.d); return C === DataView ? new DataView(buf) : C ? new C(buf) : new Uint8Array(buf); }
    if ('$m' in v) return new Map(v.$m.map(([k, x]) => [dec(k), dec(x)]));
    if ('$s' in v) return new Set(v.$s.map(dec));
    if ('$r' in v) return new RegExp(v.$r[0], v.$r[1]);
    const src = '$o' in v ? v.$o : v, o = {};
    for (const k of Object.keys(src)) o[k] = dec(src[k]);
    return o;
  }
  function encKey(k) {   // IndexedDB keys: number | string | Date | binary | array
    if (k instanceof Date) return { $d: k.getTime() };
    if (k instanceof ArrayBuffer) return { $ab: b64(k) };
    if (ArrayBuffer.isView(k)) return { $ta: k.constructor.name, d: b64(k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength)) };
    if (Array.isArray(k)) return k.map(encKey);
    return k;
  }
  const E = encodeURIComponent, D = decodeURIComponent;
  const idbK = (db, st, key) => 'idb|' + E(db) + '|' + E(st) + '|' + JSON.stringify(encKey(key));

  // ---------- change tracking ----------
  let dirty = jget('pt.dirty', {}), dseq = 0, dSaveT = 0, flushT = 0;
  for (const k in dirty) dseq = Math.max(dseq, dirty[k]);
  const tracking = () => { const s = sess(); return !!(s && owner() === s.u); };
  function mark(k) {
    if (!tracking()) return;
    dirty[k] = ++dseq;
    clearTimeout(dSaveT); dSaveT = setTimeout(() => jset('pt.dirty', dirty), 150);
    clearTimeout(flushT); flushT = setTimeout(() => flush().catch(() => { }), 1500);
  }
  SP.setItem = function (k, v) { const r = raw.set.call(this, k, v); if (this === LS && !local(String(k))) mark('ls:' + k); return r; };
  SP.removeItem = function (k) { const had = this === LS && raw.get.call(this, k) != null; raw.del.call(this, k); if (had && !local(String(k))) mark('ls:' + k); };
  SP.clear = function () {
    if (this !== LS) return raw.clear.call(this);
    for (const k of lsKeys()) if (!local(k)) raw.del.call(LS, k);   // keep the portal's own keys
    mark('lsall');
  };

  const IDB = {};
  if (typeof IDBObjectStore !== 'undefined') {
    const OS = IDBObjectStore.prototype, CU = IDBCursor.prototype, FA = IDBFactory.prototype;
    Object.assign(IDB, { put: OS.put, add: OS.add, del: OS.delete, clear: OS.clear, cupd: CU.update, cdel: CU.delete, open: FA.open, drop: FA.deleteDatabase });
    const where = st => [st.transaction.db.name, st.name];
    const ok = (req, f) => { try { req.addEventListener('success', f); } catch { } return req; };
    const markRec = (db, st, key) => { mark('idbschema|' + E(db)); mark(idbK(db, st, key)); };
    const markStore = (db, st) => { mark('idbschema|' + E(db)); mark('idbs|' + E(db) + '|' + E(st)); };
    OS.put = function () { const req = IDB.put.apply(this, arguments); const [db, st] = where(this); return ok(req, () => markRec(db, st, req.result)); };
    OS.add = function () { const req = IDB.add.apply(this, arguments); const [db, st] = where(this); return ok(req, () => markRec(db, st, req.result)); };
    OS.delete = function (q) {
      const req = IDB.del.apply(this, arguments); const [db, st] = where(this);
      return ok(req, () => (q instanceof IDBKeyRange ? markStore(db, st) : markRec(db, st, q)));
    };
    OS.clear = function () { const req = IDB.clear.apply(this, arguments); const [db, st] = where(this); return ok(req, () => markStore(db, st)); };
    const curStore = c => { const s = c.source; return s instanceof IDBIndex ? s.objectStore : s; };
    CU.update = function () { const req = IDB.cupd.apply(this, arguments); const s = curStore(this), pk = this.primaryKey, [db, st] = where(s); return ok(req, () => markRec(db, st, pk)); };
    CU.delete = function () { const req = IDB.cdel.apply(this, arguments); const s = curStore(this), pk = this.primaryKey, [db, st] = where(s); return ok(req, () => markRec(db, st, pk)); };
    FA.deleteDatabase = function (name) { const req = IDB.drop.apply(this, arguments); return ok(req, () => mark('idbdb|' + E(name))); };
  }

  // ---------- IndexedDB helpers (untracked) ----------
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function dbNames() { try { return (await indexedDB.databases()).map(d => d.name).filter(Boolean); } catch { return []; } }
  function openDb(name, version, upgrade) {
    return new Promise((res, rej) => {
      const r = version ? IDB.open.call(indexedDB, name, version) : IDB.open.call(indexedDB, name);
      r.onupgradeneeded = e => { try { upgrade && upgrade(r.result, r.transaction, e.oldVersion); } catch (err) { console.warn('[amatu] upgrade', err); } };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => setTimeout(() => rej(new Error('blocked')), 4000);
    });
  }
  function schemaOf(db) {
    const st = [];
    if (db.objectStoreNames.length) {
      const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
      for (const n of db.objectStoreNames) {
        const s = tx.objectStore(n), ix = [];
        for (const i of s.indexNames) { const x = s.index(i); ix.push({ n: i, kp: x.keyPath, u: x.unique, m: x.multiEntry }); }
        st.push({ n, kp: s.keyPath, ai: s.autoIncrement, ix });
      }
    }
    return { v: db.version, st };
  }
  async function storeRows(db, st) {     // [{key, value}] of a whole store
    return new Promise((res, rej) => {
      const out = [], tx = db.transaction(st, 'readonly'), r = tx.objectStore(st).openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { out.push({ key: c.primaryKey, value: c.value }); c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    });
  }

  // ---------- push ----------
  const cur = () => +(lget('pt.cur') || 0);
  const setCur = n => lset('pt.cur', String(n));
  let flushing = null;
  function flush() { return flushing || (flushing = doFlush().finally(() => { flushing = null; })); }
  async function doFlush() {
    const t = tok(); if (!t || !tracking()) return { pushed: 0 };
    const snap = Object.assign({}, dirty), keys = Object.keys(snap);
    if (!keys.length) return { pushed: 0 };
    const rows = [], big = jget('pt.big', {});
    const dbs = {};
    const getDb = async name => {
      if (!(name in dbs)) dbs[name] = (await dbNames()).includes(name) ? await openDb(name).catch(() => null) : null;
      return dbs[name];
    };
    const remoteKeys = async prefix => new Set(await rpc('amt_keys', { p_token: t, p_prefix: prefix }));
    const addVal = (k, s) => {
      if (s.length > MAX_ROW) { big[k] = s.length; return; }
      delete big[k]; rows.push({ k, v: s });
    };
    const stores = new Set(keys.filter(k => k.startsWith('idbs|')).map(k => k.slice(5)));
    try {
      for (const k of keys) {
        if (k === 'lsall') {
          const have = new Set();
          for (const lk of lsKeys()) if (!local(lk)) { have.add('ls:' + lk); addVal('ls:' + lk, lget(lk) || ''); }
          for (const rk of await remoteKeys('ls:')) if (!have.has(rk)) rows.push({ k: rk, d: true });
        } else if (k.startsWith('ls:')) {
          if (snap.lsall) continue;
          const v = lget(k.slice(3));
          v == null ? rows.push({ k, d: true }) : addVal(k, v);
        } else if (k.startsWith('idbschema|')) {
          const db = await getDb(D(k.slice(10)));
          db ? rows.push({ k, v: JSON.stringify(schemaOf(db)) }) : rows.push({ k, d: true });
        } else if (k.startsWith('idbdb|')) {
          const name = D(k.slice(6));
          if (await getDb(name)) continue;          // re-created since
          for (const rk of await remoteKeys('idb|' + E(name) + '|')) rows.push({ k: rk, d: true });
          rows.push({ k: 'idbschema|' + E(name), d: true });
        } else if (k.startsWith('idbs|')) {
          const [dbn, stn] = k.slice(5).split('|').map(D);
          const db = await getDb(dbn), have = new Set();
          if (db && db.objectStoreNames.contains(stn)) {
            for (const r of await storeRows(db, stn)) { const rk = idbK(dbn, stn, r.key); have.add(rk); addVal(rk, JSON.stringify(await enc(r.value))); }
          }
          for (const rk of await remoteKeys('idb|' + E(dbn) + '|' + E(stn) + '|')) if (!have.has(rk)) rows.push({ k: rk, d: true });
        } else if (k.startsWith('idb|')) {
          const p = k.split('|'), dbn = D(p[1]), stn = D(p[2]);
          if (stores.has(p[1] + '|' + p[2])) continue;
          const db = await getDb(dbn);
          let v;
          if (db && db.objectStoreNames.contains(stn)) {
            const key = dec(JSON.parse(p.slice(3).join('|')));
            v = await reqP(db.transaction(stn, 'readonly').objectStore(stn).get(key));
          }
          v === undefined ? rows.push({ k, d: true }) : addVal(k, JSON.stringify(await enc(v)));
        }
      }
    } finally {
      for (const n in dbs) if (dbs[n]) dbs[n].close();
    }
    jset('pt.big', big);
    let i = 0, pushed = 0;
    while (i < rows.length) {
      const part = []; let size = 0;
      while (i < rows.length && (!part.length || size + (rows[i].v || '').length < BATCH)) { size += (rows[i].v || '').length + rows[i].k.length; part.push(rows[i++]); }
      const before = cur();
      const r = await drive('push', { t, rows: part, after: before, dev: DEV, app: APP });
      if (r && !r.gap && cur() === before && r.last) setCur(r.last);
      pushed += part.length;
    }
    for (const k of keys) if (dirty[k] === snap[k]) delete dirty[k];
    jset('pt.dirty', dirty);
    lset('pt.synced', String(Date.now()));
    if (pushed) { rtSend(); bc && bc.postMessage({ t: 'pushed' }); }
    return { pushed };
  }

  // ---------- pull ----------
  let pulling = null;
  function pull() { return pulling || (pulling = doPull().finally(() => { pulling = null; })); }
  async function doPull() {
    const t = tok(); if (!t || !tracking()) return { changed: 0 };
    let changed = 0, more = true, guard = 0;
    while (more && guard++ < 500) {
      const r = await rpc('amt_pull2', { p_token: t, p_after: cur() });
      const rows = r.rows || [], ids = rows.filter(x => x.g && x.o !== DEV).map(x => x.g);
      if (ids.length) {          // values kept in Google Drive
        const got = await drive('get', { t, ids });
        for (const x of rows) if (x.g && x.o !== DEV) x.v = got.v[x.g];
      }
      changed += await apply(rows.filter(x => x.d || x.o === DEV || x.v != null));
      if (r.last) setCur(r.last);
      more = !!r.more;
    }
    lset('pt.synced', String(Date.now()));
    if (changed) bc && bc.postMessage({ t: 'pulled' });
    return { changed };
  }
  async function apply(rows) {
    let n = 0;
    const schemas = jget('pt.schemas', {}), byDb = {};
    const lsAll = !!dirty.lsall;
    for (const r of rows) {
      if (r.o === DEV) continue;                         // written by this device
      if (r.k.startsWith('ls:')) {
        if (lsAll || dirty[r.k]) continue;
        const k = r.k.slice(3), before = lget(k);
        if (r.d) { if (before != null) { ldel(k); n++; } } else if (before !== r.v) { lset(k, r.v); n++; }
      } else if (r.k.startsWith('idbschema|')) {
        const name = D(r.k.slice(10));
        if (r.d) delete schemas[name]; else schemas[name] = JSON.parse(r.v);
      } else if (r.k.startsWith('idb|')) {
        const p = r.k.split('|');
        if (dirty[r.k] || dirty['idbs|' + p[1] + '|' + p[2]]) continue;
        (byDb[D(p[1])] = byDb[D(p[1])] || []).push({ st: D(p[2]), key: dec(JSON.parse(p.slice(3).join('|'))), r });
      }
    }
    jset('pt.schemas', schemas);
    for (const name in byDb) {
      const db = await ensureDb(name, schemas[name]);
      if (!db) continue;
      try {
        const sts = [...new Set(byDb[name].map(x => x.st))].filter(s => db.objectStoreNames.contains(s));
        if (!sts.length) continue;
        await new Promise((res, rej) => {
          const tx = db.transaction(sts, 'readwrite');
          for (const x of byDb[name]) {
            if (!sts.includes(x.st)) continue;
            const s = tx.objectStore(x.st);
            if (x.r.d) IDB.del.call(s, x.key);
            else { const v = dec(JSON.parse(x.r.v)); s.keyPath != null ? IDB.put.call(s, v) : IDB.put.call(s, v, x.key); }
            n++;
          }
          tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
        });
      } catch (e) { console.warn('[amatu] apply', name, e); }
      finally { db.close(); }
    }
    return n;
  }
  async function ensureDb(name, sc) {
    const exists = (await dbNames()).includes(name);
    if (!exists && !sc) return null;
    const create = (db) => {
      for (const s of (sc && sc.st) || []) {
        let os;
        if (!db.objectStoreNames.contains(s.n)) os = db.createObjectStore(s.n, { keyPath: s.kp, autoIncrement: s.ai });
        else continue;
        for (const i of s.ix || []) os.createIndex(i.n, i.kp, { unique: i.u, multiEntry: i.m });
      }
    };
    if (!exists) return openDb(name, sc.v || 1, create).catch(() => null);
    let db = await openDb(name).catch(() => null);
    if (!db || !sc) return db;
    const missing = sc.st.some(s => !db.objectStoreNames.contains(s.n));
    if (missing && sc.v > db.version) { db.close(); db = await openDb(name, sc.v, create).catch(() => null); }
    return db;
  }

  // ---------- account switching ----------
  async function wipe() {
    for (const k of lsKeys()) if (!local(k)) ldel(k);
    for (const k of ['pt.cur', 'pt.dirty', 'pt.schemas', 'pt.big', 'pt.synced']) ldel(k);
    dirty = {}; dseq = 0;
    for (const name of await dbNames()) {
      await new Promise(res => { const r = IDB.drop.call(indexedDB, name); r.onsuccess = r.onerror = res; r.onblocked = () => setTimeout(res, 3000); });
    }
  }
  async function hasLocalData() { return lsKeys().some(k => !local(k)) || (await dbNames()).length > 0; }
  async function adopt() {      // first sign-in on a device that already holds unowned app data
    for (const k of lsKeys()) if (!local(k)) mark('ls:' + k);
    for (const name of await dbNames()) {
      const db = await openDb(name).catch(() => null);
      if (!db) continue;
      mark('idbschema|' + E(name));
      for (const st of db.objectStoreNames) mark('idbs|' + E(name) + '|' + E(st));
      db.close();
    }
  }
  // Called by the portal after the PIN is verified.
  async function enter(u, onStep) {
    const prev = owner();
    jset('pt.unlock', { u, at: Date.now() });
    if (prev !== u) {
      if (prev || !(await hasLocalData())) { onStep && onStep('Menyiapkan perangkat'); await wipe(); lset('pt.owner', u); setCur(0); }
      else { lset('pt.owner', u); setCur(0); await adopt(); }
    }
    onStep && onStep('Memuat data akun');
    await flush().catch(e => console.warn('[amatu] flush', e));
    await pull();
    rtStart();
  }
  const pending = () => Object.keys(dirty).length;
  async function leave(opts) {       // sign out: push what is left, then clear this device
    const t = tok();
    if (!(opts && opts.force)) await flush();
    if (t) await rpc('amt_logout', { p_token: t }).catch(() => { });
    rtStop();
    await wipe();
    for (const k of ['pt.sess', 'pt.owner', 'pt.unlock', 'pt.prev']) ldel(k);
  }
  function lock() { ldel('pt.unlock'); }

  // ---------- realtime (Supabase broadcast over Phoenix websocket) ----------
  let ws = null, wsTopic = '', wsRef = 0, hb = 0, wsRetry = 0, wsStop = false;
  const listeners = [];
  function rtStart() {
    const s = sess(); if (!s || !s.c || ws) return;
    wsStop = false; wsTopic = 'realtime:amt-' + s.c;
    try { ws = new WebSocket(SB_URL.replace('https', 'wss') + '/realtime/v1/websocket?apikey=' + SB_KEY + '&vsn=1.0.0'); } catch { ws = null; return; }
    ws.onopen = () => {
      wsRetry = 0;
      wsSend({ topic: wsTopic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } } });
      hb = setInterval(() => wsSend({ topic: 'phoenix', event: 'heartbeat', payload: {} }), 25000);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'broadcast' && m.payload && m.payload.event === 'sync' && m.payload.payload && m.payload.payload.dev !== DEV) remote();
    };
    ws.onclose = () => { clearInterval(hb); ws = null; if (!wsStop) setTimeout(rtStart, Math.min(30000, 2000 * ++wsRetry)); };
    ws.onerror = () => { try { ws && ws.close(); } catch { } };
  }
  function rtStop() { wsStop = true; clearInterval(hb); try { ws && ws.close(); } catch { } ws = null; }
  function wsSend(m) { if (ws && ws.readyState === 1) { m.ref = String(++wsRef); ws.send(JSON.stringify(m)); } }
  function rtSend() { wsSend({ topic: wsTopic, event: 'broadcast', payload: { type: 'broadcast', event: 'sync', payload: { dev: DEV } } }); }
  function remote() { listeners.forEach(f => { try { f('remote'); } catch { } }); }
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('amatu') : null;
  if (bc) bc.onmessage = e => listeners.forEach(f => { try { f('tab', e.data); } catch { } });

  // ---------- app pages: guard, home button, update banner ----------
  function goPortal() {
    const next = location.pathname + location.search + location.hash;
    location.replace(PORTAL + '?next=' + encodeURIComponent(next));
  }
  function appGuard() {
    if (!unlocked()) {
      document.documentElement.style.visibility = 'hidden';
      vt.remove();   // nothing was shown yet: no cross-fade from an empty page
      goPortal();
      return;
    }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => addEventListener(ev, touch, { passive: true, capture: true }));
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { jset('pt.dirty', dirty); flush().catch(() => { }); }
      else if (!unlocked()) goPortal();
    });
    addEventListener('pagehide', () => jset('pt.dirty', dirty));
    setInterval(() => { if (!unlocked() && document.visibilityState === 'visible') goPortal(); }, 30000);
    // Another device may have changed this account since this device last synced: apply, then reload once.
    const s = sess();
    rpc('amt_status', { p_token: s.t }).then(async st => {
      if (st && st.head > cur()) {
        const { changed } = await pull();
        if (changed && !sessionStorage.getItem('pt.reloaded')) { sessionStorage.setItem('pt.reloaded', '1'); location.reload(); return; }
      }
      sessionStorage.removeItem('pt.reloaded');
      flush().catch(() => { });
    }).catch(e => { if (e.code === 'auth' || e.code === 'pin') { lock(); goPortal(); } });
    rtStart();
    listeners.push(kind => { if (kind === 'remote') banner(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', homeButton); else homeButton();
    fitInit();
  }
  function homeButton() {
    const css = document.createElement('style');
    css.textContent = `#amatu-home{position:fixed;left:0;z-index:2147483600;width:22px;height:52px;border-radius:0 14px 14px 0;
      background:rgba(20,22,30,.55);backdrop-filter:blur(14px) saturate(160%);-webkit-backdrop-filter:blur(14px) saturate(160%);
      border:1px solid rgba(255,255,255,.22);border-left:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
      touch-action:none;opacity:.55;transition:opacity .2s,width .2s;box-shadow:0 4px 18px rgba(0,0,0,.25)}
      #amatu-home:hover{opacity:1;width:30px}#amatu-home svg{width:14px;height:14px;color:#fff}
      #amatu-bar{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483601;font:500 13px/1.3 -apple-system,system-ui,sans-serif;
      background:rgba(20,22,30,.82);color:#fff;padding:9px 10px 9px 14px;border-radius:12px;display:flex;gap:10px;align-items:center;
      backdrop-filter:blur(14px);box-shadow:0 8px 30px rgba(0,0,0,.3)}#amatu-bar button{font:inherit;border:0;border-radius:8px;padding:5px 10px;
      background:#fff;color:#111;cursor:pointer}#amatu-bar button+button{background:transparent;color:#fff}`;
    document.head.appendChild(css);
    const b = document.createElement('div');
    b.id = 'amatu-home'; b.title = 'Portal AMATU';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
    const key = 'pt.homey', y0 = +(lget(key) || 50);
    b.style.top = 'calc(' + y0 + '% - 26px)';
    let sy = 0, moved = false, startTop = 0;
    b.addEventListener('pointerdown', e => { sy = e.clientY; moved = false; startTop = b.getBoundingClientRect().top; b.setPointerCapture(e.pointerId); });
    b.addEventListener('pointermove', e => {
      if (!b.hasPointerCapture(e.pointerId)) return;
      if (Math.abs(e.clientY - sy) > 5) moved = true;
      if (moved) b.style.top = Math.max(4, Math.min(innerHeight - 56, startTop + e.clientY - sy)) + 'px';
    });
    b.addEventListener('pointerup', e => {
      b.releasePointerCapture(e.pointerId);
      if (moved) { lset(key, String(Math.round((b.getBoundingClientRect().top + 26) / innerHeight * 100))); return; }
      jset('pt.dirty', dirty);
      flush().catch(() => { }).finally(() => {
        // opened by the portal in its own tab: close it, the portal tab is still there
        let o = null;
        try { o = window.opener && !window.opener.closed && window.opener.location.pathname === PORTAL ? window.opener : null; } catch { }
        if (o) { try { o.focus(); } catch { } window.close(); if (window.closed) return; }
        location.href = PORTAL;
      });
    });
    document.body.appendChild(b);
  }
  function banner() {
    if (document.getElementById('amatu-bar')) return;
    const d = document.createElement('div');
    d.id = 'amatu-bar';
    d.innerHTML = '<span>Ada perubahan dari perangkat lain</span><button>Muat ulang</button><button>Nanti</button>';
    const [ok, no] = d.querySelectorAll('button');
    ok.onclick = async () => { ok.disabled = true; await flush().catch(() => { }); await pull().catch(() => { }); location.reload(); };
    no.onclick = () => d.remove();
    document.body.appendChild(d);
  }

  // ---------- fit to screen: the whole app visible at browser zoom 100%, desktop and phone ----------
  // A page bigger than the window first gets the full width (centered max-width columns are released),
  // then is scaled down with CSS zoom just enough to fit, per view, like zooming the browser out.
  // Viewport units are rewritten to calc(x / var(--amz)) so 100vh stays the window height under zoom.
  // A page that would need less than ZMIN keeps its normal scroll. On narrow screens toolbars that run
  // past the right edge become horizontal scrollers. ?nofit turns it off.
  // Safe area: on iPhone / iPad (above all when the portal runs as a Home Screen app with a see-through status bar,
  // and with viewport-fit=cover) the status bar, notch / Dynamic Island and home indicator cover the page edges.
  // When app content sits under one of them, that side is kept clear: a page that doesn't scroll gets a frame
  // (body fixed inside the safe area, viewport units shrunk to it), a scrolling page gets html padding.
  function fitInit() {
    if (/[?&]nofit\b/.test(location.search)) return;
    const R = document.documentElement, VU = /(-?(?:\d+\.?\d*|\.\d+))((?:d|s|l)?v(?:h|w|min|max))\b/g;
    const done = new WeakSet();
    let z = 1, longH = -1, t = 0, mo = null, slk = false;
    let ins = null, need = { t: 0, r: 0, b: 0, l: 0 }, skip = {}, mode = '', clip0 = null;   // mode '' | 'box' | 'flow'
    const zmin = () => innerWidth < 760 ? 0.84 : innerWidth >= 1800 ? 0.55 : 0.6;
    const se = () => document.scrollingElement || R;
    function setZ(v) { z = v; R.style.zoom = v === 1 ? '' : String(v); R.style.setProperty('--amz', String(v)); }
    function clips() {
      const a = getComputedStyle(R), b = getComputedStyle(document.body);
      return { y: /hidden|clip/.test(a.overflowY + b.overflowY), x: /hidden|clip/.test(a.overflowX + b.overflowX) };
    }
    // slack: a few px of a 100vh-plus-margin floor (it never shrinks with zoom) shouldn't block fitting
    function over(slack) {
      if (mode === 'box') {   // the app lives in the body frame now
        const b = document.body, sl = slack ? Math.min(60, b.clientHeight * 0.05) : 2;
        return (!clip0.y && b.scrollHeight > b.clientHeight + sl) || (!clip0.x && b.scrollWidth > b.clientWidth + 2);
      }
      const c = clips(), s = se();
      return (!c.y && s.scrollHeight > innerHeight + (slack ? Math.min(60, innerHeight * 0.05) : 2)) || (!c.x && s.scrollWidth > innerWidth + 2);
    }
    // x vh → calc((x vh − x% of the covered top+bottom) / zoom); --amsy etc. are 0 unless the safe frame is on
    const UV = { h: '--amsy', w: '--amsx', min: '--amsn', max: '--amsm' };
    const unit = (m, n, u) => 'calc((' + n + u + ' - ' + n + ' * var(' + UV[u.replace(/^[dsl]?v/, '')] + ', 0px) / 100) / var(--amz, 1))';
    function walk(rules) {
      for (const r of rules) {
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        const st = r.style; if (!st) continue;
        for (let i = 0; i < st.length; i++) {
          const p = st[i], v = st.getPropertyValue(p);
          VU.lastIndex = 0;
          if (VU.test(v)) st.setProperty(p, v.replace(VU, unit), st.getPropertyPriority(p));
        }
      }
    }
    function sheets() {
      for (const s of document.styleSheets) {
        if (done.has(s)) continue;
        let rules; try { rules = s.cssRules; } catch { continue; }   // cross-origin sheet
        done.add(s); try { walk(rules); } catch { }
      }
    }
    function widen() {
      if (innerWidth < 1100) return;
      const W = innerWidth / z;
      (function go(el, d) {
        for (const c of el.children) {
          const cs = getComputedStyle(c);
          if (cs.position !== 'fixed' && cs.position !== 'absolute' && cs.maxWidth.endsWith('px')) {
            const mw = parseFloat(cs.maxWidth), ml = parseFloat(cs.marginLeft), mr = parseFloat(cs.marginRight);
            if (mw >= 900 && mw < W - 80 && ml > 30 && Math.abs(ml - mr) < 3) c.style.setProperty('max-width', 'none', 'important');
          }
          if (d < 4) go(c, d + 1);
        }
      })(document.body, 0);
    }
    function toolbars() {
      if (innerWidth >= 1100) return;
      const W = innerWidth - (mode === 'box' ? need.r : 0);
      for (const el of document.body.querySelectorAll('*')) {
        if (el.id === 'amatu-home' || el.dataset.amfit) continue;
        const r = el.getBoundingClientRect();
        if (r.right <= W + 2 || r.left >= W - 20 || r.left < -2 || r.height < 16 || r.height > 160) continue;
        const cs = getComputedStyle(el);
        if (!/flex|grid/.test(cs.display) || cs.position === 'fixed' || cs.position === 'absolute' || /auto|scroll/.test(cs.overflowX)) continue;
        const p = el.parentElement;
        if (!p || p.getBoundingClientRect().right > W + 2) continue;
        el.dataset.amfit = 'x';
        Object.assign(el.style, { minWidth: '0', maxWidth: '100%', flexShrink: '1', overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none' });
      }
    }
    // ----- safe area -----
    let probe = null, css = null, ov0 = null;
    const shifted = [];
    function insets() {   // read at zoom 1 (later calls under zoom reuse the last value)
      if (!probe) {
        probe = document.createElement('i');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:' +
          'env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
        R.appendChild(probe);   // beside body: never inside the app or the frame
      }
      if (z !== 1 && ins) return ins;
      const c = getComputedStyle(probe), q = p => Math.round(parseFloat(c[p]) || 0);
      return { t: q('paddingTop'), r: q('paddingRight'), b: q('paddingBottom'), l: q('paddingLeft') };
    }
    const CONTENT = /^(BUTTON|INPUT|SELECT|TEXTAREA|A|IMG|SVG|LABEL|VIDEO|H[1-6])$/;
    function content(el) {   // something to read or tap (not a background, glass panel or drawing canvas)
      if (el.closest('#amatu-home,#amatu-bar')) return false;
      for (let d = 0; el && el !== document.body && d < 4; d++, el = el.parentElement) {
        if (CONTENT.test(el.tagName.toUpperCase()) || /button|tab|menuitem|link/.test(el.getAttribute('role') || '')) return true;
        for (const c of el.childNodes) if (c.nodeType === 3 && c.textContent.trim()) return true;
      }
      return false;
    }
    function hits(s, d) {   // app content found in the covered strip of side s (d px deep)
      const W = innerWidth, H = innerHeight, out = [];
      for (const f of [0.3, 0.65, 1]) {
        const o = Math.max(1, d * f - 1.5);
        const pts = [];
        if (s === 't' || s === 'b') for (let x = 4; x < W; x += 10) pts.push([x, s === 't' ? o : H - o]);
        else for (let y = 4; y < H; y += 10) pts.push([s === 'l' ? o : W - o, y]);
        for (const [x, y] of pts) { const el = document.elementFromPoint(x, y); if (el && content(el) && !out.includes(el)) out.push(el); }
      }
      return out;
    }
    function backdrop(el) {   // background of the full-window layer behind el, for the strips left outside the frame
      for (; el && el !== R; el = el.parentElement) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
        if (cs.backgroundImage !== 'none') return cs.backgroundImage;
        if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor)) return cs.backgroundColor;
      }
      for (const w of document.body.children) {   // fixed wallpaper layers (aurora / blobs) beside the app
        const r = w.getBoundingClientRect(), cs = getComputedStyle(w);
        if (cs.position === 'fixed' && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) {
          if (cs.backgroundImage !== 'none') return cs.backgroundImage;
          if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor)) return cs.backgroundColor;
        }
      }
      return '';
    }
    function frameVars() {
      const px = v => v + 'px', box = mode === 'box';
      const sy = box ? need.t + need.b : 0, sx = box ? need.l + need.r : 0, port = innerWidth < innerHeight;
      for (const [k, v] of [['--amst', need.t], ['--amsr', need.r], ['--amsb', need.b], ['--amsl', need.l],
        ['--amsy', sy], ['--amsx', sx], ['--amsn', port ? sx : sy], ['--amsm', port ? sy : sx]]) R.style.setProperty(k, px(v));
      R.classList.toggle('am-box', box); R.classList.toggle('am-flow', mode === 'flow');
      R.dataset.amsafe = mode ? mode + ' ' + need.t + ',' + need.r + ',' + need.b + ',' + need.l : '';
    }
    function unframe() {
      need = { t: 0, r: 0, b: 0, l: 0 };
      if (ov0) { Object.assign(document.body.style, ov0); ov0 = null; }
      for (const [el, top, bottom] of shifted.splice(0)) { el.style.top = top; el.style.bottom = bottom; }
      mode = ''; frameVars();
    }
    function safe() {   // → true when the frame changed (then fit again)
      const now = insets();
      if (!ins || ['t', 'r', 'b', 'l'].some(s => now[s] !== ins[s])) { ins = now; skip = {}; if (mode) unframe(); }   // rotated
      if (!(ins.t || ins.r || ins.b || ins.l) || !document.body) return false;
      const add = [], found = [];
      for (const s of ['t', 'r', 'b', 'l']) {
        if (!ins[s] || need[s] || skip[s] || s === 't' && mode !== 'box' && se().scrollTop > 0) continue;
        const h = hits(s, ins[s]); if (h.length) { add.push(s); found.push(...h); }
      }
      if (!add.length) return false;
      if (!mode) {
        clip0 = clips();
        // a page that scrolls as a whole keeps its scroll and gets padding; an app-shaped page gets the frame
        mode = over() && z === 1 ? 'flow' : 'box';
        if (mode === 'box') {
          const b = document.body.style;
          ov0 = { overflowX: b.overflowX, overflowY: b.overflowY };
          b.overflowX = clip0.x ? 'hidden' : 'auto'; b.overflowY = clip0.y ? 'hidden' : 'auto';
          const a = getComputedStyle(R), bd = getComputedStyle(document.body), none = cs => cs.backgroundImage === 'none' && /^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor);
          if (none(a) && none(bd)) { const bg = backdrop(found[0]); if (bg) R.style.background = bg; }
        }
      }
      const sw0 = Math.max(se().scrollWidth, innerWidth);   // (a phone's layout width itself grows with the page)
      for (const s of add) need[s] = ins[s];
      frameVars();
      // a scrolling page whose rows can't get narrower would only grow sideways (and iOS would zoom it out): leave its sides
      if (mode === 'flow' && (add.includes('l') || add.includes('r')) && se().scrollWidth > sw0 + 2) {
        need.l = need.r = 0; skip.l = skip.r = 1; frameVars();
      }
      if (mode === 'flow') {   // padding moved the page; bars pinned to the window edge still sit under the strip
        for (const s of add) for (let el of hits(s, ins[s])) {
          for (; el && el !== document.body; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
            if (shifted.some(x => x[0] === el)) break;
            if (s === 't' && cs.top !== 'auto') { shifted.push([el, el.style.top, el.style.bottom]); el.style.top = 'calc(' + cs.top + ' + var(--amst) / var(--amz, 1))'; }
            else if (s === 'b' && cs.bottom !== 'auto') { shifted.push([el, el.style.top, el.style.bottom]); el.style.bottom = 'calc(' + cs.bottom + ' + var(--amsb) / var(--amz, 1))'; }
            break;
          }
        }
      }
      if (mode === 'box') sheets();
      return true;
    }
    function fit() {
      if (!document.body) return;
      toolbars();
      setZ(1);
      if (!over()) return;
      widen();
      if (!over()) return;
      sheets();
      setZ(zmin());
      slk = over() && !over(true);   // only a fixed floor is left: judge with slack
      if (over(slk)) { setZ(1); longH = se().scrollHeight; return; }
      let lo = z, hi = 1;
      for (let i = 0; i < 7; i++) { const m = (lo + hi) / 2; setZ(m); if (over(slk)) hi = m; else lo = m; }
      setZ(Math.floor(lo * 100) / 100);
    }
    function check() {   // after DOM changes: cheap test first, full fit only when the answer changed
      if (ins && ['t', 'r', 'b', 'l'].some(s => ins[s] && !need[s] && !skip[s]) && safe()) return run();
      if (mode === 'box') sheets();   // stylesheets loaded later must shrink to the frame too
      if (z === 1) { if (!over() || se().scrollHeight === longH) return; return run(); }
      if (over(slk)) return run();
      const z0 = z; setZ(Math.min(1, z0 + 0.03));
      if (over(slk)) setZ(z0); else run();
    }
    function run() { try { fit(); if (safe()) fit(); } finally { mo && mo.takeRecords(); } }
    // iOS leaves a page that must not scroll shifted up after the keyboard closes (top cut off): put it back
    function unscroll() {
      if (editable(document.activeElement)) return;
      if (mode === 'box') { const b = document.body; if (clip0.y && b.scrollTop) b.scrollTop = 0; if (clip0.x && b.scrollLeft) b.scrollLeft = 0; return; }
      const c = clips(), s = se();
      const y = scrollY && (c.y || s.scrollHeight <= innerHeight + 2), x = scrollX && (c.x || s.scrollWidth <= innerWidth + 2);
      if (x || y) scrollTo(x ? 0 : scrollX, y ? 0 : scrollY);
    }
    // Never re-zoom while someone is typing: a zoom change re-lays out and repaints the whole page (canvases are
    // cleared and redrawn, glass panels re-blurred), which shows up as a flicker on every pause between keystrokes.
    let typedAt = 0;
    const editable = n => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
    const busy = () => Date.now() - typedAt < 1500 || editable(document.activeElement) && innerWidth < 1100;
    // the safe frame is set once per side, so it may come while a field has focus (Sheets keeps its editor focused)
    let st = 0;
    const safeSoon = ms => {
      if (!ins || !['t', 'r', 'b', 'l'].some(s => ins[s] && !need[s] && !skip[s])) return;
      clearTimeout(st);
      st = setTimeout(function go() {
        if (Date.now() - typedAt < 1500) { st = setTimeout(go, 700); return; }
        try { if (safe()) fit(); } finally { mo && mo.takeRecords(); }
      }, ms);
    };
    const soon = (f, ms) => {
      clearTimeout(t);
      t = setTimeout(function go() {
        if (busy()) { t = setTimeout(go, 700); return; }
        try { f(); } finally { mo && mo.takeRecords(); }
      }, ms);
    };
    function start() {
      run();
      addEventListener('keydown', () => { typedAt = Date.now(); }, true);
      addEventListener('compositionupdate', () => { typedAt = Date.now(); }, true);
      // edits inside the document being written (contenteditable / text fields) don't change the app's frame
      mo = new MutationObserver(recs => { if (recs.some(r => !editable(r.target))) { soon(check, 250); safeSoon(300); } });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
      let lastW = innerWidth;
      addEventListener('resize', () => {
        // on-screen keyboard opening/closing (height only, while a field has focus) is not a new layout
        if (innerWidth === lastW && editable(document.activeElement)) return;
        lastW = innerWidth; soon(run, 120);
      });
      addEventListener('hashchange', () => soon(run, 60));
      addEventListener('popstate', () => soon(run, 60));
      addEventListener('load', () => soon(run, 30));
      document.fonts && document.fonts.ready.then(() => soon(run, 30));
      [600, 1500, 3500].forEach(ms => setTimeout(() => soon(check, 0), ms));
      [400, 1200, 2500, 5000].forEach(safeSoon);
      if (matchMedia('(pointer: coarse)').matches) {
        let u = 0; const later = () => { clearTimeout(u); u = setTimeout(unscroll, 350); };
        addEventListener('focusout', later, true);
        window.visualViewport && visualViewport.addEventListener('resize', later);
        addEventListener('orientationchange', () => soon(run, 200));
      }
    }
    R.style.setProperty('--amz', '1');
    css = document.createElement('style');
    css.id = 'amatu-safe';
    css.textContent = 'html.am-box{overflow:hidden!important;height:100%!important}' +
      'html.am-box>body{position:fixed!important;box-sizing:border-box!important;margin:0!important;right:auto!important;bottom:auto!important;' +
      'top:calc(var(--amst) / var(--amz, 1))!important;left:calc(var(--amsl) / var(--amz, 1))!important;' +
      'width:calc((100vw - var(--amsx)) / var(--amz, 1))!important;height:calc((100dvh - var(--amsy)) / var(--amz, 1))!important;' +
      'min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;transform:translateZ(0)}' +
      'html.am-flow{padding:calc(var(--amst) / var(--amz, 1)) calc(var(--amsr) / var(--amz, 1)) calc(var(--amsb) / var(--amz, 1)) calc(var(--amsl) / var(--amz, 1))!important}';
    (document.head || R).appendChild(css);
    done.add(css.sheet);
    window.AMATU.fit = { z: () => z, run, setZ, over, sheets, safe: () => ({ mode, need, ins }) };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }

  window.AMATU = {
    SB_URL, SB_KEY, DEV, APP, rpc, drive, usage: () => rpc('amt_usage', { p_token: tok() }), sess, setSess: s => jset('pt.sess', s), owner, unlocked, touch, lock, enter, leave, flush, pull,
    pending, synced: () => +(lget('pt.synced') || 0), big: () => jget('pt.big', {}), cur, rtStart, rtStop,
    on: f => listeners.push(f), jget, jset, lget, lset, ldel
  };
  // Docs / Sheets / Slides share links (?share=<key>) open for anyone who has the link, without the portal sign-in.
  const shareGuest = !isPortal && /[?&]share=[\w-]{20,}/.test(location.search);
  window.AMATU.guest = () => shareGuest && !unlocked();
  if (!isPortal) {
    if (window.AMATU.guest()) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fitInit); else fitInit(); }
    else appGuard();
  }
})();
