/* Store: localStorage-backed collections + IndexedDB files (+ optional server sync) */
(function(){
  const PREFIX = 'sales.';
  const COLS = ['customers','events','routes','hotels','cars','reports','groups','savedPlans']; // savedPlans: 営業計画の保存(全員で共有)
  const cache = {};
  const listeners = {};

  function read(col){
    if (cache[col]) return cache[col];
    try { cache[col] = JSON.parse(localStorage.getItem(PREFIX+col) || '[]'); }
    catch(e){ cache[col] = []; }
    return cache[col];
  }
  function write(col){
    localStorage.setItem(PREFIX+col, JSON.stringify(cache[col]||[]));
    emit(col);
  }
  function emit(col){
    (listeners[col]||[]).forEach(fn=>{ try{fn();}catch(e){console.error(e);} });
    (listeners['*']||[]).forEach(fn=>{ try{fn(col);}catch(e){console.error(e);} });
  }
  let applying = false; // true while server data is being written into localStorage (no re-upload)
  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }

  const Store = {
    COLS,
    uid,
    list(col){ return read(col).slice(); },
    get(col,id){ return read(col).find(x=>x.id===id) || null; },
    save(col,obj){
      const arr = read(col);
      const now = new Date().toISOString();
      if (!obj.id){ obj.id = uid(); obj.createdAt = obj.createdAt || now; }
      obj.updatedAt = now;
      const i = arr.findIndex(x=>x.id===obj.id);
      if (i>=0) arr[i] = obj; else arr.push(obj);
      write(col);
      if (!applying) Sync.touch(col, obj.id, 'u');
      return obj;
    },
    remove(col,id){
      cache[col] = read(col).filter(x=>x.id!==id);
      write(col);
      if (!applying) Sync.touch(col, id, 'd');
    },
    where(col, pred){ return read(col).filter(pred); },
    on(col, fn){ (listeners[col] = listeners[col]||[]).push(fn); return ()=>{ listeners[col] = listeners[col].filter(f=>f!==fn); }; },
    settings(){
      try { return Object.assign({
        userName:'', company:'', homeAddress:'', homeLat:null, homeLng:null,
        workStart:'09:00', workEnd:'18:00', defaultStayMin:45, theme:'auto'
      }, JSON.parse(localStorage.getItem(PREFIX+'settings')||'{}')); } catch(e){ return {}; }
    },
    saveSettings(obj){
      localStorage.setItem(PREFIX+'settings', JSON.stringify(Object.assign(Store.settings(), obj)));
      (listeners['settings']||[]).forEach(fn=>fn());
      if (!applying) Sync.touchSettings();
    },
    exportAll(){
      const out = { version:1, exportedAt:new Date().toISOString(), settings: Store.settings(), data:{} };
      COLS.forEach(c=> out.data[c] = read(c));
      return out;
    },
    importAll(json, {merge=true}={}){
      if (!json || !json.data) throw new Error('形式が不正です');
      COLS.forEach(c=>{
        const incoming = Array.isArray(json.data[c]) ? json.data[c] : [];
        if (merge){
          const cur = read(c);
          const map = new Map(cur.map(x=>[x.id,x]));
          incoming.forEach(x=>{ if(x && x.id) map.set(x.id, x); });
          cache[c] = Array.from(map.values());
          write(c);
          if (!applying) incoming.forEach(x=>{ if (x && x.id) Sync.touch(c, x.id, 'u'); });
        } else {
          cache[c] = incoming;
          write(c);
          if (!applying) Sync.replaceCol(c);
        }
      });
      if (json.settings) Store.saveSettings(json.settings);
    },
    clearAll(){
      localStorage.removeItem(PREFIX+'plans'); delete cache['plans']; // 営業計画の下書き(端末内のみ)も消す
      COLS.forEach(c=>{ cache[c]=[]; write(c); if (!applying) Sync.replaceCol(c); });
      localStorage.removeItem(PREFIX+'settings');
      localStorage.removeItem(PREFIX+'geocache');
      (listeners['settings']||[]).forEach(fn=>fn());
      if (!applying) Sync.touchSettings();
    }
  };
  window.Store = Store;

  /* ---------- IndexedDB files ---------- */
  const DB_NAME='sales-files', DB_VER=1;
  let dbp = null;
  function db(){
    if (dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const req = indexedDB.open(DB_NAME, DB_VER);
      // 開けないまま固まる(別タブの削除待ちなど)と同期全体が止まるので、時間切れで諦めて次回やり直す
      const timer = setTimeout(()=>{ dbp = null; rej(new Error('添付ファイルの保存領域を開けませんでした')); }, 10000);
      req.onupgradeneeded = ()=>{
        const d = req.result;
        if (!d.objectStoreNames.contains('files')){
          const s = d.createObjectStore('files',{keyPath:'id'});
          s.createIndex('linked',['linkedKind','linkedId']);
        }
      };
      req.onsuccess = ()=>{ clearTimeout(timer); const d = req.result; d.onversionchange = ()=>{ d.close(); dbp = null; }; res(d); };
      req.onerror = ()=>{ clearTimeout(timer); dbp = null; rej(req.error); };
      req.onblocked = ()=>{ /* 他タブが閉じるのを待つ(上のタイマーで打ち切り) */ };
    });
    return dbp;
  }
  function tx(mode, fn){
    return db().then(d=>new Promise((res,rej)=>{
      const t = d.transaction('files', mode);
      const s = t.objectStore('files');
      let out; try { out = fn(s); } catch(e){ rej(e); return; }
      t.oncomplete = ()=>res((typeof IDBRequest !== 'undefined' && out instanceof IDBRequest) ? out.result : out);
      t.onerror = ()=>rej(t.error);
    }));
  }
  const urlCache = {};
  const Files = {
    async put(file, linkedKind, linkedId, meta={}){
      const rec = { id: uid(), name: file.name || meta.name || 'file', type: file.type || 'application/octet-stream',
        size: file.size || 0, blob: file, linkedKind: linkedKind||'', linkedId: linkedId||'', createdAt: new Date().toISOString(), ...meta };
      await tx('readwrite', s=>s.put(rec));
      await Sync.uploadFile(rec);
      return rec;
    },
    async get(id){ return (await tx('readonly', s=>s.get(id))) || null; },
    async list(linkedKind, linkedId){
      const all = await tx('readonly', s=>s.getAll());
      let arr = all || [];
      if (linkedKind) arr = arr.filter(f=>f.linkedKind===linkedKind && (linkedId===undefined || f.linkedId===linkedId));
      return arr.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
    },
    async update(rec){ await tx('readwrite', s=>s.put(rec)); await Sync.uploadFile(rec); return rec; },
    async remove(id){
      if(urlCache[id]){ URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
      await tx('readwrite', s=>s.delete(id));
      await Sync.deleteFile(id);
    },
    async url(id){
      if (urlCache[id]) return urlCache[id];
      const r = await Files.get(id); if(!r) return null;
      urlCache[id] = URL.createObjectURL(r.blob); return urlCache[id];
    },
    async count(){ return tx('readonly', s=>s.count()); }
  };
  window.Files = Files;

  /* ---------- Sync: 任意のサーバー(同じフォルダの server.js)と同期 ----------
   * 端末内(localStorage / IndexedDB)が常に一次保存先。サーバーがあれば保存のたびにレコード単位で送り
   * (PATCH /api/data/<col> {upsert, delete})、起動時・画面復帰時・30秒ごと・「今すぐ同期」でサーバーから読み直す。
   * 無ければ従来どおり端末内のみ。競合は「同じレコードを後に送った方が勝つ」(レコード単位)。 */
  const Sync = (function(){
    const K = { recs: PREFIX+'sync.dirtyRecs', cols: PREFIX+'sync.replaceCols', settings: PREFIX+'sync.dirtySettings',
      fsynced: PREFIX+'sync.filesSynced', fdel: PREFIX+'sync.fileDeletes', last: PREFIX+'sync.lastAt', init: PREFIX+'sync.initDone' };
    const canTry = /^https?:$/.test(location.protocol);
    const LOCAL_KEYS = ['userName','theme']; // 端末ごとの値(複数人で共有しない)
    // mode: 'server'(同期サーバーあり/確認中) | 'static'(同期機能のないWebサーバー) | 'none'(file:// で直接開いた)
    const st = { mode: canTry ? 'server' : 'none', online: false, checked: false, syncing: false, auth: false, user: null, needLogin: false,
      lastSyncAt: localStorage.getItem(K.last) || null, lastError: null, serverUrl: location.origin };
    const subs = [];
    let timer = null, inflight = null, periodic = null, pullRequested = false;

    /* --- 永続化する小さな状態 --- */
    function loadObj(key){ try { return JSON.parse(localStorage.getItem(key)||'{}') || {}; } catch(e){ return {}; } }
    function saveObj(key, o){ localStorage.setItem(key, JSON.stringify(o)); }
    function loadSet(key){ try { return new Set(JSON.parse(localStorage.getItem(key)||'[]')); } catch(e){ return new Set(); } }
    function saveSet(key, set){ localStorage.setItem(key, JSON.stringify(Array.from(set))); }
    // dirtyRecs: { col: { id: {op:'u'|'d', v:<updatedAt or stamp>} } }
    function dirtyRecs(){ return loadObj(K.recs); }
    function pendingCount(){ const r = dirtyRecs(); let n = 0; Object.values(r).forEach(m=>n+=Object.keys(m).length); return n + loadSet(K.cols).size + (localStorage.getItem(K.settings)?1:0) + loadSet(K.fdel).size; }
    function sharedSettings(obj){ const o = Object.assign({}, obj||{}); LOCAL_KEYS.forEach(k=>delete o[k]); return o; }
    function withLocal(remoteSettings){ const cur = Store.settings(); const o = Object.assign({}, remoteSettings||{}); LOCAL_KEYS.forEach(k=>{ if (cur[k] !== undefined) o[k] = cur[k]; }); return o; }

    function notify(){ subs.forEach(fn=>{ try{fn(state());}catch(e){console.error(e);} }); }
    function setOnline(v, err){
      const changed = st.online !== v || !st.checked;
      st.online = v; st.checked = true; st.lastError = v ? null : (err ? String(err.message||err) : st.lastError);
      if (changed) notify();
    }
    function state(){
      return { mode: st.mode, online: st.online, checked: st.checked, syncing: st.syncing, auth: st.auth, user: st.user, needLogin: st.needLogin,
        lastSyncAt: st.lastSyncAt, lastError: st.lastError, serverUrl: st.serverUrl, pending: st.mode==='server' ? pendingCount() : 0 };
    }
    async function fetchT(url, opts={}, ms=8000){
      const ctl = new AbortController();
      const t = setTimeout(()=>ctl.abort(), ms);
      try { return await fetch(url, Object.assign({ cache:'no-store', signal: ctl.signal }, opts)); }
      finally { clearTimeout(t); }
    }
    async function api(path, opts, ms){
      const res = await fetchT(path, opts, ms);
      if (res.status === 401){ st.needLogin = true; notify(); throw new Error('ログインが必要です'); }
      if (!res.ok) throw new Error(`サーバーエラー ${res.status}`);
      // Wi-Fi のログイン画面などが 200 で HTML を返す場合を「成功」と誤認しない(添付本文の取得だけは X-File-Meta で判定)
      const ct = res.headers.get('content-type') || '';
      const binary = /^\/api\/files\/[^/]+$/.test(path) && (opts && opts.method === 'GET');
      if (binary ? !res.headers.get('x-file-meta') : !ct.includes('application/json')) throw new Error('同期サーバーの応答ではありません');
      return res;
    }
    const JSON_H = {'Content-Type':'application/json'};
    function modalOpen(){ const r = document.getElementById('modal-root'); return !!(r && r.querySelector('.modal-bg')); }
    function hasLocalData(){ return COLS.some(c=>read(c).length>0) || !!localStorage.getItem(PREFIX+'settings'); }

    /* --- 変更の記録(ページの保存のたびに呼ばれる) --- */
    function schedule(){ clearTimeout(timer); timer = setTimeout(()=>{ run(()=>flush()); }, 400); }
    function touch(col, id, op){
      if (st.mode !== 'server' || !id || !COLS.includes(col)) return;
      const r = dirtyRecs(); (r[col] = r[col] || {})[id] = { op, v: Date.now() };
      saveObj(K.recs, r); schedule();
    }
    function replaceCol(col){
      if (st.mode !== 'server' || !COLS.includes(col)) return;
      const s = loadSet(K.cols); s.add(col); saveSet(K.cols, s);
      const r = dirtyRecs(); delete r[col]; saveObj(K.recs, r); // 丸ごと置き換えるのでレコード単位の記録は不要
      schedule();
    }
    function touchSettings(){ if (st.mode !== 'server') return; localStorage.setItem(K.settings, '1'); schedule(); }

    /* --- 送信 --- */
    async function flush(){
      if (st.mode !== 'server') return;
      try {
        // 1) コレクション丸ごと置き換え(全データ削除・上書き取り込み)
        for (const col of Array.from(loadSet(K.cols))){
          await api('/api/data/'+col, { method:'PUT', headers:JSON_H, body: JSON.stringify(read(col)) });
          const s = loadSet(K.cols); s.delete(col); saveSet(K.cols, s);
        }
        // 2) レコード単位(送信中に再保存されたものは消さない: v で判定)
        for (const col of COLS){
          const snap = (dirtyRecs()[col]) || {};
          const ids = Object.keys(snap); if (!ids.length) continue;
          const upsert = [], del = [];
          ids.forEach(id=>{ if (snap[id].op === 'd') del.push(id); else { const o = Store.get(col, id); if (o) upsert.push(o); else del.push(id); } });
          await api('/api/data/'+col, { method:'PATCH', headers:JSON_H, body: JSON.stringify({ upsert, delete: del }) });
          const r = dirtyRecs(); const m = r[col] || {};
          ids.forEach(id=>{ if (m[id] && m[id].v === snap[id].v) delete m[id]; });
          if (Object.keys(m).length) r[col] = m; else delete r[col];
          saveObj(K.recs, r);
        }
        // 3) 共有設定
        if (localStorage.getItem(K.settings)){
          localStorage.removeItem(K.settings);
          try { await api('/api/data/settings', { method:'PUT', headers:JSON_H, body: JSON.stringify(sharedSettings(Store.settings())) }); }
          catch(e){ localStorage.setItem(K.settings, '1'); throw e; }
        }
        setOnline(true);
        st.lastSyncAt = new Date().toISOString(); localStorage.setItem(K.last, st.lastSyncAt); notify();
      } catch(e){ setOnline(false, e); }
    }

    // 全体書き込み(PUT /api/data)の前後で使う: 書き込み中に新しく記録された変更は消さない
    function snapshotDirty(){ return { recs: JSON.stringify(dirtyRecs()), cols: Array.from(loadSet(K.cols)), settings: !!localStorage.getItem(K.settings) }; }
    function clearDirtyFrom(snap){
      const before = JSON.parse(snap.recs), r = dirtyRecs();
      Object.keys(before).forEach(col=>{ const m = r[col]; if (!m) return; Object.keys(before[col]).forEach(id=>{ if (m[id] && m[id].v === before[col][id].v) delete m[id]; }); if (!Object.keys(m).length) delete r[col]; });
      saveObj(K.recs, r);
      const cols = loadSet(K.cols); snap.cols.forEach(c=>cols.delete(c)); saveSet(K.cols, cols);
      if (snap.settings) localStorage.removeItem(K.settings);
    }

    /* --- 取り込み --- */
    function mergeInto(col, serverArr){
      // サーバーの内容を基本に、この端末で未送信のレコードはこの端末の版を優先する
      const map = new Map();
      (Array.isArray(serverArr) ? serverArr : []).forEach(x=>{ if (x && x.id) map.set(x.id, x); });
      const m = (dirtyRecs()[col]) || {};
      Object.keys(m).forEach(id=>{ if (m[id].op === 'd') map.delete(id); else { const o = Store.get(col, id); if (o) map.set(id, o); } });
      return Array.from(map.values());
    }
    async function pull({reload=true}={}){
      const res = await api('/api/data', {method:'GET'});
      let remote = await res.json();
      const first = !localStorage.getItem(K.init);
      if (remote.empty){
        // サーバーが空(初回 or data/ を入れ替えた)→ 端末の内容で初期化。添付も「未送信」扱いに戻して再送する
        saveSet(K.fsynced, new Set());
        if (hasLocalData()){
          const snap = snapshotDirty();
          const all = Store.exportAll(); all.settings = sharedSettings(all.settings);
          await api('/api/data', { method:'PUT', headers:JSON_H, body: JSON.stringify(all) });
          clearDirtyFrom(snap);
        }
        localStorage.setItem(K.init, '1');
        return false;
      }
      if (first && hasLocalData()){
        // この端末からの初回接続で、端末にもサーバーにもデータがある → ID単位で合流させてから送る(どちらも消さない)
        const snap = snapshotDirty();
        const merged = { version:1, settings: sharedSettings(Object.assign({}, Store.settings(), remote.settings||{})), data:{} };
        COLS.forEach(c=>{
          const map = new Map();
          (Array.isArray(remote.data && remote.data[c]) ? remote.data[c] : []).forEach(x=>{ if (x && x.id) map.set(x.id, x); });
          read(c).forEach(x=>{ if (!x || !x.id) return; const r = map.get(x.id); if (!r || (x.updatedAt||'') >= (r.updatedAt||'')) map.set(x.id, x); });
          merged.data[c] = Array.from(map.values());
        });
        await api('/api/data', { method:'PUT', headers:JSON_H, body: JSON.stringify(merged) });
        clearDirtyFrom(snap);
        remote = Object.assign({}, remote, merged);
      }
      const changed = [];
      applying = true;
      try {
        const replacing = loadSet(K.cols);
        COLS.forEach(c=>{
          if (replacing.has(c)) return; // 丸ごと置き換え待ちのコレクションは触らない
          const arr = mergeInto(c, remote.data && remote.data[c]);
          const next = JSON.stringify(arr);
          if (next !== JSON.stringify(read(c))){ cache[c] = arr; localStorage.setItem(PREFIX+c, next); changed.push(c); }
        });
        if (!localStorage.getItem(K.settings) && remote.settings && typeof remote.settings === 'object'){
          let cur = {}; try { cur = JSON.parse(localStorage.getItem(PREFIX+'settings')||'{}'); } catch(e){}
          if (JSON.stringify(sharedSettings(cur)) !== JSON.stringify(sharedSettings(remote.settings))){
            localStorage.setItem(PREFIX+'settings', JSON.stringify(withLocal(sharedSettings(remote.settings)))); // userName/theme は端末の値を保つ
            changed.push('settings');
          }
        }
      } finally { applying = false; }
      localStorage.setItem(K.init, '1');
      if (changed.length){
        changed.forEach(c=>{ if (c==='settings') (listeners['settings']||[]).forEach(fn=>{ try{fn();}catch(e){console.error(e);} }); else emit(c); });
        if (reload && window.App && App.route && !modalOpen()) App.route();
        else if (!reload && window.UI && UI.toast) UI.toast('ほかの端末の変更を取り込みました');
      }
      return changed.length > 0;
    }

    /* --- 添付ファイル --- */
    function metaOf(rec){ const m = Object.assign({}, rec); delete m.blob; return m; }
    function putFile(rec){
      return api('/api/files/'+encodeURIComponent(rec.id), { method:'PUT', headers:{ 'Content-Type': rec.type||'application/octet-stream', 'X-File-Meta': encodeURIComponent(JSON.stringify(metaOf(rec))) }, body: rec.blob }, 120000);
    }
    async function uploadFile(rec){
      if (st.mode !== 'server' || !rec) return false;
      if (st.checked && !st.online) return false; // オフライン時は次回の同期で送る
      try { await putFile(rec); const s = loadSet(K.fsynced); s.add(rec.id); saveSet(K.fsynced, s); setOnline(true); return true; }
      catch(e){ console.warn('upload failed', e); setOnline(false, e); return false; }
    }
    async function deleteFile(id){
      const s = loadSet(K.fsynced); s.delete(id); saveSet(K.fsynced, s);
      if (st.mode !== 'server') return;
      const del = loadSet(K.fdel); del.add(id); saveSet(K.fdel, del);
      if (st.checked && !st.online) return;
      try { await api('/api/files/'+encodeURIComponent(id), {method:'DELETE'}); const d2 = loadSet(K.fdel); d2.delete(id); saveSet(K.fdel, d2); setOnline(true); }
      catch(e){ console.warn('delete failed', e); setOnline(false, e); }
    }
    async function syncFiles(){
      const del = loadSet(K.fdel);
      for (const id of Array.from(del)){ await api('/api/files/'+encodeURIComponent(id), {method:'DELETE'}); del.delete(id); saveSet(K.fdel, del); }
      const remote = await (await api('/api/files', {method:'GET'})).json();
      const remoteMap = new Map((remote||[]).map(m=>[m.id, m]));
      const local = (await tx('readonly', s=>s.getAll())) || [];
      const synced = loadSet(K.fsynced);
      let changed = false;
      for (const rec of local){
        const r = remoteMap.get(rec.id);
        if (!r){
          if (synced.has(rec.id)){ // 送信済みなのにサーバーに無い → 他端末で削除された
            if (urlCache[rec.id]){ URL.revokeObjectURL(urlCache[rec.id]); delete urlCache[rec.id]; }
            await tx('readwrite', s=>s.delete(rec.id)); synced.delete(rec.id); changed = true;
          } else { await putFile(rec); synced.add(rec.id); } // まだ送っていない
        } else {
          if (r.name !== rec.name || (r.linkedKind||'') !== (rec.linkedKind||'') || (r.linkedId||'') !== (rec.linkedId||'')){
            Object.assign(rec, { name:r.name, linkedKind:r.linkedKind||'', linkedId:r.linkedId||'' });
            await tx('readwrite', s=>s.put(rec)); changed = true;
          }
          synced.add(rec.id);
        }
        remoteMap.delete(rec.id);
      }
      for (const r of remoteMap.values()){ // サーバーにだけある → 取り込む
        const res = await api('/api/files/'+encodeURIComponent(r.id), {method:'GET'}, 120000);
        const blob = await res.blob();
        const rec = { id:r.id, name:r.name||'file', type:r.type||blob.type||'application/octet-stream', size:r.size||blob.size, blob,
          linkedKind:r.linkedKind||'', linkedId:r.linkedId||'', createdAt:r.createdAt||new Date().toISOString() };
        await tx('readwrite', s=>s.put(rec)); synced.add(r.id); changed = true;
      }
      saveSet(K.fsynced, synced);
      return changed;
    }

    /* --- 全体同期 --- */
    function run(fn){ // 同時実行を直列化
      const p = (inflight || Promise.resolve()).then(fn, fn);
      inflight = p.catch(()=>{});
      return p;
    }
    async function checkServer(){
      let res;
      try { res = await fetchT('/api/status', {method:'GET'}, 5000); }
      catch(e){ setOnline(false, e); return false; } // ネットワーク不通
      if (res.status === 401){ st.needLogin = true; setOnline(false, new Error('ログインが必要です')); location.replace('/login'); return false; }
      let s = null; try { s = res.ok ? await res.json() : null; } catch(e){}
      if (!s || s.app !== 'sales-support'){
        // /api/status が無い(404/501)普通のWebサーバー(GitHub Pages / python http.server など)で、かつこの端末が
        // 一度も同期したことがなければ「同期機能なし」として端末内だけで動く。
        // それ以外(5xx、Wi-Fi のログイン画面が 200 で HTML を返す等)は一時的な障害とみなしてオフライン扱い(保存は未送信として残す)
        if ((res.status === 404 || res.status === 501) && !localStorage.getItem(K.init)){
          st.mode = 'static'; st.online = false; st.checked = true; clearInterval(periodic); notify(); return false;
        }
        setOnline(false, new Error(res.ok ? '同期サーバーの応答ではありません' : `サーバーエラー ${res.status}`)); return false;
      }
      st.auth = !!s.auth; st.user = s.user || null; st.needLogin = false; setOnline(true);
      if (window.MapKit) MapKit.setKey(s.mapsKey || ''); // 地図を Google Maps にする鍵(無ければ OpenStreetMap)
      if (st.user && st.user.displayName && !Store.settings().userName) Store.saveSettings({ userName: st.user.displayName }); // 氏名が未設定ならログイン名から
      return true;
    }
    async function doSync({reload=true}={}){
      if (st.mode !== 'server') return false;
      st.syncing = true; notify();
      try {
        if (!(await checkServer())) return false;
        const first = !localStorage.getItem(K.init);
        if (!first){ await flush(); if (!st.online) return false; }
        const skipPull = modalOpen() && reload && !first; // 編集中は画面を差し替えない(30秒ごとの同期はデータのみ取り込む)
        let changed = false;
        if (!skipPull) changed = await pull({reload});
        if (first || pendingCount()){ await flush(); if (!st.online) return false; }
        let fchanged = false;
        try { fchanged = await syncFiles(); } // 添付の同期で失敗・停止しても、データの同期は成功扱いにする
        catch(e){ console.warn('files sync failed', e); }
        if (fchanged && reload && !modalOpen() && window.App && App.route) App.route();
        st.lastSyncAt = new Date().toISOString(); localStorage.setItem(K.last, st.lastSyncAt);
        setOnline(true);
        return changed || fchanged;
      } catch(e){ console.warn('sync failed', e); setOnline(false, e); return false; }
      finally { st.syncing = false; notify(); }
    }
    function now(opts){ return run(()=>doSync(opts)); }

    function init(){
      if (st.mode !== 'server') return;
      now({reload:true});
      // 画面に戻ったとき/回線復帰: 取り込むが、入力途中の内容を消さないよう画面は描き直さない(変更があればトーストで知らせる)
      document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') now({reload:false}); });
      window.addEventListener('online', ()=>now({reload:false}));
      periodic = setInterval(()=>{ if (document.visibilityState === 'visible') now({reload:false}); }, 30000);
    }

    return { state, now, touch, touchSettings, replaceCol, uploadFile, deleteFile, init,
      on(fn){ subs.push(fn); return ()=>{ const i = subs.indexOf(fn); if(i>=0) subs.splice(i,1); }; } };
  })();
  window.Sync = Sync;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Sync.init); else Sync.init();
})();
