/* 営業計画: 訪問先リストの取り込み → 日ごとの自動振り分け → ルート最適化 → 予定表に反映 */
(function(){
  const { h, field, input, select, toast } = UI;
  const S = App.Shared;
  const CATS = ['旅行会社','法人','自治体・関係機関','メディア','団体','その他'];

  /* ---------- 小道具 ---------- */
  const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t||''); return m ? Number(m[1])*60+Number(m[2]) : null; };
  const fmtT = m => { m = Math.round(m); const d = Math.floor(m/1440); m -= d*1440; return `${UI.pad(Math.floor(m/60))}:${UI.pad(m%60)}${d?`(+${d}日)`:''}`; };
  const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const hasCoord = p => !!p && isNum(p.lat) && isNum(p.lng);
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  function emptyRow(){ return { key: UI.uid(), checked:true, company:'', name:'', title:'', category:'', phone:'', address:'', memo:'', stayMin:null, lat:null, lng:null, customerId:null, date:'', timeFrom:'', timeTo:'' }; }
  function rowLabel(r){ return r.company || r.name || '(名称なし)'; }
  function findCustomer(r){
    const cs = Store.list('customers');
    return cs.find(c => c.company && norm(c.company)===norm(r.company) && (!r.name || !c.name || norm(c.name)===norm(r.name)))
        || (r.name && cs.find(c => c.name && norm(c.name)===norm(r.name) && !r.company)) || null;
  }
  function loadScript(src){ return new Promise((res,rej)=>{ const ex = document.querySelector(`script[src="${src}"]`); if (ex && ex.dataset.loaded) return res(); if (ex) ex.remove(); const s = h('script',{src, onLoad:()=>{ s.dataset.loaded='1'; res(); }, onError:()=>{ s.remove(); rej(new Error('読み込みに失敗: '+src)); }}); document.head.appendChild(s); }); }

  /* ---------- 列名の推定(CSV/Excel) ---------- */
  const COLMAP = [
    ['company', /会社|社名|法人|company|組織|団体名|取引先|訪問先/i],
    ['name', /氏名|名前|担当者|name|お名前/i],
    ['title', /役職|肩書|職責|title|position/i],
    ['category', /区分|種別|カテゴリ|分類|category|type/i],
    ['phone', /電話|tel|phone|携帯|連絡先/i],
    ['address', /住所|所在地|address|addr/i],
    ['memo', /備考|メモ|note|remark|コメント/i],
    ['stayMin', /滞在|所要|stay/i],
    ['date', /希望日|訪問日|日付|date/i],
    ['timeFrom', /時間|time|開始/i]
  ];
  function rowsFromTable(table){
    // table: 2次元配列。1行目をヘッダーとみなす(見出しが推定できなければ 会社名,氏名,役職,区分,電話,住所 の順)
    const rows = table.filter(r => r && r.some(c => String(c??'').trim()!==''));
    if (!rows.length) return [];
    const head = rows[0].map(c=>String(c??'').trim());
    const idx = {};
    head.forEach((hname,i)=>{ for (const [k,re] of COLMAP){ if (idx[k]===undefined && re.test(hname)) { idx[k]=i; break; } } });
    let body = rows.slice(1);
    if (Object.keys(idx).length < 2){ idx.company=0; idx.name=1; idx.title=2; idx.category=3; idx.phone=4; idx.address=5; body = rows; }
    return body.map(r=>{
      const g = k => idx[k]===undefined ? '' : String(r[idx[k]]??'').trim();
      const o = Object.assign(emptyRow(), { company:g('company'), name:g('name'), title:g('title'), category:g('category'), phone:g('phone'), address:g('address'), memo:g('memo') });
      const st = Number(g('stayMin')); if (st>0) o.stayMin = st;
      const dm = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(g('date')); if (dm) o.date = `${dm[1]}-${UI.pad(dm[2])}-${UI.pad(dm[3])}`;
      const tms = [...g('timeFrom').matchAll(/(\d{1,2}):(\d{2})/g)].map(m=>UI.pad(m[1])+':'+m[2]); if (tms[0]) o.timeFrom = tms[0]; if (tms[1]) o.timeTo = tms[1];
      return o;
    }).filter(r => r.company || r.name);
  }
  async function readText(f){ const buf = await f.arrayBuffer(); try { return new TextDecoder('utf-8',{fatal:true}).decode(buf); } catch(e){ try { return new TextDecoder('shift_jis').decode(buf); } catch(e2){ return new TextDecoder().decode(buf); } } }
  async function parseCsv(text){
    const out=[]; let row=[], cell='', q=false;
    for (let i=0;i<text.length;i++){ const c=text[i];
      if (q){ if (c==='"'){ if (text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=c; }
      else if (c==='"') q=true; else if (c===','||c==='\t'){ row.push(cell); cell=''; } else if (c==='\n'||c==='\r'){ if (c==='\r'&&text[i+1]==='\n') i++; row.push(cell); out.push(row); row=[]; cell=''; } else cell+=c; }
    if (cell!==''||row.length){ row.push(cell); out.push(row); }
    return out;
  }
  async function parseXlsx(file){
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');
    const wb = XLSX.read(await file.arrayBuffer(), {type:'array'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:''});
  }
  async function extractByAI(file, onProgress){
    onProgress && onProgress('AIで読み取り中…(10〜30秒)');
    const res = await fetch('api/extract', { method:'POST', headers:{ 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name||'') }, body: file });
    let j = null; try { j = await res.json(); } catch(e){}
    if (!res.ok) throw new Error((j && j.error) || `読み取りに失敗しました (${res.status})`);
    return (j.rows||[]).map(r => Object.assign(emptyRow(), { company:r.company||'', name:r.name||'', title:r.title||'', category:r.category||'', phone:r.phone||'', address:r.address||'', memo:r.memo||'' }));
  }
  async function shrinkImage(file){
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5*1024*1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const max = 2200, sc = Math.min(1, max/Math.max(bmp.width,bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width*sc); cv.height = Math.round(bmp.height*sc);
      cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
      const blob = await new Promise(r=>cv.toBlob(r,'image/jpeg',0.88));
      return new File([blob], (file.name||'image').replace(/\.\w+$/,'')+'.jpg', {type:'image/jpeg'});
    } catch(e){ return file; }
  }

  /* ---------- 日ごとの振り分け(希望日・時間帯を守る) ---------- */
  async function buildPlan(start, stops, opt){
    // stops: 座標ありの行 {.., date?, timeFrom?, timeTo?, stayMin}。opt: {startDate, days, workStart, workEnd, roundTrip}
    const pts = [start, ...stops];
    const M = await Geo.matrix(pts);               // 分
    const ws = toMin(opt.workStart) ?? 540, we = toMin(opt.workEnd) ?? 1080;
    const idx = new Map(stops.map((s,i)=>[s,i]));
    const travel = (a,b) => M[a?idx.get(a)+1:0][b?idx.get(b)+1:0];
    const dates = Array.from({length:opt.days},(_,d)=>UI.addDays(opt.startDate,d));
    const days = dates.map(date=>({ date, stops:[], must:[], warnings:[] }));
    const unassigned = [];
    let pool = [];
    for (const s of stops){
      if (s.date){ const d = days.find(x=>x.date===s.date); if (d) d.must.push(s); else { s.note = `希望日 ${s.date} が期間外`; unassigned.push(s); } }
      else pool.push(s);
    }
    for (const day of days){
      const timed = day.must.filter(s=>s.timeFrom).sort((a,b)=>toMin(a.timeFrom)-toMin(b.timeFrom));
      let mustFree = day.must.filter(s=>!s.timeFrom);
      let cur = null, t = ws; const order = [];
      const MAX_WAIT = 60; // 希望時間まで待てる上限(分)。それ以上なら今は入れず、後で入れる
      const fits = (s, limit) => {
        let arr = t + travel(cur,s), wait = 0;
        if (s.timeFrom){ const tf = toMin(s.timeFrom); if (tf !== null && tf > arr){ wait = tf - arr; if (wait > MAX_WAIT) return null; arr = tf; } }
        if (s.timeTo){ const tt = toMin(s.timeTo); if (tt !== null && arr > tt) return null; }
        const dep = arr + stay(s);
        const after = timed.length ? travel(s, timed[0]) : (opt.roundTrip ? travel(s, null) : 0);
        return dep + after <= limit ? {arr,dep,wait} : null;
      };
      while (true){
        const limit = timed.length ? Math.min(toMin(timed[0].timeFrom), we) : we;
        // 近い順に、次の固定時刻(または業務終了)までに収まる訪問先を入れる
        let best=null, bd=Infinity, fromMust=false;
        for (const s of mustFree){ const f=fits(s,limit); if (f && travel(cur,s)+f.wait<bd){ bd=travel(cur,s)+f.wait; best=s; fromMust=true; } }
        if (!best) for (const s of pool){ const f=fits(s,limit); if (f && travel(cur,s)+f.wait<bd){ bd=travel(cur,s)+f.wait; best=s; } }
        if (best){ const f = fits(best, limit); order.push(best); t = f.dep; cur = best; if (fromMust) mustFree = mustFree.filter(x=>x!==best); else pool = pool.filter(x=>x!==best); continue; }
        if (timed.length){ // 固定時刻の訪問先へ
          const s = timed.shift(); const arr = Math.max(t + travel(cur,s), toMin(s.timeFrom));
          if (s.timeTo && arr > toMin(s.timeTo)) day.warnings.push(`${s.label}: 希望時間帯 ${s.timeFrom}〜${s.timeTo} に間に合いません(到着 ${fmtT(arr)})`);
          if (arr + stay(s) > we) day.warnings.push(`${s.label}: 希望時刻 ${s.timeFrom} は業務終了(${opt.workEnd})を超えます`);
          order.push(s); t = arr + stay(s); cur = s; continue;
        }
        if (mustFree.length){ // 希望日指定だが時間内に入らない → 無理やり入れて警告
          const s = mustFree.shift(); const arr = t + travel(cur,s); order.push(s); t = arr + stay(s); cur = s; day.warnings.push(s.timeTo && arr > toMin(s.timeTo) ? `${s.label}: 希望時間帯(〜${s.timeTo})に間に合いません(到着 ${fmtT(arr)})` : `${s.label}: 業務終了(${opt.workEnd})を超えます`); continue;
        }
        break;
      }
      day.stops = order;
    }
    pool.forEach(s=>{ if (s.timeFrom || s.timeTo) s.note = `時間帯 ${s.timeFrom||''}〜${s.timeTo||''} を守って入れられる日がありませんでした`; });
    unassigned.push(...pool);
    // 時刻指定のない日は2-optで並べ直し
    for (const day of days){
      if (day.stops.length > 2 && !day.stops.some(s=>s.timeFrom)){
        try { const r = await Geo.optimize(start, day.stops, {roundTrip: opt.roundTrip}); day.stops = r.stops; } catch(e){}
      }
      delete day.must;
    }
    return { days, unassigned };
  }
  const stay = s => Number(s.stayMin) > 0 ? Number(s.stayMin) : 45;
  async function itinerary(start, day, opt){
    const pts = [start, ...day.stops]; if (opt.roundTrip && day.stops.length) pts.push(start);
    const r = await Geo.route(pts);
    const ws = toMin(opt.workStart) ?? 540; let t = ws; const rows = [];
    day.stops.forEach((s,i)=>{ const leg = r.legs?.[i] || {durationMin:0, distanceKm:0}; let arr = t + leg.durationMin; let wait = 0; if (s.timeFrom && toMin(s.timeFrom) > arr){ wait = toMin(s.timeFrom) - arr; arr = toMin(s.timeFrom); } const late = s.timeTo && arr > toMin(s.timeTo); const dep = arr + stay(s); rows.push({ stop:s, arr, dep, wait, late, legKm:leg.distanceKm, legMin:leg.durationMin }); t = dep; });
    let backMin = 0, backKm = 0; if (opt.roundTrip && day.stops.length){ const leg = r.legs?.[day.stops.length]; if (leg){ backMin = leg.durationMin; backKm = leg.distanceKm; } }
    return { rows, distanceKm: r.distanceKm, durationMin: r.durationMin, estimated: r.estimated, end: t + backMin, backMin, backKm };
  }

  /* ---------- ページ ---------- */
  App.register('plan', {
    title:'営業計画', icon:'🧭', tab:false,
    render(root, {params}){
      const settings = Store.settings();
      const draft = Store.list('plans')[0] || null;      // 下書きは端末内のみ(同期しない)
      const state = draft ? Object.assign({ rows:[], plan:null }, draft) : {
        id: null, rows: [], filter:'', plan:null,
        startDate: UI.addDays(UI.today(),1), days: 3, workStart: settings.workStart||'09:00', workEnd: settings.workEnd||'18:00',
        roundTrip: true, startAddress: settings.homeAddress||'', startLat: settings.homeLat, startLng: settings.homeLng, startLabel: '拠点'
      };
      state.rows = (state.rows||[]).map(r=>Object.assign(emptyRow(), r));
      function saveDraft(){ const o = Object.assign({}, state); delete o.filterOptions; Store.save('plans', o); state.id = o.id; }

      /* ===== 1. 訪問先リスト ===== */
      const listEl = h('div');
      const fileInp = h('input',{type:'file', accept:'image/*,.pdf,.csv,.xlsx,.xls,.txt', multiple:true, style:{display:'none'}, onChange: ()=>importFiles(fileInp.files)});
      const camInp = h('input',{type:'file', accept:'image/*', capture:'environment', style:{display:'none'}, onChange: ()=>importFiles(camInp.files)});
      const progress = h('div',{class:'small muted'});
      async function importFiles(files){
        let added = 0;
        for (const f0 of Array.from(files||[])){
          try {
            const ext = (f0.name||'').split('.').pop().toLowerCase();
            let rows = [];
            if (ext==='csv' || ext==='txt' || f0.type==='text/csv'){ rows = rowsFromTable(await parseCsv(await readText(f0))); }
            else if (ext==='xlsx' || ext==='xls'){ progress.textContent='Excelを読み込み中…'; rows = rowsFromTable(await parseXlsx(f0)); }
            else { const f = await shrinkImage(f0); rows = await extractByAI(f, m=>progress.textContent=m); }
            rows.forEach(r=>{ const c = findCustomer(r); if (c){ r.customerId = c.id; r.address = r.address || c.address || ''; r.phone = r.phone || c.phone || ''; if (hasCoord(c)){ r.lat=c.lat; r.lng=c.lng; } } });
            state.rows.push(...rows); added += rows.length;
          } catch(e){ console.error(e); toast(`${f0.name}: ${e.message}`, {error:true, ms:5000}); }
        }
        progress.textContent = '';
        fileInp.value=''; camInp.value='';
        if (added){ toast(`${added}件を取り込みました。内容を確認・修正してください`); saveDraft(); renderList(); }
      }
      function addFromCustomers(){
        const cs = Store.list('customers').sort((a,b)=>(a.company||'').localeCompare(b.company||'','ja'));
        const boxes = cs.map(c=>({c, el:h('input',{type:'checkbox'})}));
        UI.modal({ title:'名刺から選ぶ', body: h('div',{class:'list'}, cs.length ? boxes.map(b=>h('label',{class:'file-row', style:{cursor:'pointer'}}, b.el, h('span',{class:'nm'}, S.customerLabel(b.c)), h('span',{class:'small muted'}, b.c.address||'住所なし'))) : UI.empty('名刺がありません')),
          actions:[{label:'キャンセル', onClick:()=>{}}, {label:'追加', cls:'primary', onClick:()=>{
            let n=0; boxes.filter(b=>b.el.checked).forEach(({c})=>{ if (state.rows.some(r=>r.customerId===c.id)) return; state.rows.push(Object.assign(emptyRow(), {company:c.company||'', name:c.name||'', title:c.title||'', phone:c.phone||'', address:c.address||'', category:(c.tags||[])[0]||'', lat:c.lat, lng:c.lng, customerId:c.id})); n++; });
            if (n){ toast(`${n}件を追加しました`); saveDraft(); renderList(); }
          }}] });
      }
      function renderList(){
        UI.clear(listEl);
        const cats = [...new Set(state.rows.map(r=>r.category).filter(Boolean))];
        const chips = h('div',{class:'chip-row'},
          h('button',{class:'chip'+(!state.filter?' active':''), onClick:()=>{ state.filter=''; renderList(); }}, `すべて (${state.rows.length})`),
          cats.map(c=>h('button',{class:'chip'+(state.filter===c?' active':''), onClick:()=>{ state.filter=c; renderList(); }}, `${c} (${state.rows.filter(r=>r.category===c).length})`)));
        const visible = state.rows.filter(r=>!state.filter || r.category===state.filter);
        const checkedCount = state.rows.filter(r=>r.checked).length;
        const tools = h('div',{class:'row mt'},
          h('button',{class:'btn sm', onClick:()=>{ visible.forEach(r=>r.checked=true); saveDraft(); renderList(); }}, '表示中を選択'),
          h('button',{class:'btn sm', onClick:()=>{ visible.forEach(r=>r.checked=false); saveDraft(); renderList(); }}, '表示中を解除'),
          state.filter ? h('button',{class:'btn sm primary', onClick:()=>{ state.rows.forEach(r=>r.checked = r.category===state.filter); saveDraft(); renderList(); toast(`「${state.filter}」だけを選択しました`); }}, `「${state.filter}」だけ回る`) : null,
          h('span',{class:'small muted'}, `選択 ${checkedCount} 件`),
          h('span',{style:{flex:1}}),
          h('button',{class:'btn sm', onClick:lookupAddresses, title:'住所が空の行について、会社名からAIがWeb検索で所在地を調べます(要確認)'}, '🌐 AIで住所を調べる'),
          h('button',{class:'btn sm', onClick:geocodeAll}, '📍 選択行の座標を取得'),
          h('button',{class:'btn sm', onClick:registerCustomers}, '👤 選択行を名刺に登録'),
          h('button',{class:'btn sm danger', onClick: async()=>{ if (await UI.confirm('リストをすべて消しますか?')){ state.rows=[]; state.plan=null; saveDraft(); renderList(); renderPlan(); } }}, 'リストを消す')
        );
        if (!state.rows.length){ listEl.append(UI.empty('まだ訪問先がありません。上のボタンから写真・PDF・Excel・名刺を取り込むか、手入力で追加してください。')); return; }
        const tbl = h('table',{class:'tbl plan-tbl'}, h('thead',null, h('tr',null, ['','会社名','氏名','役職','区分','電話','住所','希望日','時間帯','滞在','座標',''].map(t=>h('th',null,t)))));
        const tb = h('tbody');
        const cell = (r,k,attrs={}) => h('td',null, h('input',Object.assign({type:'text', value:r[k]||'', onChange:(e)=>{ r[k]=e.target.value; if (k==='address'){ r.lat=null; r.lng=null; } saveDraft(); } }, attrs)));
        for (const r of visible){
          const catSel = h('select',{onChange:(e)=>{ r.category=e.target.value; saveDraft(); renderList(); }}, [['','(なし)'], ...CATS.map(c=>[c,c]), ...(r.category && !CATS.includes(r.category) ? [[r.category, r.category]] : [])].map(([v,l])=>h('option',{value:v, selected:v===r.category}, l)));
          tb.appendChild(h('tr',{class: r.checked?'':'muted'},
            h('td',null, h('input',{type:'checkbox', checked:r.checked, onChange:(e)=>{ r.checked=e.target.checked; saveDraft(); }})),
            cell(r,'company',{style:{minWidth:'140px'}}), cell(r,'name',{style:{minWidth:'100px'}}), cell(r,'title',{style:{minWidth:'80px'}}),
            h('td',null, catSel),
            cell(r,'phone',{style:{minWidth:'110px'}}),
            h('td',null, h('div',{class:'row', style:{flexWrap:'nowrap'}}, h('input',{type:'text', value:r.address||'', placeholder:'住所(ルート作成に必要)', style:{minWidth:'200px'}, onChange:(e)=>{ r.address=e.target.value; r.lat=null; r.lng=null; r.geoNote=''; saveDraft(); renderList(); }}),
              h('a',{class:'btn sm', href:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((r.company||'')+' '+(r.address||''))}`, target:'_blank', rel:'noopener', title:'地図で住所を調べる'}, '🔍'))),
            h('td',null, h('input',{type:'date', value:r.date||'', style:{width:'150px'}, onChange:(e)=>{ r.date=e.target.value; saveDraft(); }})),
            h('td',null, h('div',{class:'row', style:{flexWrap:'nowrap', gap:'2px'}}, h('input',{type:'time', value:r.timeFrom||'', style:{width:'105px'}, title:'この時刻以降', onChange:(e)=>{ r.timeFrom=e.target.value; saveDraft(); }}), '〜', h('input',{type:'time', value:r.timeTo||'', style:{width:'105px'}, title:'この時刻まで', onChange:(e)=>{ r.timeTo=e.target.value; saveDraft(); }}))),
            h('td',null, h('input',{type:'number', value:r.stayMin||'', placeholder:String(settings.defaultStayMin||45), min:5, step:5, style:{width:'70px'}, onChange:(e)=>{ r.stayMin = Number(e.target.value)||null; saveDraft(); }})),
            h('td',{class:'nowrap small'}, hasCoord(r) ? (r.geoNote ? h('span',{class:'badge draft', title:r.geoNote}, '要確認') : h('span',{class:'badge done'},'OK')) : h('span',{class:'badge draft'}, r.address ? '未取得' : '住所なし')),
            h('td',null, h('button',{class:'btn sm', onClick:()=>{ state.rows = state.rows.filter(x=>x!==r); saveDraft(); renderList(); }}, '✕'))
          ));
        }
        tbl.appendChild(tb);
        listEl.append(chips, tools, h('div',{class:'tbl-wrap mt'}, tbl),
          h('div',{class:'row mt'}, h('button',{class:'btn sm', onClick:()=>{ state.rows.push(emptyRow()); saveDraft(); renderList(); }}, '＋ 行を追加'),
            h('span',{class:'small muted'}, '住所の欄の 🔍 で地図検索を開き、見つけた住所を貼り付けてください。')));
      }
      async function lookupAddresses(){
        const targets = state.rows.filter(r=>r.checked && !r.address && (r.company||r.name)).slice(0,20);
        if (!targets.length){ toast('住所が空の選択行がありません(20行まで一度に調べられます)'); return; }
        const area = await UI.prompt('地域のヒント(任意)', {label:'例: 韓国 清州市 / 福島県郡山市', placeholder:'空でも可'});
        if (area === null) return;
        progress.textContent = `AIが住所を検索中…(${targets.length}件、30秒ほど)`;
        try {
          const res = await fetch('api/lookup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area, rows: targets.map(r=>({ key:r.key, company:r.company, name:r.name, hint:r.category })) }) });
          let j=null; try { j = await res.json(); } catch(e){}
          if (!res.ok) throw new Error((j&&j.error)||`失敗 (${res.status})`);
          let n=0;
          for (const x of (j.results||[])){
            const r = state.rows.find(q=>q.key===x.key); if (!r || !x.address) continue;
            r.address = x.address; r.lat=null; r.lng=null; n++;
            const tagNote = `住所はAI検索(${({high:'確度高',medium:'確度中',low:'確度低'})[x.confidence]||'要確認'}${x.source?` / ${x.source}`:''}${x.note?` / ${x.note}`:''})`;
            r.memo = [r.memo, tagNote].filter(Boolean).join(' ');
          }
          saveDraft(); renderList();
          toast(`${n}件の住所を入れました。必ず内容を確認してから「座標を取得」してください`, {ms:6000});
        } catch(e){ toast('住所検索に失敗: '+e.message, {error:true, ms:5000}); }
        finally { progress.textContent=''; }
      }
      async function geocodeAll(){
        const targets = state.rows.filter(r=>r.checked && !hasCoord(r) && (r.address || r.company));
        if (!targets.length){ toast('座標を取得する行がありません'); return; }
        let ok=0, ng=0;
        for (let i=0;i<targets.length;i++){
          const r = targets[i]; progress.textContent = `座標を取得中 ${i+1}/${targets.length}: ${rowLabel(r)}`;
          try {
            let g = r.address ? await Geo.geocode(r.address) : null; let note = g && g.simplified ? `住所を「${g.simplified}」に簡略化して検索` : '';
            if (!g && r.company){ g = await Geo.geocode(r.company); if (g) note = '会社名で検索(住所では見つからず)'; }
            if (g){ r.lat=g.lat; r.lng=g.lng; r.geoNote = note; ok++; } else ng++;
          } catch(e){ ng++; }
        }
        progress.textContent=''; saveDraft(); renderList();
        toast(`座標取得: 成功 ${ok} / 見つからず ${ng}`, {error: ng>0, ms:4000});
        if (ng) toast('見つからなかった行は住所を詳しく入力するか、🔍で調べて貼り付けてください', {ms:5000});
      }
      function registerCustomers(){
        const rows = state.rows.filter(r=>r.checked);
        let created=0, updated=0;
        for (const r of rows){
          const c = (r.customerId && Store.get('customers', r.customerId)) || findCustomer(r);
          const base = c ? Object.assign({}, c) : { tags:[], memo:'' };
          Object.assign(base, { company: r.company||base.company||'', name: r.name||base.name||'', title: r.title||base.title||'', phone: r.phone||base.phone||'', address: r.address||base.address||'' });
          if (hasCoord(r)){ base.lat=r.lat; base.lng=r.lng; }
          if (r.category && !(base.tags||[]).includes(r.category)) base.tags = [...(base.tags||[]), r.category];
          if (r.memo) base.memo = [base.memo, r.memo].filter(Boolean).join('\n');
          const saved = Store.save('customers', base); r.customerId = saved.id; c ? updated++ : created++;
        }
        saveDraft(); renderList();
        toast(`名刺に登録: 新規 ${created} 件 / 更新 ${updated} 件`);
      }

      /* ===== 2. 計画条件 ===== */
      const startDateInp = input({type:'date', value:state.startDate, onChange:(e)=>{ state.startDate=e.target.value; saveDraft(); }});
      const daysInp = input({type:'number', value:state.days, min:1, max:30, onChange:(e)=>{ state.days=Math.max(1,Number(e.target.value)||1); saveDraft(); }});
      const wsInp = input({type:'time', value:state.workStart, onChange:(e)=>{ state.workStart=e.target.value; saveDraft(); }});
      const weInp = input({type:'time', value:state.workEnd, onChange:(e)=>{ state.workEnd=e.target.value; saveDraft(); }});
      const roundChk = h('input',{type:'checkbox', checked:state.roundTrip, onChange:(e)=>{ state.roundTrip=e.target.checked; saveDraft(); }});
      const startAddrInp = input({type:'text', value:state.startAddress, placeholder:'例: 宿泊ホテルの住所、駅名(未入力なら設定の拠点)'});
      const startInfo = h('div',{class:'small muted'}, hasCoord({lat:state.startLat,lng:state.startLng}) ? `出発地: ${state.startLabel||state.startAddress||'設定の拠点'} (座標OK)` : '出発地の座標が未設定です。上の欄に住所を入れて「設定」を押してください');
      async function setStart(){
        const a = startAddrInp.value.trim();
        if (!a){ state.startAddress = settings.homeAddress||''; state.startLat=settings.homeLat; state.startLng=settings.homeLng; state.startLabel='拠点'; }
        else { try { const g = await Geo.geocode(a); if (!g){ toast('出発地の住所が見つかりませんでした', {error:true}); return; } state.startAddress=a; state.startLat=g.lat; state.startLng=g.lng; state.startLabel=a; } catch(e){ toast(e.message,{error:true}); return; } }
        if (!hasCoord({lat:state.startLat,lng:state.startLng})){ toast('設定画面の拠点住所が未登録です。上の欄に出発地の住所を入れてください', {error:true}); return; }
        saveDraft(); startInfo.textContent = `出発地: ${state.startLabel||state.startAddress} (座標OK)`; toast('出発地を設定しました');
      }
      const aiBox = h('textarea',{placeholder:'ここに日本語で注文を書く', rows:3});
      const aiMsg = h('span',{class:'small muted'});
      const aiBtn = h('button',{class:'btn', onClick: async()=>{
        const text = aiBox.value.trim(); if (!text){ toast('注文を入力してください'); return; }
        aiBtn.disabled = true; aiMsg.textContent = 'AIが読み取り中…';
        try {
          const res = await fetch('api/assist', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ instruction:text, startDate:state.startDate, days:state.days, workStart:state.workStart, workEnd:state.workEnd,
            rows: state.rows.map(r=>({ key:r.key, company:r.company, name:r.name, category:r.category, address:r.address, checked:r.checked, date:r.date, timeFrom:r.timeFrom, timeTo:r.timeTo })) }) });
          let j=null; try { j = await res.json(); } catch(e){}
          if (!res.ok) throw new Error((j&&j.error)||`失敗 (${res.status})`);
          let n=0;
          for (const u of (j.updates||[])){
            const r = state.rows.find(x=>x.key===u.key); if (!r) continue; n++;
            if (u.date!==undefined) r.date = u.date||'';
            if (u.timeFrom!==undefined) r.timeFrom = u.timeFrom||'';
            if (u.timeTo!==undefined) r.timeTo = u.timeTo||'';
            if (u.checked!==undefined) r.checked = !!u.checked;
            if (u.stayMin) r.stayMin = Number(u.stayMin)||r.stayMin;
          }
          if (j.days) { state.days = Math.min(30, Math.max(1, Math.floor(Number(j.days))||state.days)); daysInp.value = state.days; }
          if (j.startDate && /^\d{4}-\d{2}-\d{2}$/.test(j.startDate)) { state.startDate = j.startDate; startDateInp.value = j.startDate; }
          saveDraft(); renderList();
          aiMsg.textContent = (j.message||'反映しました') + ` (${n}件を更新)`;
        } catch(e){ aiMsg.textContent=''; toast('AIへの注文に失敗: '+e.message, {error:true, ms:5000}); }
        finally { aiBtn.disabled=false; }
      }}, '🤖 注文を反映');
      const buildBtn = h('button',{class:'btn primary', onClick: async()=>{
        const start = { lat:Number(state.startLat), lng:Number(state.startLng) };
        if (!hasCoord(start)){ toast('先に出発地を設定してください(設定の拠点住所、または上の欄)', {error:true}); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(state.startDate||'')){ toast('開始日を入力してください', {error:true}); return; }
        state.days = Math.min(30, Math.max(1, Math.floor(Number(state.days))||1)); daysInp.value = state.days;
        const sel = state.rows.filter(r=>r.checked);
        if (!sel.length){ toast('訪問先を選択してください', {error:true}); return; }
        const bad = sel.find(r=>r.timeFrom && r.timeTo && toMin(r.timeFrom) > toMin(r.timeTo));
        if (bad){ toast(`${rowLabel(bad)}: 時間帯の開始が終了より後になっています`, {error:true}); return; }
        if (sel.some(r=>!hasCoord(r))){ await geocodeAll(); }
        const ready = sel.filter(r=>hasCoord(r)); const skipped = sel.length - ready.length;
        if (!ready.length){ toast('座標のある訪問先がありません。住所を入力して「座標を取得」してください', {error:true}); return; }
        buildBtn.disabled = true; progress.textContent = '日ごとに振り分け中…';
        try {
          const stops = ready.map(r=>({ key:r.key, label: rowLabel(r), name:r.name, company:r.company, address:r.address, lat:Number(r.lat), lng:Number(r.lng), stayMin: r.stayMin || settings.defaultStayMin || 45, customerId:r.customerId, memo:r.memo, date:r.date||'', timeFrom:r.timeFrom||'', timeTo:r.timeTo||'' }));
          const res = await buildPlan(start, stops, state);
          state.plan = { days: res.days, unassigned: res.unassigned, itins:{} };
          saveDraft(); await computeAll(); renderPlan();
          toast(`${res.days.length}日分の計画を作成しました${res.unassigned.length?`(${res.unassigned.length}件は日数内に入りませんでした)`:''}${skipped?`(座標なし ${skipped}件は除外)`:''}`, {ms:5000});
          planEl.scrollIntoView({behavior:'smooth'});
        } catch(e){ console.error(e); toast('計画の作成に失敗: '+e.message, {error:true}); }
        finally { buildBtn.disabled=false; progress.textContent=''; }
      }}, '✨ 計画を自動作成');

      /* ===== 3. 日ごとの計画 ===== */
      const planEl = h('div');
      async function computeAll(){
        const start = { lat:Number(state.startLat), lng:Number(state.startLng) };
        for (const day of state.plan.days){ state.plan.itins[day.date] = await itinerary(start, day, state); }
        saveDraft();
      }
      async function recompute(day){ const start = { lat:Number(state.startLat), lng:Number(state.startLng) }; state.plan.itins[day.date] = await itinerary(start, day, state); saveDraft(); renderPlan(); }
      function renderPlan(){
        UI.clear(planEl);
        const p = state.plan;
        if (!p){ planEl.append(UI.empty('「計画を自動作成」を押すと、ここに日ごとの訪問計画が表示されます。')); return; }
        const we = toMin(state.workEnd) ?? 1080;
        const dayOptions = p.days.map(d=>[d.date, UI.fmtDate(d.date)]);
        const moveTo = (fromDay, stop, toDate) => { if (!toDate || (toDate!=='__un' && !p.days.find(d=>d.date===toDate))) return; fromDay.stops = fromDay.stops.filter(s=>s!==stop); if (toDate==='__un'){ p.unassigned.push(stop); } else { p.days.find(d=>d.date===toDate).stops.push(stop); } saveDraft(); computeAll().then(renderPlan); };
        p.days.forEach((day, di)=>{
          const it = p.itins[day.date];
          const over = it && it.end > we;
          const list = h('div',{class:'stop-list'});
          day.stops.forEach((s, i)=>{
            const row = it?.rows?.[i];
            list.appendChild(h('div',{class:'stop'},
              h('span',{class:'num'}, i+1),
              h('div',{class:'main'}, h('div',null, s.label, s.name ? h('span',{class:'small muted'}, ` / ${s.name}`) : null),
                h('div',{class:'sub'}, row ? `${fmtT(row.arr)} 着 → ${fmtT(row.dep)} 発 ・ 移動 ${UI.fmtMin(row.legMin)} ${row.legKm?`(${row.legKm.toFixed(1)}km)`:''}${row.wait?` ・ 待ち${UI.fmtMin(row.wait)}`:''}` : '', s.timeFrom||s.timeTo ? h('span',{class: row?.late?'text-danger':'', style:{marginLeft:'4px'}}, `[希望 ${s.timeFrom||''}〜${s.timeTo||''}${row?.late?' 遅れ':''}]`) : null, s.date ? h('span',{class:'tag'}, '日指定') : null, s.address ? ` ・ ${s.address}` : '')),
              h('div',{class:'ctl'},
                h('button',{class:'btn sm', disabled:i===0, onClick:()=>{ [day.stops[i-1],day.stops[i]]=[day.stops[i],day.stops[i-1]]; recompute(day); }}, '↑'),
                h('button',{class:'btn sm', disabled:i===day.stops.length-1, onClick:()=>{ [day.stops[i+1],day.stops[i]]=[day.stops[i],day.stops[i+1]]; recompute(day); }}, '↓'),
                h('select',{class:'sm', title:'別の日に移す', onChange:(e)=>moveTo(day, s, e.target.value)}, [['', '移す…'], ...dayOptions.filter(o=>o[0]!==day.date), ['__un','未割当へ']].map(([v,l])=>h('option',{value:v},l))),
              )));
          });
          planEl.appendChild(h('div',{class:'card'},
            h('h2',null, `${di+1}日目 ${UI.fmtDate(day.date)}`, h('span',{class:'small muted'}, ` ${day.stops.length}件`),
              it ? h('span',{class:'small '+(over?'text-danger':'muted'), style:{marginLeft:'auto'}}, `${it.distanceKm.toFixed(1)}km / 移動${UI.fmtMin(it.durationMin)} / 終了 ${fmtT(it.end)}${it.estimated?'(推定)':''}${over?' ⚠ 業務終了を超過':''}`) : null),
            (day.warnings||[]).length ? h('div',{class:'notice text-danger small'}, day.warnings.map(w=>h('div',null,'⚠ '+w))) : null,
            day.stops.length ? list : h('div',{class:'small muted'}, 'この日は訪問なし'),
            h('div',{class:'row mt'},
              h('button',{class:'btn sm', onClick: async()=>{ const start={lat:Number(state.startLat),lng:Number(state.startLng)}; try { const r = await Geo.optimize(start, day.stops, {roundTrip:state.roundTrip}); day.stops = r.stops; await recompute(day); toast('並べ直しました'); } catch(e){ toast(e.message,{error:true}); } }}, '✨ この日を最適化'),
              h('a',{class:'btn sm', href: Geo.gmapsUrl([{lat:Number(state.startLat),lng:Number(state.startLng)}, ...day.stops, ...(state.roundTrip?[{lat:Number(state.startLat),lng:Number(state.startLng)}]:[])].slice(0,11)), target:'_blank', rel:'noopener'}, '🗺️ Googleマップ'),
              h('a',{class:'btn sm', href:`#/route?date=${day.date}`}, '🚗 ルート画面(反映後)'))
          ));
        });
        if (p.unassigned.length){
          planEl.appendChild(h('div',{class:'card'}, h('h2',null,'未割当', h('span',{class:'small muted'}, ` ${p.unassigned.length}件(日数を増やすか、各日に移してください)`)),
            h('div',{class:'stop-list'}, p.unassigned.map(s=>h('div',{class:'stop'}, h('span',{class:'num', style:{background:'var(--muted)'}}, '−'), h('div',{class:'main'}, s.label, h('div',{class:'sub'}, s.address||'')),
              h('select',{onChange:(e)=>{ if(!e.target.value) return; p.unassigned = p.unassigned.filter(x=>x!==s); p.days.find(d=>d.date===e.target.value).stops.push(s); saveDraft(); computeAll().then(renderPlan); }}, [['','日を選ぶ…'], ...dayOptions].map(([v,l])=>h('option',{value:v},l))))))));
        }
        planEl.appendChild(h('div',{class:'card'}, h('h2',null,'予定表に反映'),
          h('p',{class:'small muted'}, '各日の訪問を「スケジュール」に予定として登録し、日ごとのルートも保存します。訪問先が名刺に未登録なら登録します。'),
          h('div',{class:'row'},
            h('button',{class:'btn primary', onClick:applyPlan}, '📅 予定表に反映する'),
            h('button',{class:'btn', onClick:()=>UI.copy(planText())}, '📋 計画をテキストでコピー'))));
      }
      function planText(){
        const p = state.plan; if (!p) return '';
        return p.days.map((d,i)=>{ const it = p.itins[d.date]; return `■${i+1}日目 ${UI.fmtDateLong(d.date)}\n` + d.stops.map((s,j)=>{ const r = it?.rows?.[j]; return `${j+1}. ${r?fmtT(r.arr)+'-'+fmtT(r.dep)+' ':''}${s.label}${s.name?' / '+s.name:''}${s.address?' ('+s.address+')':''}`; }).join('\n') + (it?`\n  合計 ${it.distanceKm.toFixed(1)}km / 移動 ${UI.fmtMin(it.durationMin)}`:''); }).join('\n\n');
      }
      async function applyPlan(){
        const p = state.plan; if (!p) return;
        const total = p.days.reduce((a,d)=>a+d.stops.length,0);
        const existing = p.days.flatMap(d=>Store.where('events', e=>e.date===d.date && e.type==='visit'));
        const prevCount = Store.where('events', e=>e.planId===state.id).length;
        const others = existing.filter(e=>e.planId!==state.id).length;
        const ok = await UI.confirm(`${p.days.length}日分・${total}件の訪問予定を登録します。${prevCount?`前回この計画で登録した ${prevCount} 件は置き換えます。`:''}${others?`対象日には別の訪問予定が ${others} 件あります。`:''}`, {ok:'登録する', danger:false});
        if (!ok) return;
        saveDraft();
        const planId = state.id;
        const prevEv = Store.where('events', e=>e.planId===planId), prevRt = Store.where('routes', r=>r.planId===planId);
        prevEv.forEach(e=>Store.remove('events', e.id)); prevRt.forEach(r=>Store.remove('routes', r.id));
        let ev=0, skipped=0;
        for (const day of p.days){
          const it = p.itins[day.date];
          day.stops.forEach((s,i)=>{
            const row0 = it?.rows?.[i]; if (row0 && row0.arr >= 1440){ skipped++; return; } // 翌日にまたがる行は登録しない
            const row = state.rows.find(r=>r.key===s.key);
            let cid = s.customerId;
            if (!cid && row){ registerRow(row); cid = row.customerId; s.customerId = cid; }
            const r = it?.rows?.[i];
            Store.save('events', { date: day.date, start: r?fmtT(r.arr).slice(0,5):'', end: r?fmtT(Math.min(r.dep, 1439)).slice(0,5):'', title: `${s.label} 訪問`, type:'visit', customerId: cid||'', address: s.address||'', lat:s.lat, lng:s.lng, memo: s.memo||'', status:'planned', attachmentIds:[], planId });
            ev++;
          });
          if (!day.stops.length) continue;
          Store.save('routes', { planId, date: day.date, name:`営業計画 ${UI.fmtDate(day.date)}`, startLabel: state.startLabel||'出発地', startAddress: state.startAddress, startLat: Number(state.startLat), startLng: Number(state.startLng), roundTrip: state.roundTrip, departTime: state.workStart,
            stops: day.stops.map(s=>({ customerId:s.customerId||'', label:s.label, address:s.address, lat:s.lat, lng:s.lng, stayMin:stay(s) })), distanceKm: Math.round((it?.distanceKm||0)*10)/10, durationMin: Math.round(it?.durationMin||0) });
        }
        saveDraft();
        toast(`${ev}件の予定を登録しました${prevEv.length?`(前回この計画で登録した ${prevEv.length} 件は置き換え)`:''}${skipped?`(翌日にまたがる ${skipped} 件は登録せず)`:''}`, {ms:6000});
        App.go(`schedule?view=week&date=${p.days[0].date}`);
      }
      function registerRow(r){
        const c = findCustomer(r);
        const base = c ? Object.assign({}, c) : { tags:[], memo:'' };
        Object.assign(base, { company:r.company||base.company||'', name:r.name||base.name||'', title:r.title||base.title||'', phone:r.phone||base.phone||'', address:r.address||base.address||'' });
        if (hasCoord(r)){ base.lat=r.lat; base.lng=r.lng; }
        if (r.category && !(base.tags||[]).includes(r.category)) base.tags=[...(base.tags||[]), r.category];
        r.customerId = Store.save('customers', base).id;
      }

      /* ===== 描画 ===== */
      root.append(
        h('div',{class:'page-head'}, h('h1',null,'🧭 営業計画'), h('div',{class:'spacer'}), h('span',{class:'small muted'}, 'リスト取り込み → 日ごとに振り分け → 予定表へ')),
        h('div',{class:'card'}, h('h2',null,'1. 訪問先リスト'),
          h('div',{class:'row'},
            h('button',{class:'btn', onClick:()=>camInp.click()}, '📷 写真を撮って読み取る'),
            h('button',{class:'btn', onClick:()=>fileInp.click()}, '📄 写真・PDF・Excel・CSVを取り込む'),
            h('button',{class:'btn', onClick:addFromCustomers}, '👤 名刺から選ぶ'),
            fileInp, camInp),
          h('p',{class:'small muted mt'}, '写真やPDFはAIが表を読み取ります(クラウド版のみ)。パスポート番号・生年月日・部屋番号は読み取りません。読み取り後は内容を必ず確認してください。'),
          progress, h('div',{class:'mt'}, listEl)),
        h('div',{class:'card'}, h('h2',null,'2. 計画の条件'),
          h('div',{class:'form'},
            h('div',{class:'f-row c3'}, field('開始日', startDateInp), field('日数', daysInp), h('div',{class:'f'}, h('label',null,'出発地に戻る'), h('label',{class:'row small', style:{minHeight:'40px'}}, roundChk, '毎日出発地に戻る(往復)'))),
            h('div',{class:'f-row'}, field('業務開始', wsInp), field('業務終了', weInp)),
            field('出発地(毎日の出発点)', h('div',{class:'row', style:{flexWrap:'nowrap'}}, startAddrInp, h('button',{class:'btn', onClick:setStart}, '設定')), {hint:'未入力で「設定」を押すと設定画面の拠点住所になります。出張中は宿泊ホテルの住所を入れてください。'}),
            startInfo),
          h('div',{class:'mt'}, h('h3',null,'🤖 AIに注文する(任意)'),
            h('p',{class:'small muted'}, '例:「제이여행사は2日目の午前、범한항공は最終日の15時以降」「청주市内は1日目にまとめて」「メディアは回らない」。表の希望日・時間帯・選択に反映されます(クラウド版のみ)。'),
            aiBox, h('div',{class:'row mt'}, aiBtn, aiMsg)),
          h('div',{class:'row mt'}, buildBtn, h('span',{class:'small muted'}, '選択した訪問先を、希望日・時間帯を守りつつ近い順に日ごとへ振り分け、各日の順番を最適化します。'))),
        h('h2',{class:'mt'}, '3. 日ごとの計画'), planEl
      );
      renderList(); renderPlan();
      if (params.customer){ const c = Store.get('customers', params.customer); if (c && !state.rows.some(r=>r.customerId===c.id)){ state.rows.push(Object.assign(emptyRow(), {company:c.company||'', name:c.name||'', title:c.title||'', phone:c.phone||'', address:c.address||'', lat:c.lat, lng:c.lng, customerId:c.id})); saveDraft(); renderList(); } }
    }
  });
})();
