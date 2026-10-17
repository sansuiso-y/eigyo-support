/* UI helpers */
(function(){
  function h(tag, attrs, ...children){
    const el = document.createElement(tag);
    if (attrs) for (const [k,v] of Object.entries(attrs)){
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children){
    for (const c of children.flat(Infinity)){
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function clear(el){ while(el.firstChild) el.removeChild(el.firstChild); return el; }

  const pad = n => String(n).padStart(2,'0');
  function toISODate(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function today(){ return toISODate(new Date()); }
  function parseDate(s){ if(!s) return null; const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
  const DOW = ['日','月','火','水','木','金','土'];
  function fmtDate(s, {dow=true, year=false}={}){
    const d = typeof s === 'string' ? parseDate(s) : s; if(!d) return '';
    let out = `${d.getMonth()+1}/${d.getDate()}`;
    if (year) out = `${d.getFullYear()}/` + out;
    if (dow) out += `(${DOW[d.getDay()]})`;
    return out;
  }
  function fmtDateLong(s){ const d = typeof s==='string'?parseDate(s):s; if(!d) return ''; return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日(${DOW[d.getDay()]})`; }
  function addDays(s, n){ const d = parseDate(s); d.setDate(d.getDate()+n); return toISODate(d); }
  function diffDays(a,b){ return Math.round((parseDate(b)-parseDate(a))/86400000); }
  function fmtDateTime(iso){ if(!iso) return ''; const d = new Date(iso); if(isNaN(d)) return iso; return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtYen(n){ if(n===''||n===null||n===undefined||isNaN(Number(n))) return ''; return '¥' + Number(n).toLocaleString('ja-JP'); }
  function fmtMin(m){ m = Math.round(m||0); if(m<60) return `${m}分`; return `${Math.floor(m/60)}時間${m%60?m%60+'分':''}`; }
  function fmtBytes(b){ if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
  function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  /* ---- toast ---- */
  function toast(msg, {error=false, ms=2600}={}){
    const root = document.getElementById('toast-root');
    const t = h('div', {class:'toast'+(error?' err':'')}, msg);
    root.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(), 320); }, ms);
  }

  /* ---- modal ---- */
  function modal({title, body, actions=[], wide=false, onClose}){
    const root = document.getElementById('modal-root');
    let closed = false;
    let bg;
    const esc = (e)=>{ if(e.key==='Escape' && root.lastElementChild===bg){ e.stopPropagation(); close(); } };
    const close = ()=>{ if(closed) return; closed = true; document.removeEventListener('keydown', esc); bg.remove(); if(!root.querySelector('.modal-bg')) document.body.style.overflow=''; onClose && onClose(); };
    const foot = h('div',{class:'modal-foot'});
    for (const a of actions){
      const b = h('button',{class:'btn '+(a.cls||'')+(a.left?' left':''), onClick: async (e)=>{
        b.disabled = true;
        try { const r = await a.onClick?.(e, close); if (r !== false && !a.keepOpen) close(); }
        catch(err){ console.error(err); toast(err.message||String(err), {error:true}); }
        finally { b.disabled = false; }
      }}, a.label);
      foot.appendChild(b);
    }
    const bodyEl = h('div',{class:'modal-body'});
    append(bodyEl, [typeof body === 'function' ? body(close) : body]);
    bg = h('div',{class:'modal-bg', onClick:(e)=>{ if(e.target===bg) close(); }},
      h('div',{class:'modal'+(wide?' wide':''), role:'dialog', 'aria-modal':'true'},
        h('div',{class:'modal-head'}, h('h2',null,title), h('button',{class:'icon-btn', 'aria-label':'閉じる', onClick:close},'✕')),
        bodyEl,
        actions.length ? foot : null
      ));
    root.appendChild(bg);
    document.body.style.overflow='hidden';
    document.addEventListener('keydown', esc);
    return { close, body: bodyEl, el: bg };
  }
  function confirm(msg, {ok='削除する', danger=true}={}){
    return new Promise(res=>{
      modal({ title:'確認', body: h('p',null,msg), onClose:()=>res(false),
        actions:[ {label:'キャンセル', onClick:()=>{}}, {label:ok, cls: danger?'danger':'primary', onClick:(e,close)=>{ res(true); }} ] });
    });
  }
  function prompt(title, {label='', value='', placeholder='', type='text'}={}){
    return new Promise(res=>{
      const inp = h('input',{type, value, placeholder});
      const m = modal({ title, body: h('div',{class:'form'}, h('div',{class:'f'}, label?h('label',null,label):null, inp)), onClose:()=>res(null),
        actions:[ {label:'キャンセル', onClick:()=>{}}, {label:'OK', cls:'primary', onClick:()=>{ res(inp.value); }} ] });
      setTimeout(()=>inp.focus(), 50);
      inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ res(inp.value); m.close(); } });
    });
  }

  /* ---- form helpers ---- */
  function field(label, input, {hint}={}){ return h('div',{class:'f'}, h('label',null,label), input, hint?h('div',{class:'small muted'},hint):null); }
  function input(attrs){ return h('input', Object.assign({type:'text'}, attrs)); }
  function select(options, value, attrs={}){
    const s = h('select', attrs);
    for (const o of options){
      const [v,l] = Array.isArray(o) ? o : [o,o];
      s.appendChild(h('option',{value:v, selected: String(v)===String(value)}, l));
    }
    return s;
  }
  function textarea(attrs){ return h('textarea', attrs); }
  function readForm(form){
    const out = {};
    form.querySelectorAll('[name]').forEach(el=>{
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
      else out[el.name] = el.value;
    });
    return out;
  }
  function badge(text, cls){ return h('span',{class:'badge '+(cls||'')}, text); }
  function empty(msg){ return h('div',{class:'empty'}, msg); }
  function download(filename, content, type='application/json'){
    const blob = content instanceof Blob ? content : new Blob([content],{type});
    const a = h('a',{href:URL.createObjectURL(blob), download:filename}); document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  async function copy(text){ try{ await navigator.clipboard.writeText(text); toast('コピーしました'); }catch(e){ toast('コピーできませんでした',{error:true}); } }
  function debounce(fn, ms=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  function printElement(el, title){
    const w = window.open('', '_blank');
    if (!w){ toast('ポップアップがブロックされました。印刷を許可してください', {error:true}); return; }
    const css = Array.from(document.querySelectorAll('link[rel=stylesheet][href^="css"]')).map(l=>`<link rel="stylesheet" href="${new URL(l.getAttribute('href'), location.href).href}">`).join('');
    w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title||'印刷')}</title>${css}<style>body{background:#fff;padding:16px}.sheet{border:0}</style></head><body>${el.outerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(()=>{ w.print(); }, 400);
  }

  /* iPhone の HEIC/HEIF 写真を JPEG に直す(サーバーで変換)。ブラウザは HEIC を表示・切り出しできないため。
     HEIC でなければそのまま返す。変換に失敗したら元のファイルを返す(AI 読み取り自体は HEIC でもできる) */
  const isHeic = f => /^image\/hei[cf]$/i.test(f.type||'') || /\.(heic|heif)$/i.test(f.name||'');
  async function toJpeg(file){
    if (!file || !isHeic(file)) return file;
    try {
      const res = await fetch('api/convert', { method:'POST', headers:{ 'Content-Type': file.type || 'image/heic' }, body: file });
      if (!res.ok){ let j=null; try { j = await res.json(); } catch(e){} console.warn('heic convert failed', (j&&j.error)||res.status); return file; }
      const blob = await res.blob();
      return new File([blob], (file.name||'photo').replace(/\.(heic|heif)$/i,'')+'.jpg', { type:'image/jpeg', lastModified: file.lastModified });
    } catch(e){ console.warn('heic convert failed', e); return file; }
  }
  window.UI = { h, append, clear, toast, modal, confirm, prompt, field, input, select, textarea, readForm, badge, empty, download, copy, debounce, printElement, toJpeg, isHeic,
    today, toISODate, parseDate, fmtDate, fmtDateLong, fmtDateTime, fmtYen, fmtMin, fmtBytes, addDays, diffDays, escapeHtml, DOW, pad, uid: ()=>Store.uid() };
})();
