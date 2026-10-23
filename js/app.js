/* App: routing, navigation, page registry */
(function(){
  const pages = {};
  const order = [];
  let current = null;

  function register(name, page){ pages[name] = page; order.push(name); }

  function parseHash(){
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, qs] = hash.split('?');
    const [name, ...rest] = path.split('/');
    const params = {};
    if (qs) new URLSearchParams(qs).forEach((v,k)=>params[k]=v);
    return { name: name || 'dashboard', sub: rest, params };
  }
  function go(path){ location.hash = path.startsWith('#') ? path : '#/'+path.replace(/^\//,''); }

  function renderNav(active){
    const side = document.getElementById('sidenav');
    const tab = document.getElementById('tabbar');
    UI.clear(side); UI.clear(tab);
    for (const n of order){
      const p = pages[n];
      side.appendChild(UI.h('a',{href:'#/'+(n==='dashboard'?'':n), class: n===active?'active':''}, UI.h('span',{class:'ico'},p.icon), p.title));
      if (p.tab) tab.appendChild(UI.h('a',{href:'#/'+(n==='dashboard'?'':n), class: n===active?'active':''}, UI.h('span',{class:'ico'},p.icon), p.short||p.title));
    }
    side.classList.remove('open');
  }

  async function route(){
    const { name, sub, params } = parseHash();
    const page = pages[name] || pages.dashboard;
    if (current && current.destroy) { try{ current.destroy(); }catch(e){} }
    renderNav(pages[name] ? name : 'dashboard');
    const root = document.getElementById('content');
    root.dataset.page = pages[name] ? name : 'dashboard'; // CSS で画面ごとの幅などを変えるため
    UI.clear(root);
    UI.clear(document.getElementById('modal-root')); document.body.style.overflow='';
    document.title = (page.title||'') + ' | 営業サポート';
    try { current = await page.render(root, { sub, params }) || null; }
    catch(e){ console.error(e); root.appendChild(UI.h('div',{class:'card'}, UI.h('h2',null,'エラー'), UI.h('pre',{class:'plain'}, e.stack||String(e)))); }
    window.scrollTo(0,0);
  }

  function applyTheme(){
    const t = Store.settings().theme || 'auto';
    if (t==='auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  }

  function start(){
    applyTheme();
    document.getElementById('nav-toggle').addEventListener('click', ()=>document.getElementById('sidenav').classList.toggle('open'));
    document.addEventListener('click', (e)=>{ const nav=document.getElementById('sidenav'); if(nav.classList.contains('open') && !nav.contains(e.target) && e.target.id!=='nav-toggle') nav.classList.remove('open'); });
    window.addEventListener('hashchange', route);
    Store.on('settings', ()=>{ applyTheme(); renderTopbar(); });
    if (window.Sync) Sync.on(renderTopbar);
    renderTopbar();
    route();
  }
  function renderTopbar(){
    const s = Store.settings();
    const r = document.getElementById('topbar-right');
    UI.clear(r);
    r.appendChild(UI.h('span',{class:'nowrap small'}, UI.fmtDate(UI.today(), {year:true})));
    if (s.userName) r.appendChild(UI.h('span',{class:'nowrap small'}, s.userName));
    const st = window.Sync ? Sync.state() : null;
    if (st && st.mode === 'server' && st.checked){
      r.appendChild(UI.h('a',{href:'#/settings', class:'nowrap small sync-dot', title: st.online ? '同期サーバーに接続中' : 'オフライン(端末内に保存中)'},
        st.online ? '🟢' : '🔴', UI.h('span',{class:'sync-label'}, st.online ? ' 同期' : ' オフライン')));
    }
  }

  /* shared helpers used by several pages */
  const Shared = {
    /* 地図検索(🔍)のリンク。設定「地図検索で開く地図」: auto = ハングルを含めば NAVER、それ以外は Google */
    mapSearchProvider(q){ const m = (Store.settings().mapSearch || 'auto'); return m === 'auto' ? (/[\uac00-\ud7a3]/.test(q||'') ? 'naver' : 'google') : m; },
    mapSearchUrl(q){ q = String(q||'').trim(); return Shared.mapSearchProvider(q) === 'naver' ? `https://map.naver.com/p/search/${encodeURIComponent(q)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`; },
    /* 会社名と住所から地図検索のリンク。NAVER は「会社名+住所」だと見つからないので住所だけ(括弧書き・階・号室を除く)、住所が無ければ会社名だけ */
    placeSearch(company, address){
      const co = String(company||'').replace(/㈜|\(주\)|（주）|주식회사|株式会社|㈱/g,'').trim();
      const ad = String(address||'').replace(/[（(][^)）]*[)）]?/g,' ').replace(/,.*$/,'').replace(/\s+\S*(빌딩|타워|상가동|상가|오피스텔|プラザ|ビル)\S*.*$/,'').replace(/\s+\d+\s*(층|호|階|号室)\s*$/,'').replace(/(로|길)\s+(\d+번(가)?길)/g,'$1$2').replace(/\s+/g,' ').trim();   // 「구룡산로 52번가길」→ 正式表記「구룡산로52번가길」
      const provider = Shared.mapSearchProvider(ad || co);
      const q = provider === 'naver' ? (ad || co) : [co, String(address||'').trim()].filter(Boolean).join(' ');
      return { provider, q, url: provider === 'naver' ? `https://map.naver.com/p/search/${encodeURIComponent(q)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` };
    },
    customerLabel(c){ if(!c) return ''; return [c.company, c.name].filter(Boolean).join(' / '); },
    customerOptions(includeEmpty=true){
      const cs = Store.list('customers').sort((a,b)=>(a.company||'').localeCompare(b.company||'', 'ja'));
      const opts = cs.map(c=>[c.id, Shared.customerLabel(c)]);
      return includeEmpty ? [['','(選択なし)'], ...opts] : opts;
    },
    eventsOn(date){ return Store.where('events', e=>e.date===date).sort((a,b)=>(a.start||'').localeCompare(b.start||'')); },
    /* attachment list widget: linkedKind/linkedId; returns element; refreshes itself */
    attachments(linkedKind, linkedId, {editable=true, onChange}={}){
      const wrap = UI.h('div',{class:'list'});
      async function refresh(){
        UI.clear(wrap);
        const files = await Files.list(linkedKind, linkedId);
        if (!files.length) wrap.appendChild(UI.h('div',{class:'small muted'},'添付なし'));
        for (const f of files){
          const row = UI.h('div',{class:'file-row'},
            UI.h('span',null, f.type.startsWith('image/')?'🖼️':f.type.includes('pdf')?'📄':'📎'),
            UI.h('a',{class:'nm', href:'#', onClick: async(e)=>{ e.preventDefault(); const u = await Files.url(f.id); window.open(u,'_blank'); }}, f.name),
            UI.h('span',{class:'small muted nowrap'}, UI.fmtBytes(f.size)),
            editable ? UI.h('button',{class:'btn sm danger', onClick: async()=>{ if(await UI.confirm(`「${f.name}」を削除しますか?`)){ await Files.remove(f.id); refresh(); onChange && onChange(); } }},'削除') : null
          );
          wrap.appendChild(row);
        }
        if (editable){
          const inp = UI.h('input',{type:'file', multiple:true, style:{display:'none'}, onChange: async()=>{
            for (const file of inp.files){ await Files.put(file, linkedKind, linkedId); }
            UI.toast(`${inp.files.length}件を添付しました`); refresh(); onChange && onChange();
          }});
          const drop = UI.h('div',{class:'drop', onClick:()=>inp.click(),
            onDragover:(e)=>{e.preventDefault(); drop.classList.add('over');}, onDragleave:()=>drop.classList.remove('over'),
            onDrop: async(e)=>{ e.preventDefault(); drop.classList.remove('over'); for(const file of e.dataTransfer.files){ await Files.put(file, linkedKind, linkedId); } refresh(); onChange && onChange(); }
          }, '📎 ファイルを添付(クリック / ドラッグ&ドロップ)', inp);
          wrap.appendChild(drop);
        }
      }
      refresh();
      wrap.refresh = refresh;
      return wrap;
    },
    weatherOptions: ['晴れ','曇り','雨','雪','晴れ時々曇り','曇り時々雨'],
    eventTypes: [['visit','訪問'],['meeting','打合せ'],['move','移動'],['other','その他']],
    eventTypeLabel(t){ return (Shared.eventTypes.find(x=>x[0]===t)||[,'その他'])[1]; }
  };

  window.App = { register, go, start, pages, parseHash, Shared, route };
})();
