/* Store: localStorage-backed collections + IndexedDB files */
(function(){
  const PREFIX = 'sales.';
  const COLS = ['customers','events','routes','hotels','cars','reports','groups'];
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
    if (!applying) Sync.queue(col);
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
      return obj;
    },
    remove(col,id){
      cache[col] = read(col).filter(x=>x.id!==id);
      write(col);
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
      if (!applying) Sync.queue('settings');
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
        } else cache[c] = incoming;
        write(c);
      });
      if (json.settings) Store.saveSettings(json.settings);
    },
    clearAll(){
      COLS.forEach(c=>{ cache[c]=[]; write(c); });
      localStorage.removeItem(PREFIX+'settings');
      localStorage.removeItem(PREFIX+'geocache');
      (listeners['settings']||[]).forEach(fn=>fn());
      if (!applying) Sync.queue('settings');
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
      req.onupgradeneeded = ()=>{
        const d = req.result;
        if (!d.objectStoreNames.contains('files')){
          const s = d.createObjectStore('files',{keyPath:'id'});
          s.createIndex('linked',['linkedKind','linkedId']);
        }
      };
      req.onsuccess = ()=>res(req.result);
      req.onerror = ()=>rej(req.error);
    });
    return dbp;
  }
  function tx(mode, fn){
    return db().then(d=>new Promise((res,rej)=>{
      const t = d.transaction('files', mode);
      const s = t.objectStore('files');
      let out; try { out = fn(s); } catch(e){ rej(e); return; }
      t.oncomplete = ()=>res(out && out.result !== undefined ? out.result : out);
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
    async get(id){ return tx('readonly', s=>s.get(id)); },
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
   * 端末内(localStorage / IndexedDB)が常に一次保存先。サーバーがあれば保存のたびにサーバーへも書き、
   * 起動時・画面復帰時・30秒ごと・「今すぐ同期」でサーバーから読み直す。無ければ従来どおり端末内のみ。
   * 競合は「最後に保存した方が勝つ」(コレクション単位 / ファイル単位)。 */
  const Sync = (function(){
    const K = { dirty: PREFIX+'sync.dirty', fsynced: PREFIX+'sync.filesSynced', fdel: PREFIX+'sync.fileDeletes', last: PREFIX+'sync.lastAt' };
    const canTry = /^https?:$/.test(location.protocol);
    const st = { mode: canTry ? 'server' : 'none', online: false, checked: false, syncing: false,
      lastSyncAt: localStorage.getItem(K.last) || null, lastError: null, serverUrl: location.origin };
    const subs = [];
    const pending = new Set();   // 送信待ちコレクション(メモリ)
    let timer = null, inflight = null, periodic = null;

    function loadSet(key){ try { return new Set(JSON.parse(localStorage.getItem(key)||'[]')); } catch(e){ return new Set(); } }
    function saveSet(key, set){ localStorage.setItem(key, JSON.stringify(Array.from(set))); }
    function dirty(){ return loadSet(K.dirty); }
    function markDirty(col, on){ const d = dirty(); if (on) d.add(col); else d.delete(col); saveSet(K.dirty, d); }
    function notify(){ subs.forEach(fn=>{ try{fn(state());}catch(e){console.error(e);} }); }
    function setOnline(v, err){
      const changed = st.online !== v || !st.checked;
      st.online = v; st.checked = true; st.lastError = v ? null : (err ? String(err.message||err) : st.lastError);
      if (changed) notify();
    }
    function state(){
      return { mode: st.mode, online: st.online, checked: st.checked, syncing: st.syncing, lastSyncAt: st.lastSyncAt, lastError: st.lastError,
        serverUrl: st.serverUrl, pending: dirty().size + loadSet(K.fdel).size };
    }
    async function fetchT(url, opts={}, ms=8000){
      const ctl = new AbortController();
      const t = setTimeout(()=>ctl.abort(), ms);
      try { return await fetch(url, Object.assign({ cache:'no-store', signal: ctl.signal }, opts)); }
      finally { clearTimeout(t); }
    }
    async function api(path, opts, ms){
      const res = await fetchT(path, opts, ms);
      if (!res.ok) throw new Error(`サーバーエラー ${res.status}`);
      return res;
    }
    function modalOpen(){ const r = document.getElementById('modal-root'); return !!(r && r.querySelector('.modal-bg')); }
    function hasLocalData(){ return COLS.some(c=>read(c).length>0) || !!localStorage.getItem(PREFIX+'settings'); }

    /* --- 構造化データ --- */
    function bodyOf(col){ return col==='settings' ? Store.settings() : read(col); }
    async function pushOne(col){
      await api('/api/data/'+col, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(bodyOf(col)) });
      markDirty(col, false);
    }
    async function flush(){
      if (st.mode !== 'server') return;
      const cols = new Set([...pending, ...dirty()]);
      pending.clear();
      for (const col of cols){
        try { await pushOne(col); setOnline(true); }
        catch(e){ markDirty(col, true); setOnline(false, e); break; }
      }
      if (st.online){ st.lastSyncAt = new Date().toISOString(); localStorage.setItem(K.last, st.lastSyncAt); notify(); }
    }
    function queue(col){
      if (st.mode !== 'server') return;
      pending.add(col); markDirty(col, true);
      clearTimeout(timer); timer = setTimeout(()=>{ run(()=>flush()); }, 400);
    }
    async function pull({reload=true}={}){
      const res = await api('/api/data', {method:'GET'});
      let remote = await res.json();
      if (remote.empty){
        if (hasLocalData()){ await api('/api/data', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(Store.exportAll()) }); COLS.forEach(c=>markDirty(c,false)); markDirty('settings',false); }
        return false;
      }
      if (!st.lastSyncAt && hasLocalData()){
        // この端末からの初回接続で、端末にもサーバーにもデータがある → ID単位で合流させてから送る(どちらも消さない)
        const merged = { version:1, settings: Object.assign({}, Store.settings(), remote.settings||{}), data:{} };
        COLS.forEach(c=>{
          const map = new Map();
          (Array.isArray(remote.data && remote.data[c]) ? remote.data[c] : []).forEach(x=>{ if (x && x.id) map.set(x.id, x); });
          read(c).forEach(x=>{ if (!x || !x.id) return; const r = map.get(x.id); if (!r || (x.updatedAt||'') >= (r.updatedAt||'')) map.set(x.id, x); });
          merged.data[c] = Array.from(map.values());
        });
        await api('/api/data', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(merged) });
        COLS.forEach(c=>markDirty(c,false)); markDirty('settings',false);
        remote = Object.assign({}, remote, merged);
      }
      const d = dirty();
      const changed = [];
      applying = true;
      try {
        COLS.forEach(c=>{
          if (d.has(c)) return; // 未送信のローカル変更がある場合は上書きしない(次回 push で送る)
          const arr = Array.isArray(remote.data && remote.data[c]) ? remote.data[c] : [];
          const next = JSON.stringify(arr);
          if (next !== JSON.stringify(read(c))){ cache[c] = arr; localStorage.setItem(PREFIX+c, next); changed.push(c); }
        });
        if (!d.has('settings') && remote.settings && typeof remote.settings === 'object'){
          const next = JSON.stringify(remote.settings);
          if (next !== (localStorage.getItem(PREFIX+'settings')||'{}')){ localStorage.setItem(PREFIX+'settings', next); changed.push('settings'); }
        }
      } finally { applying = false; }
      if (changed.length){
        changed.forEach(c=>{ if (c==='settings') (listeners['settings']||[]).forEach(fn=>{ try{fn();}catch(e){console.error(e);} }); else emit(c); });
        if (reload && window.App && App.route && !modalOpen()) App.route();
      }
      return changed.length > 0;
    }

    /* --- 添付ファイル --- */
    function metaOf(rec){ const m = Object.assign({}, rec); delete m.blob; return m; }
    async function uploadFile(rec){
      if (st.mode !== 'server' || !rec) return false;
      if (st.checked && !st.online) return false; // オフライン時は次回の同期で送る
      try {
        await api('/api/files/'+encodeURIComponent(rec.id), { method:'PUT', headers:{ 'Content-Type': rec.type||'application/octet-stream', 'X-File-Meta': encodeURIComponent(JSON.stringify(metaOf(rec))) }, body: rec.blob }, 120000);
        const s = loadSet(K.fsynced); s.add(rec.id); saveSet(K.fsynced, s);
        setOnline(true); return true;
      } catch(e){ console.warn('upload failed', e); setOnline(false, e); return false; }
    }
    async function deleteFile(id){
      const s = loadSet(K.fsynced); s.delete(id); saveSet(K.fsynced, s);
      if (st.mode !== 'server') return;
      const del = loadSet(K.fdel); del.add(id); saveSet(K.fdel, del);
      if (st.checked && !st.online) return;
      try { await api('/api/files/'+encodeURIComponent(id), {method:'DELETE'}); del.delete(id); saveSet(K.fdel, del); setOnline(true); }
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
          if (synced.has(rec.id)){ // 他端末で削除された
            if (urlCache[rec.id]){ URL.revokeObjectURL(urlCache[rec.id]); delete urlCache[rec.id]; }
            await tx('readwrite', s=>s.delete(rec.id)); synced.delete(rec.id); changed = true;
          } else { // まだ送っていない
            await api('/api/files/'+encodeURIComponent(rec.id), { method:'PUT', headers:{ 'Content-Type': rec.type||'application/octet-stream', 'X-File-Meta': encodeURIComponent(JSON.stringify(metaOf(rec))) }, body: rec.blob }, 120000);
            synced.add(rec.id);
          }
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
    async function doSync({reload=true, silent=false}={}){
      if (st.mode !== 'server') return false;
      st.syncing = true; notify();
      try {
        try { const s = await (await api('/api/status', {method:'GET'}, 5000)).json(); if (!s || s.app !== 'sales-support') throw new Error('同期サーバーではありません'); }
        catch(e){ setOnline(false, e); return false; }
        setOnline(true);
        await flush();
        if (!st.online) return false;
        const skipPull = modalOpen() && !silent && reload; // 編集中は画面を差し替えない
        let changed = false;
        if (!skipPull) changed = await pull({reload});
        const fchanged = await syncFiles();
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
      document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') now({reload:true}); });
      window.addEventListener('online', ()=>now({reload:true}));
      periodic = setInterval(()=>{ if (document.visibilityState === 'visible') now({reload:false, silent:true}); }, 30000);
    }

    return { state, now, queue, uploadFile, deleteFile, on(fn){ subs.push(fn); return ()=>{ const i = subs.indexOf(fn); if(i>=0) subs.splice(i,1); }; }, init };
  })();
  window.Sync = Sync;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Sync.init); else Sync.init();
})();
