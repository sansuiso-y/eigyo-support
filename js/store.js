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
    (listeners[col]||[]).forEach(fn=>{ try{fn();}catch(e){console.error(e);} });
    (listeners['*']||[]).forEach(fn=>{ try{fn(col);}catch(e){console.error(e);} });
  }
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
      return rec;
    },
    async get(id){ return tx('readonly', s=>s.get(id)); },
    async list(linkedKind, linkedId){
      const all = await tx('readonly', s=>s.getAll());
      let arr = all || [];
      if (linkedKind) arr = arr.filter(f=>f.linkedKind===linkedKind && (linkedId===undefined || f.linkedId===linkedId));
      return arr.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
    },
    async update(rec){ await tx('readwrite', s=>s.put(rec)); return rec; },
    async remove(id){ if(urlCache[id]){ URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } return tx('readwrite', s=>s.delete(id)); },
    async url(id){
      if (urlCache[id]) return urlCache[id];
      const r = await Files.get(id); if(!r) return null;
      urlCache[id] = URL.createObjectURL(r.blob); return urlCache[id];
    },
    async count(){ return tx('readonly', s=>s.count()); }
  };
  window.Files = Files;
})();
