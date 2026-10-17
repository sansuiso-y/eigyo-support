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
  const samePt = (a,b) => !!a && !!b && Math.abs(Number(a.lat)-Number(b.lat)) < 1e-6 && Math.abs(Number(a.lng)-Number(b.lng)) < 1e-6;
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  function emptyRow(){ return { key: UI.uid(), checked:true, company:'', name:'', title:'', category:'', phone:'', address:'', memo:'', stayMin:null, lat:null, lng:null, customerId:null, date:'', timeFrom:'', timeTo:'' }; }
  function rowLabel(r){ return r.company || r.name || '(名称なし)'; }
  /* 表記ゆれを吸収した正規化: 空白・括弧内(ローマ字併記など)・法人格(㈜ (주) 주식회사 株式会社 (株) 有限会社 Co.,Ltd.)を除く */
  const loose = s => String(s||'').toLowerCase()
    .replace(/[（(][^）)]*[）)]/g,'')
    .replace(/㈜|\(주\)|주식회사|株式会社|有限会社|合同会社|\(株\)|\(有\)|co\.,?\s*ltd\.?|inc\.?|corp\.?|ltd\.?/g,'')
    .replace(/[\s\u3000・.,、，\-–—_/]/g,'');
  function findCustomer(r){
    const cs = Store.list('customers');
    const rc = norm(r.company), rn = norm(r.name);
    // 1) 厳密一致(会社名+氏名)
    let hit = cs.find(c => c.company && norm(c.company)===rc && (!r.name || !c.name || norm(c.name)===rn));
    if (hit) return hit;
    const lc = loose(r.company), ln = loose(r.name);
    // 2) 氏名が一致(ゆるい比較)し、会社名が一致/片方が空/どちらかを含む
    if (ln) hit = cs.find(c => loose(c.name)===ln && (!lc || !loose(c.company) || loose(c.company)===lc || loose(c.company).includes(lc) || lc.includes(loose(c.company))));
    if (hit) return hit;
    // 3) 会社名が一致(ゆるい比較)し、どちらかの氏名が空
    if (lc) hit = cs.find(c => loose(c.company)===lc && (!ln || !loose(c.name)));
    return hit || null;
  }
  function linkFromCard(r, c){
    r.customerId = c.id;
    if (!r.company && c.company) r.company = c.company;
    if (!r.name && c.name) r.name = c.name;
    if (!r.title && c.title) r.title = c.title;
    if (!r.phone && (c.phone || c.mobile)) r.phone = c.phone || c.mobile;
    if (!r.address && c.address){ r.address = c.address; r.lat = c.lat ?? null; r.lng = c.lng ?? null; r.geoNote = ''; }
    else if (r.address && c.address && norm(r.address)===norm(c.address) && c.lat != null){ r.lat = c.lat; r.lng = c.lng; }
    if (!r.category && (c.tags||[])[0] && CATS.includes(c.tags[0])) r.category = c.tags[0];
  }
  function pickCustomer(r, onPicked){
    const all = Store.list('customers').sort((a,b)=>(a.company||'').localeCompare(b.company||'','ja'));
    const q = h('input',{type:'search', placeholder:'会社名・氏名で絞り込み', value: (r.company||r.name||'').slice(0,20)});
    const list = h('div',{class:'list', style:{maxHeight:'50vh', overflow:'auto'}});
    let m;
    function draw(){
      UI.clear(list);
      const t = loose(q.value);
      let rows = all.filter(c => !t || loose(c.company).includes(t) || loose(c.name).includes(t)).slice(0, 80);
      const fallback = !rows.length && t && all.length;
      if (fallback) rows = all.slice(0, 80); // 一致なし → 全件から選べるようにする
      // 候補が少ないときは、表記ゆれを吸収した一致を上に
      rows.sort((a,b)=> (loose(b.name)===loose(r.name)||loose(b.company)===loose(r.company)) - (loose(a.name)===loose(r.name)||loose(a.company)===loose(r.company)));
      if (!rows.length){ list.appendChild(UI.empty('名刺がまだ登録されていません。「顧客・名刺」で名刺を取り込んでから紐付けてください。')); return; }
      if (fallback) list.appendChild(h('div',{class:'small muted'}, `「${q.value}」に一致する名刺はありません。全件から選ぶか、検索語を変えてください。`));
      for (const c of rows){
        list.appendChild(h('div',{class:'item', onClick:()=>{ linkFromCard(r, c); m.close(); onPicked && onPicked(c); }},
          h('div',{class:'main'}, h('div',{class:'title'}, S.customerLabel(c)), h('div',{class:'sub'}, [c.title, c.phone||c.mobile, c.address].filter(Boolean).join(' ・ ')))));
      }
    }
    q.addEventListener('input', UI.debounce(draw, 150));
    m = UI.modal({ title:`名刺を選んで紐付け: ${rowLabel(r)}${r.name?' / '+r.name:''}`, body: h('div',null, h('div',{class:'search mb'}, q), list), actions:[{label:'キャンセル', onClick:()=>{}}] });
    draw();
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
    if (j.note) toast(`AIからの注意: ${j.note}`, { ms: 8000, error: j.total > (j.rows||[]).length });
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
  async function buildPlan(start, stops, opt, places){
    // stops: 座標ありの行 {.., date?, timeFrom?, timeTo?, stayMin}。opt: {startDate, days, workStart, workEnd, roundTrip}
    // places: 日ごとの { starts:[地点], ends:[地点|null], travelOnly:[bool] }(無ければ全日とも全体の出発地)
    const dates = Array.from({length:opt.days},(_,d)=>UI.addDays(opt.startDate,d));
    const dayStarts = places ? places.starts : dates.map(()=>start);
    const dayEnds = places ? places.ends : dates.map(()=>opt.roundTrip ? start : null);
    const travelOnly = places ? places.travelOnly : dates.map(()=>false);
    const dayWs = places && places.workStarts ? places.workStarts : dates.map(()=>null);   // 日ごとの開始時刻(分)。到着日の午後からなど
    const cap = Math.max(1, Math.floor(Number(opt.maxPerDay)) || 99);                      // 1日の訪問数の上限
    // 距離表の地点: [全体の出発地, 各日の出発地・帰着地(重複なし), ...訪問先]
    const anchors = [];
    const anchorIdx = p => { let i = anchors.findIndex(a=>samePt(a,p)); if (i < 0){ anchors.push(p); i = anchors.length-1; } return i; };
    dayStarts.forEach(p=>{ if (p) anchorIdx(p); }); dayEnds.forEach(p=>{ if (p) anchorIdx(p); });
    if (!anchors.length) anchorIdx(start);                 // 到達判定は、実際にどこかの日で使う出発地・帰着地から
    const A = anchors.length;
    const pts = [...anchors, ...stops];
    const M = await Geo.matrix(pts);               // 分
    const UNREACH = 1e5;                                   // OSRM が到達不能とした区間(1e6)の判定
    const reachable = stops.map((_,i)=> anchors.some((_,a)=> M[a][A+i] < UNREACH));
    if (!reachable.some(Boolean)){
      const far = stops.reduce((a,s)=>Math.max(a, Geo.haversineKm(anchors[0], s)), 0);
      const e = new Error(far > 300 ? `出発地から訪問先まで道路でたどり着けません(最も遠い訪問先まで約${Math.round(far)}km)。海外や遠方の出張では、出発地を「現地の宿泊ホテルや駅」に設定してください` : '出発地から訪問先への経路が見つかりません。出発地や住所の座標を確認してください');
      e.code = 'unreachable'; throw e;
    }
    const ws = toMin(opt.workStart) ?? 540, we = toMin(opt.workEnd) ?? 1080;
    stops.forEach(s=>{ delete s.note; });
    const idx = new Map(stops.map((s,i)=>[s,A+i]));
    const pidx = p => idx.has(p) ? idx.get(p) : anchorIdx(p);   // 訪問先 or 出発地・帰着地
    const travel = (a,b) => M[pidx(a)][pidx(b)];
    const days = dates.map((date,i)=>({ date, stops:[], must:[], warnings:[], travelOnly: !!travelOnly[i], start: dayStarts[i], end: dayEnds[i], workStart: dayWs[i] }));
    const unassigned = [];
    let pool = [];
    for (const s of stops){
      if (!reachable[idx.get(s) - A]){ s.note = '出発地から道路でたどり着けません(座標か出発地を確認)'; unassigned.push(s); continue; }   // reachable は訪問先の並び(0..)、idx は距離表の添字(A..)
      if (s.date){ const d = days.find(x=>x.date===s.date); if (d && d.travelOnly){ s.note = `希望日 ${s.date} は移動日のため割り当てません`; unassigned.push(s); } else if (d) d.must.push(s); else { s.note = `希望日 ${s.date} が期間外`; unassigned.push(s); } }
      else pool.push(s);
    }
    // その訪問先を回るのに一番向いた日(出発地→訪問先→帰着地が最短)の往復コスト
    const roundCost = (day, s) => day.start ? travel(day.start, s) + travel(s, day.end || day.start) : Infinity;
    const bestLaterCost = (s, i) => { let b = Infinity; for (let j = i + 1; j < days.length; j++){ if (days[j].travelOnly || !days[j].start) continue; b = Math.min(b, roundCost(days[j], s)); } return b; };
    for (let di = 0; di < days.length; di++){
      const day = days[di];
      if (day.travelOnly || !day.start){ day.must.forEach(s=>{ s.note = day.travelOnly ? `希望日 ${day.date} は移動日のため割り当てません` : `希望日 ${day.date} の出発地が決まらないため割り当てません`; unassigned.push(s); }); day.stops = []; continue; }   // 移動日(訪問なし)、または出発地が決まらない日
      const timed = day.must.filter(s=>s.timeFrom).sort((a,b)=>toMin(a.timeFrom)-toMin(b.timeFrom));
      let mustFree = day.must.filter(s=>!s.timeFrom);
      let cur = day.start, t = day.workStart ?? ws; const order = [];
      const MAX_WAIT = 60; // 希望時間まで待てる上限(分)。それ以上なら今は入れず、後で入れる
      const fits = (s, limit) => {
        let arr = t + travel(cur,s), wait = 0;
        if (s.timeFrom){ const tf = toMin(s.timeFrom); if (tf !== null && tf > arr){ wait = tf - arr; if (wait > MAX_WAIT) return null; arr = tf; } }
        if (s.timeTo){ const tt = toMin(s.timeTo); if (tt !== null && arr > tt) return null; }
        const dep = arr + stay(s);
        const after = timed.length ? travel(s, timed[0]) : (day.end ? travel(s, day.end) : 0);
        return dep + after <= limit ? {arr,dep,wait} : null;
      };
      while (true){
        const limit = timed.length ? Math.min(toMin(timed[0].timeFrom), we) : we;
        // 近い順に、次の固定時刻(または業務終了)までに収まる訪問先を入れる
        let best=null, bd=Infinity, fromMust=false;
        for (const s of mustFree){ const f=fits(s,limit); if (f && travel(cur,s)+f.wait<bd){ bd=travel(cur,s)+f.wait; best=s; fromMust=true; } }
        if (!best && order.length < cap) for (const s of pool){
          const f=fits(s,limit); if (!f) continue;
          // 後の日のほうが明らかに近い(例: ソウル泊に向かう日に回せる)訪問先は、今日は入れずに後回し
          const here = roundCost(day, s), later = bestLaterCost(s, di);
          if (later < Infinity && here > later * 2 + 30) continue;
          if (travel(cur,s)+f.wait<bd){ bd=travel(cur,s)+f.wait; best=s; }
        }   // 上限に達したら自由枠は入れない(希望日指定は入れる)
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
      day.stops = order; day._t = t; day._cur = cur; day._capHit = order.length >= cap;
      if (order.length > cap) day.warnings.push(`この日は ${order.length} 件で、1日の上限 ${cap} 件を超えています(希望日の指定があるため)`);
    }
    // 後回しにした訪問先で残っているものを、入る日(近い順)に詰める
    for (const s of pool.slice()){
      const cands = days.filter(d=>!d.travelOnly && d.start && d.stops.length < cap && !d.stops.some(x=>x.timeFrom && toMin(x.timeFrom) > (d._t||we))).map(d=>({ d, c: travel(d._cur, s) + travel(s, d.end || d.start) })).sort((a,b)=>a.c-b.c);
      for (const {d} of cands){
        let arr = d._t + travel(d._cur, s);
        if (s.timeFrom && toMin(s.timeFrom) > arr + 60) continue; if (s.timeFrom) arr = Math.max(arr, toMin(s.timeFrom)); if (s.timeTo && arr > toMin(s.timeTo)) continue;
        const dep = arr + stay(s);
        if (dep + travel(s, d.end || d.start) > we) continue;
        d.stops.push(s); d._t = dep; d._cur = s; pool = pool.filter(x=>x!==s); break;
      }
    }
    const capHit = days.some(d=>d._capHit);
    days.forEach(d=>{ delete d._t; delete d._cur; delete d._capHit; });
    pool.forEach(s=>{ s.note = (s.timeFrom || s.timeTo) ? `時間帯 ${s.timeFrom||''}〜${s.timeTo||''} を守って入れられる日がありませんでした` : capHit ? `1日の上限 ${cap} 件に収まりませんでした(上限か日数を増やしてください)` : '日数内に入りませんでした(日数を増やすか、滞在時間・業務時間を調整)'; });
    unassigned.push(...pool);
    // 時刻指定のない日は2-optで並べ直し
    for (const day of days){
      if (day.stops.length > 2 && !day.stops.some(s=>s.timeFrom)){
        try { const r = await Geo.optimize(day.start, day.stops, { roundTrip: !!day.end && samePt(day.end, day.start), end: day.end && !samePt(day.end, day.start) ? day.end : null }); day.stops = r.stops; } catch(e){}
      }
      delete day.must; delete day.start; delete day.end; delete day.workStart;   // 出発地・帰着地・開始時刻は state.dayPlaces から毎回解決する
    }
    return { days, unassigned };
  }
  const stay = s => Number(s.stayMin) > 0 ? Number(s.stayMin) : 45;
  async function itinerary(start, end, day, opt){
    // end: その日の帰着地(null なら最終訪問先で終わり)。訪問なしでも出発地≠帰着地なら移動だけの行程になる
    const pts = [start, ...day.stops]; if (end && (day.stops.length || !samePt(end, start))) pts.push(end);
    const mode = (opt.dayPlaces && opt.dayPlaces[day.date] && opt.dayPlaces[day.date].mode) || 'car';
    let r = pts.length < 2 ? { distanceKm:0, durationMin:0, geometry:[], legs:[], estimated:false } : isRoadMode(mode) ? await Geo.route(pts) : estimateRoute(pts, mode);
    // 区間ごとの手段(訪問先 i へ向かう区間 = legs[i]。戻りの区間はその日の手段)。日の手段と違う区間だけ計算し直す
    const legMode = i => (i < day.stops.length && day.stops[i].legMode) || mode;
    if (pts.length >= 2 && day.stops.some(s=>s.legMode && s.legMode !== mode)){
      const legs = (r.legs || []).slice();
      for (let i = 0; i < pts.length - 1; i++){
        const lm = legMode(i); if (lm === mode) continue;
        if (isRoadMode(lm)){ const rr = await Geo.route([pts[i], pts[i+1]]); legs[i] = (rr.legs && rr.legs[0]) || { distanceKm: rr.distanceKm, durationMin: rr.durationMin }; }
        else legs[i] = estimateRoute([pts[i], pts[i+1]], lm).legs[0];
      }
      r = Object.assign({}, r, { legs, distanceKm: legs.reduce((a,l)=>a+((l&&l.distanceKm)||0),0), durationMin: legs.reduce((a,l)=>a+((l&&l.durationMin)||0),0), byMode: r.byMode || day.stops.some(s=>s.legMode && !isRoadMode(s.legMode)) });
    }
    const ws = toMin(opt.dayPlaces && opt.dayPlaces[day.date] && opt.dayPlaces[day.date].startTime) ?? toMin(opt.workStart) ?? 540; let t = ws; const rows = [];
    day.stops.forEach((s,i)=>{ const leg = r.legs?.[i] || {durationMin:0, distanceKm:0}; let arr = t + leg.durationMin; let wait = 0; if (s.timeFrom && toMin(s.timeFrom) > arr){ wait = toMin(s.timeFrom) - arr; arr = toMin(s.timeFrom); } const late = s.timeTo && arr > toMin(s.timeTo); const dep = arr + stay(s); rows.push({ stop:s, arr, dep, wait, late, legKm:leg.distanceKm, legMin:leg.durationMin, legMode: legMode(i) }); t = dep; });
    let backMin = 0, backKm = 0; if (end && pts.length > day.stops.length + 1){ const leg = r.legs?.[day.stops.length]; if (leg){ backMin = leg.durationMin; backKm = leg.distanceKm; } }
    const travel = (!day.stops.length && pts.length >= 2) ? { from: start.label||'出発地', to: end.label||'帰着地', min: r.durationMin, km: r.distanceKm, flight: isRoadMode(mode) && !!r.estimated && r.distanceKm > 400, mode } : null;   // flight: 道路経路が取れず遠い = 飛行機などの移動(時間・距離は当てにしない)
    return { mode, byMode: !!r.byMode, rows, distanceKm: r.distanceKm, durationMin: r.durationMin, estimated: r.estimated, end: t + backMin, backMin, backKm, geometry: r.geometry || [], travel, startLabel: start.label||'', endLabel: end ? (end.label||'') : '' };
  }

  /* 移動手段。車・タクシーは道路の経路(OSRM)で計算し、それ以外は直線距離からの目安(乗り換え・待ち時間込み) */
  const MODES = [
    ['car','🚗','車', null], ['taxi','🚕','タクシー', null],
    ['shinkansen','🚄','新幹線', { detour:1.15, kmh:200, overhead:30 }], ['ktx','🚄','KTX', { detour:1.15, kmh:160, overhead:30 }],
    ['train','🚃','電車', { detour:1.25, kmh:45, overhead:15 }], ['bus','🚌','バス', { detour:1.3, kmh:60, overhead:15 }], ['walk','🚶','徒歩', { detour:1.25, kmh:4.5, overhead:0 }]
  ];
  const SEG_MODES = [...MODES, ['flight','✈️','飛行機', { detour:1.0, kmh:700, overhead:120 }], ['ship','⛴','船', { detour:1.2, kmh:30, overhead:30 }]];   // 経路の区間だけで選べる手段(飛行機は搭乗手続き・出入国込み)
  const modeOf = k => SEG_MODES.find(m=>m[0]===k) || MODES[0];
  const AIRPORT_RE = /空港|공항|airport|羽田|成田|関空|仁川|金浦/i;
  const splitRoute = memo => String(memo||'').split(/\s*(?:→|->)\s*/).map(x=>x.trim()).filter(Boolean);
  const isRoadMode = k => !modeOf(k)[3];
  function estimateRoute(pts, k){
    const sp = modeOf(k)[3]; const legs = []; let km = 0, min = 0;
    for (let i = 1; i < pts.length; i++){ const d = Geo.haversineKm(pts[i-1], pts[i]) * sp.detour; const m = d / sp.kmh * 60 + (d > 0.05 ? sp.overhead : 0); legs.push({ distanceKm:d, durationMin:m }); km += d; min += m; }
    return { distanceKm: km, durationMin: min, geometry: pts.map(p=>[Number(p.lat), Number(p.lng)]), legs, estimated:true, byMode:true };
  }

  const DAY_COLORS = ['#1f6fdb','#e0532f','#2e9e5b','#8e44ad','#d9a400','#17a2b8','#c2185b','#5d6d7e'];
  const dayColor = i => DAY_COLORS[i % DAY_COLORS.length];

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
      // 出発地の座標。未設定なら null(Number(null) が 0 になって (0,0)=ギニア湾 を出発地にしてしまう事故を防ぐ)
      const startPt = () => (isNum(state.startLat) && isNum(state.startLng)) ? { lat:Number(state.startLat), lng:Number(state.startLng) } : null;
      /* 日ごとの出発地・帰着地(state.dayPlaces[date] = { start?, end?, travelOnly? })。
         未設定の日は: 出発地 = 前日の帰着地(初日は全体の出発地)、帰着地 = 「出発地に戻る」ならその日の出発地、そうでなければ無し */
      state.dayPlaces = state.dayPlaces || {};
      const globalStart = () => { const sp = startPt(); return sp ? Object.assign({ label: state.startLabel||'出発地', address: state.startAddress||'' }, sp) : null; };
      const dayPlace = (date, kind) => { const o = state.dayPlaces[date]; const q = o && o[kind]; return (q && isNum(q.lat) && isNum(q.lng)) ? { lat:Number(q.lat), lng:Number(q.lng), label: q.label || q.address || '', address: q.address || '' } : null; };
      const isTravelOnly = date => !!(state.dayPlaces[date] && state.dayPlaces[date].travelOnly);
      function resolveStart(dates, i){ const own = dayPlace(dates[i], 'start'); if (own) return own; if (i > 0){ const pe = resolveEnd(dates, i-1); if (pe) return pe; } return globalStart(); }
      function resolveEnd(dates, i){ const own = dayPlace(dates[i], 'end'); if (own) return own; return state.roundTrip ? resolveStart(dates, i) : null; }
      const planDates = () => state.plan && state.plan.days ? state.plan.days.map(d=>d.date) : Array.from({length: Math.min(30, Math.max(1, Math.floor(Number(state.days))||1))}, (_,d)=>UI.addDays(state.startDate, d));
      const placesFor = dates => ({ starts: dates.map((_,i)=>resolveStart(dates,i)), ends: dates.map((_,i)=>resolveEnd(dates,i)), travelOnly: dates.map(d=>isTravelOnly(d)), workStarts: dates.map(d=>toMin(state.dayPlaces[d] && state.dayPlaces[d].startTime)) });
      if (!(Number(state.maxPerDay) > 0)) state.maxPerDay = 5;   // 1日の訪問数の上限(既定 5件)

      /* ===== 1. 訪問先リスト ===== */
      const listEl = h('div');
      const fileInp = h('input',{type:'file', accept:'image/*,.pdf,.csv,.xlsx,.xls,.txt', multiple:true, style:{display:'none'}, onChange: ()=>importFiles(fileInp.files)});
      const camInp = h('input',{type:'file', accept:'image/*', capture:'environment', style:{display:'none'}, onChange: ()=>importFiles(camInp.files)});
      const progress = h('div',{class:'small muted'});
      async function importFiles(files){
        let added = 0;
        for (let f0 of Array.from(files||[])){
          try {
            if (UI.isHeic(f0)){ progress.textContent = 'iPhone の写真(HEIC)を変換中…'; f0 = await UI.toJpeg(f0); }
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
        const regCount = state.rows.filter(r=>(r.customerId && Store.get('customers', r.customerId)) || findCustomer(r)).length;
        const chips = h('div',{class:'chip-row'},
          h('button',{class:'chip'+(!state.filter?' active':''), onClick:()=>{ state.filter=''; renderList(); }}, `すべて (${state.rows.length})`),
          cats.map(c=>h('button',{class:'chip'+(state.filter===c?' active':''), onClick:()=>{ state.filter=c; renderList(); }}, `${c} (${state.rows.filter(r=>r.category===c).length})`)),
          h('span',{class:'small muted', style:{alignSelf:'center'}}, `名刺: 登録済 ${regCount} / 未登録 ${state.rows.length-regCount}`));
        const visible = state.rows.filter(r=>(!state.filter || r.category===state.filter) && (!state.onlyNew || !((r.customerId && Store.get('customers', r.customerId)) || findCustomer(r))));
        const checkedCount = state.rows.filter(r=>r.checked).length;
        // 行のチェックを変えたら、表全体を描き直さずに「選択 N 件」と削除ボタンだけ更新する
        const countEl = h('span',{class:'small muted'}, `選択 ${checkedCount} 件`);
        let delBtn = null;
        const refreshSel = ()=>{ const n = state.rows.filter(r=>r.checked).length; countEl.textContent = `選択 ${n} 件`; if (delBtn) delBtn.disabled = !n; };
        const tools = h('div',{class:'row mt'},
          h('button',{class:'btn sm', onClick:()=>{ visible.forEach(r=>r.checked=true); saveDraft(); renderList(); }}, '表示中を選択'),
          h('button',{class:'btn sm', onClick:()=>{ visible.forEach(r=>r.checked=false); saveDraft(); renderList(); }}, '表示中を解除'),
          state.filter ? h('button',{class:'btn sm primary', onClick:()=>{ state.rows.forEach(r=>r.checked = r.category===state.filter); saveDraft(); renderList(); toast(`「${state.filter}」だけを選択しました`); }}, `「${state.filter}」だけ回る`) : null,
          countEl,
          h('label',{class:'row small', style:{gap:'4px'}}, h('input',{type:'checkbox', checked:!!state.onlyNew, onChange:(e)=>{ state.onlyNew=e.target.checked; saveDraft(); renderList(); }}), '名刺に未登録の行だけ表示'),
          h('span',{style:{flex:1}}),
          h('button',{class:'btn sm', title:'登録済みの名刺と自動で照合し直します(名刺を取り込んだ後に)', onClick:()=>{ let n=0; state.rows.forEach(r=>{ if (!(r.customerId && Store.get('customers', r.customerId))){ r.customerId=null; const c=findCustomer(r); if (c){ linkFromCard(r,c); n++; } } }); saveDraft(); renderList(); toast(n ? `${n}件を名刺と紐付けました` : '新たに一致する名刺はありませんでした'); }}, '🔗 名刺と照合'),
          h('button',{class:'btn sm', title:'座標のある訪問先を地図に表示します', onClick:()=>showMap(null)}, '🗺 地図で見る'),
          h('button',{class:'btn sm', onClick:lookupAddresses, title:'住所が空の行について、会社名からAIがWeb検索で所在地を調べます(要確認)'}, '🌐 AIで住所を調べる'),
          h('button',{class:'btn sm', onClick:geocodeAll}, '📍 選択行の座標を取得'),
          h('button',{class:'btn sm', onClick:registerCustomers}, '👤 選択行を名刺に登録'),
          (delBtn = h('button',{class:'btn sm danger', disabled: !checkedCount, onClick: async()=>{ const n = state.rows.filter(r=>r.checked).length; if (!n) return; if (await UI.confirm(`チェックした ${n} 件をリストから削除しますか?(名刺の登録は消えません)`)){ state.rows = state.rows.filter(r=>!r.checked); saveDraft(); renderList(); toast(`${n}件を削除しました`); } }}, '🗑 選択行を削除')),
          h('button',{class:'btn sm danger', title:'リストの全行と作成済みの計画を消します', onClick: async()=>{ const n = state.rows.length; if (await UI.confirm(`リストの ${n} 件をすべて削除しますか?(名刺の登録は消えません)`)){ state.rows=[]; state.plan=null; saveDraft(); renderList(); renderPlan(); toast('リストをすべて削除しました'); } }}, '🗑 すべて削除')
        );
        if (!state.rows.length){ listEl.append(UI.empty('まだ訪問先がありません。上のボタンから写真・PDF・Excel・名刺を取り込むか、手入力で追加してください。')); return; }
        const tbl = h('table',{class:'tbl plan-tbl'}, h('thead',null, h('tr',null, ['','名刺','会社名','氏名','役職','区分','電話','住所','希望日','時間帯','滞在','座標',''].map(t=>h('th',null,t)))));
        const tb = h('tbody');
        const cell = (r,k,attrs={}) => h('td',null, h('input',Object.assign({type:'text', value:r[k]||'', onChange:(e)=>{ r[k]=e.target.value; if (k==='address'){ r.lat=null; r.lng=null; } saveDraft(); } }, attrs)));
        for (const r of visible){
          const cust = (r.customerId && Store.get('customers', r.customerId)) || findCustomer(r) || null;
          if (cust && !r.customerId){ linkFromCard(r, cust); saveDraft(); }
          const catSel = h('select',{style:{minWidth:'130px', width:'130px'}, title:'区分', onChange:(e)=>{ r.category=e.target.value; saveDraft(); renderList(); }}, [['','(なし)'], ...CATS.map(c=>[c,c]), ...(r.category && !CATS.includes(r.category) ? [[r.category, r.category]] : [])].map(([v,l])=>h('option',{value:v, selected:v===r.category}, l)));
          const tr = h('tr',{class: r.checked?'':'muted'},
            h('td',null, h('input',{type:'checkbox', checked:r.checked, onChange:(e)=>{ r.checked=e.target.checked; tr.className = r.checked ? '' : 'muted'; saveDraft(); refreshSel(); }})),
            h('td',{class:'nowrap'}, cust
              ? h('div',{class:'row', style:{gap:'4px', flexWrap:'nowrap'}}, h('a',{class:'badge done', href:`#/customers?id=${cust.id}`, title:`名刺を開く: ${S.customerLabel(cust)}`}, '登録済'), h('button',{class:'btn sm', title:'別の名刺に紐付け直す', style:{padding:'2px 6px'}, onClick:()=>pickCustomer(r, ()=>{ saveDraft(); renderList(); toast('紐付けを変更しました'); })}, '✎'))
              : h('div',{class:'row', style:{gap:'4px', flexWrap:'nowrap'}}, h('span',{class:'badge planned', title:'名刺に未登録'}, '未登録'), h('button',{class:'btn sm', style:{padding:'2px 6px'}, title:'登録済みの名刺から選んで紐付ける', onClick:()=>pickCustomer(r, (c)=>{ saveDraft(); renderList(); toast(`「${S.customerLabel(c)}」と紐付けました`); })}, '名刺を選ぶ'))),
            cell(r,'company',{style:{minWidth:'140px'}}), cell(r,'name',{style:{minWidth:'100px'}}), cell(r,'title',{style:{minWidth:'80px'}}),
            h('td',{style:{minWidth:'140px'}}, catSel),
            cell(r,'phone',{style:{minWidth:'110px'}}),
            h('td',null, h('div',{class:'row', style:{flexWrap:'nowrap'}}, h('input',{type:'text', value:r.address||'', placeholder:'住所(ルート作成に必要)', style:{minWidth:'200px'}, onChange:(e)=>{ r.address=e.target.value; r.lat=null; r.lng=null; r.geoNote=''; saveDraft(); renderList(); }}),
              h('a',{class:'btn sm', href:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((r.company||'')+' '+(r.address||''))}`, target:'_blank', rel:'noopener', title:'地図で住所を調べる'}, '🔍'))),
            h('td',null, h('input',{type:'date', value:r.date||'', style:{width:'150px'}, onChange:(e)=>{ r.date=e.target.value; saveDraft(); }})),
            h('td',null, h('div',{class:'row', style:{flexWrap:'nowrap', gap:'2px'}}, h('input',{type:'time', value:r.timeFrom||'', style:{width:'105px'}, title:'この時刻以降', onChange:(e)=>{ r.timeFrom=e.target.value; saveDraft(); }}), '〜', h('input',{type:'time', value:r.timeTo||'', style:{width:'105px'}, title:'この時刻まで', onChange:(e)=>{ r.timeTo=e.target.value; saveDraft(); }}))),
            h('td',null, h('input',{type:'number', value:r.stayMin||'', placeholder:String(settings.defaultStayMin||45), min:5, step:5, style:{width:'70px'}, onChange:(e)=>{ r.stayMin = Number(e.target.value)||null; saveDraft(); }})),
            h('td',{class:'nowrap small'}, hasCoord(r) ? h('a',{href:'#', class:'badge '+(r.geoNote?'draft':'done'), title:(r.geoNote ? r.geoNote+' / ' : '')+'クリックで地図に表示', style:{textDecoration:'none', cursor:'pointer'}, onClick:(e)=>{ e.preventDefault(); showMap(r); }}, r.geoNote ? '要確認 🗺' : 'OK 🗺') : h('span',{class:'badge draft'}, r.address ? '未取得' : '住所なし')),
            h('td',null, h('button',{class:'btn sm', onClick:()=>{ state.rows = state.rows.filter(x=>x!==r); saveDraft(); renderList(); }}, '✕'))
          );
          tb.appendChild(tr);
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
      const maxInp = input({type:'number', value:state.maxPerDay, min:1, max:30, onChange:(e)=>{ state.maxPerDay=Math.min(30, Math.max(1, Number(e.target.value)||5)); saveDraft(); }});
      const startAddrInp = input({type:'text', value:state.startAddress, placeholder:'例: 宿泊ホテルの住所、駅名(未入力なら設定の拠点)'});
      const startInfo = h('div',{class:'small muted'}, hasCoord({lat:state.startLat,lng:state.startLng}) ? `出発地: ${state.startLabel||state.startAddress||'設定の拠点'} (座標OK)` : '出発地の座標が未設定です。上の欄に住所を入れて「設定」を押してください');
      async function setStart(){
        const a = startAddrInp.value.trim();
        if (!a){ state.startAddress = settings.homeAddress||''; state.startLat=settings.homeLat; state.startLng=settings.homeLng; state.startLabel='拠点'; }
        else { try { const g = await Geo.geocode(a); if (!g){ toast('出発地の住所が見つかりませんでした', {error:true}); return; } state.startAddress=a; state.startLat=g.lat; state.startLng=g.lng; state.startLabel=a; } catch(e){ toast(e.message,{error:true}); return; } }
        if (!hasCoord({lat:state.startLat,lng:state.startLng})){ toast('設定画面の拠点住所が未登録です。上の欄に出発地の住所を入れてください', {error:true}); return; }
        saveDraft(); startInfo.textContent = `出発地: ${state.startLabel||state.startAddress} (座標OK)`;
        if (state.plan && state.plan.days){ toast('出発地を設定しました。行程を計算し直しています…'); try { await computeAll(); } catch(e){ console.warn(e); } renderPlan(); toast('行程を計算し直しました'); }
        else toast('出発地を設定しました');
      }
      const aiBox = h('textarea',{placeholder:'ここに日本語で注文を書く(「計画を自動作成」を押すと自動で反映します)', rows:3, value: state.aiText || '', onInput:(e)=>{ state.aiText = e.target.value; saveDraft(); }});
      const aiMsg = h('span',{class:'small muted'});
      /* AIへの注文を反映する。「計画を自動作成」から、注文欄が前回の反映後に変わっていれば自動で呼ぶ。成功(または注文なし)で true */
      async function applyOrder(){
        const text = aiBox.value.trim(); if (!text) return true;
        aiBox.disabled = true; aiMsg.textContent = 'AIが注文を読み取り中…';
        try {
          const res = await fetch('api/assist', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ instruction:text, startDate:state.startDate, days:state.days, workStart:state.workStart, workEnd:state.workEnd, homeNames:[Store.settings().company||''].filter(Boolean),   // 自社名(経路の「山水荘→…」が渡航日か帰国日かの判定に使う)
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
          if (j.maxPerDay) { state.maxPerDay = Math.min(30, Math.max(1, Number(j.maxPerDay))); maxInp.value = state.maxPerDay; }
          // 移動の日程(渡航日・宿・開始時刻)を日ごとの設定に反映。場所名は住所検索で座標にする(見つからなければ名前だけ残して知らせる)
          const dp = Array.isArray(j.dayPlans) ? j.dayPlans : []; let dn = 0, moved = 0; const miss = [];
          const home = globalStart();
          const findPlace = async(name, query)=>{
            if (!name) return null;
            const co = Store.settings().company || '', ha = Store.settings().homeAddress || '';
            if (home && ((co && (name === co || co.includes(name) || name.includes(co))) || name === state.startLabel || (state.startAddress && name === state.startAddress) || (ha && ha.includes(name)))) return { lat: home.lat, lng: home.lng, address: home.address, label: name };   // 自社・拠点の名前は設定の座標を使う(地図検索だと同名の別施設に飛ぶ)
            let g = null;
            if (query && query !== name){ try { g = await Geo.geocode(query); } catch(e){} if (g) return { address: query, label: name, lat: g.lat, lng: g.lng }; }   // AIが付けた現地表記(인천국제공항 など)で先に探す
            try { g = await Geo.geocode(name); } catch(e){}
            if (g) return { address: name, label: name, lat: g.lat, lng: g.lng };
            // 地図検索で見つからない名前(日本語表記のホテル名など)は、AIのWeb検索で住所を調べてから座標にする
            try {
              const res = await fetch('api/lookup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'', rows:[{ key:'p', company:name, name:'', hint:'ホテル・駅・空港などの施設' }] }) });
              const j = res.ok ? await res.json() : null; const r0 = j && j.results && j.results[0];
              if (r0 && r0.address){ try { g = await Geo.geocode(r0.address); } catch(e){} if (g) return { address: r0.address, label: name, lat: g.lat, lng: g.lng, geoNote: `AIが住所を検索: ${r0.address}` }; }
            } catch(e){}
            return null;
          };
          for (const d of dp){
            const o = Object.assign({}, state.dayPlaces[d.date] || {});
            if (d.travelOnly !== undefined){ if (d.travelOnly) o.travelOnly = true; else delete o.travelOnly; }
            if (d.startTime) o.startTime = d.startTime;
            if (d.mode && MODES.some(m=>m[0]===d.mode)){ if (d.mode === 'car') delete o.mode; else o.mode = d.mode; }
            if (d.memo) o.memo = d.memo;
            for (const [k, nm, q] of [['start', d.startPlace, d.startQuery], ['end', d.endPlace, d.endQuery]]){
              if (!nm) continue;
              aiMsg.textContent = `場所を調べています: ${nm}…`;
              const pl = await findPlace(nm, q);
              if (pl) o[k] = pl; else { miss.push(`${UI.fmtDate(d.date)} の${k==='start'?'出発地':'帰着地'}「${nm}」`); }
            }
            const before = JSON.stringify(state.dayPlaces[d.date] || {});
            if (Object.keys(o).length) state.dayPlaces[d.date] = o; else delete state.dayPlaces[d.date];
            if (JSON.stringify(state.dayPlaces[d.date] || {}) !== before) dn++;
            if (o.travelOnly && state.plan){ const day = state.plan.days.find(x=>x.date===d.date); if (day && day.stops.length){ state.plan.unassigned.push(...day.stops); day.stops = []; moved += 1; } }   // 移動日にした日の訪問先は未割当へ
          }
          saveDraft(); renderList();
          if (dn && state.plan){ try { await computeAll(); } catch(e){ console.warn(e); } renderPlan(); }
          aiMsg.textContent = (j.message||'反映しました') + ` (${n}件を更新${dn?`、${dn}日分の移動・宿を設定`:''})` + (false && state.plan && (j.maxPerDay || dp.some(d=>d.startTime) || moved) ? ' ※振り分けに反映するには「計画を自動作成」を押し直してください' : '');
          if (miss.length) toast(`場所が見つからなかったので手で設定してください: ${miss.join('、')}`, {error:true, ms:9000});
          state.aiApplied = text; saveDraft();
          return true;
        } catch(e){ aiMsg.textContent=''; toast('AIへの注文に失敗: '+e.message, {error:true, ms:5000}); return false; }
        finally { aiBox.disabled=false; }
      }
      const buildBtn = h('button',{class:'btn primary', onClick: async()=>{
        // 注文欄に、まだ反映していない内容があれば先に反映する
        if (aiBox.value.trim() && aiBox.value.trim() !== (state.aiApplied || '')){
          buildBtn.disabled = true; const ok = await applyOrder(); buildBtn.disabled = false;
          if (!ok) return;
        }
        const start = startPt();
        if (!start){ toast('先に出発地を設定してください(設定の拠点住所、または上の欄)', {error:true}); return; }
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
          const stops = ready.map(r=>({ key:r.key, label: rowLabel(r), name:r.name, company:r.company, address:r.address, lat:Number(r.lat), lng:Number(r.lng), stayMin: r.stayMin || settings.defaultStayMin || 45, customerId:r.customerId, memo:r.memo, date:r.date||'', timeFrom:r.timeFrom||'', timeTo:r.timeTo||'', ...(r.legMode ? { legMode:r.legMode } : {}) }));
          const res = await buildPlan(start, stops, state, placesFor(Array.from({length: state.days}, (_,d)=>UI.addDays(state.startDate, d))));
          state.plan = { days: res.days, unassigned: res.unassigned, itins:{} };
          saveDraft(); await computeAll(); renderPlan();
          toast(`${res.days.length}日分の計画を作成しました${res.unassigned.length?`(${res.unassigned.length}件は日数内に入りませんでした)`:''}${skipped?`(座標なし ${skipped}件は除外)`:''}`, {ms:5000});
          planEl.scrollIntoView({behavior:'smooth'});
        } catch(e){ console.error(e); toast((e.code==='unreachable' ? '' : '計画の作成に失敗: ')+e.message, {error:true, ms:8000}); }
        finally { buildBtn.disabled=false; progress.textContent=''; }
      }}, '✨ 計画を自動作成');

      /* ===== 3. 日ごとの計画 ===== */
      const planEl = h('div');
      async function computeAll(){
        const dates = state.plan.days.map(d=>d.date);
        for (let i = 0; i < state.plan.days.length; i++){
          const day = state.plan.days[i]; const s = resolveStart(dates, i);
          if (!s){ toast(`${i+1}日目の出発地が決まりません。「2. 計画の条件」の出発地か、その日の出発地を設定してください`, {error:true}); delete state.plan.itins[day.date]; continue; }
          const e = resolveEnd(dates, i);
          state.plan.itins[day.date] = await itinerary(s, e, day, state);
          const segs = await computeSegments(day.date, s, e); if (segs) state.plan.itins[day.date].segments = segs;
        }
        saveDraft();
      }
      async function recompute(day){ const dates = state.plan.days.map(d=>d.date); const i = dates.indexOf(day.date); const s = resolveStart(dates, i); if (!s){ toast('その日の出発地が決まりません', {error:true}); return; } const e = resolveEnd(dates, i); state.plan.itins[day.date] = await itinerary(s, e, day, state); const segs = await computeSegments(day.date, s, e); if (segs) state.plan.itins[day.date].segments = segs; saveDraft(); renderPlan(); }
      /* おすすめの宿(AI + Google 検索)。各日の最終訪問先・翌日の最初の訪問先の近くで探し、「帰着地にする」で設定 */
      async function suggestHotels(){
        const p = state.plan; if (!p){ toast('先に「計画を自動作成」してください', {error:true}); return; }
        const pdates = p.days.map(d=>d.date);
        const req = p.days.map((d, i)=>{
          const own = dayPlace(d.date, 'end');
          const last = [...d.stops].reverse().find(s=>s.address) || d.stops[d.stops.length-1] || null;
          const nextDay = p.days[i+1]; const nf = nextDay ? (nextDay.stops.find(s=>s.address) || nextDay.stops[0] || null) : null;
          const ds = resolveStart(pdates, i), de = resolveEnd(pdates, i);
          return { date: d.date, lastArea: last ? (last.address || last.label) : (de && !samePt(de, ds||{}) ? (de.address || de.label) : ''), lastStops: d.stops.slice(-3).map(s=>s.label).join('、'), nextArea: nf ? (nf.address || nf.label) : '', fixed: own ? (own.address || own.label) : '' };
        }).filter((r, i)=> i < p.days.length - 1 || r.lastArea || r.nextArea);   // 最終日(帰国など)で情報が無ければ除く
        if (!req.length){ toast('宿を探す材料(訪問先)がありません', {error:true}); return; }
        const prefs = await UI.prompt('おすすめの宿を探す', { label:'希望があれば(任意。例: 駐車場あり・1泊1万円前後・朝食つき)', value: state.hotelPrefs || '', placeholder:'例: 駐車場あり、1泊 10万ウォン以内' });
        if (prefs === null) return; state.hotelPrefs = prefs; saveDraft();
        const wait = UI.modal({ title:'おすすめの宿', body: h('div',{class:'small muted'}, 'AIがWeb検索で各日の宿を探しています(20〜60秒)…'), actions:[] });
        let j = null;
        try {
          const res = await fetch('api/hotels', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ days: req, prefs }) });
          try { j = await res.json(); } catch(e){}
          if (!res.ok) throw new Error((j&&j.error)||`失敗 (${res.status})`);
        } catch(e){ wait.close(); toast('宿の検索に失敗: '+e.message, {error:true, ms:6000}); return; }
        wait.close();
        let m;
        const body = h('div', null,
          h('p',{class:'small muted'}, 'AIがWeb検索で見つけた候補です。実在・料金・空室は予約サイトで必ず確認してください。「帰着地にする」でその日の宿として設定し、翌日の出発地にもなります。'),
          (j.days||[]).map(d=>{ const di = pdates.indexOf(d.date); return h('div',{class:'card compact', style:{marginBottom:'8px'}},
            h('h3',null, `${di+1}日目 ${UI.fmtDate(d.date)} の宿`),
            d.hotels.length ? d.hotels.map(x=>h('div',{class:'file-row', style:{alignItems:'flex-start'}},
              h('div',{style:{flex:1, minWidth:0}}, h('div',null, h('b',null, x.name), x.priceHint ? h('span',{class:'small muted'}, ` ${x.priceHint}`) : null), h('div',{class:'small muted'}, [x.area, x.address].filter(Boolean).join(' / ')), x.reason ? h('div',{class:'small'}, x.reason) : null,
                h('div',{class:'row small', style:{gap:'8px', marginTop:'4px'}}, h('a',{href:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.name + ' ' + (x.address||x.area||''))}`, target:'_blank', rel:'noopener'}, '🗺️ Googleマップ'), h('a',{href:`https://map.naver.com/p/search/${encodeURIComponent(x.name)}`, target:'_blank', rel:'noopener'}, '🟢 NAVER'), h('a',{href:`https://www.google.com/search?q=${encodeURIComponent(x.name + ' 予約')}`, target:'_blank', rel:'noopener'}, '🔍 予約サイトを探す'))),
              h('button',{class:'btn sm primary', onClick: async()=>{
                let g = null; for (const q of [x.address, x.name + ' ' + (x.area||''), x.name].filter(Boolean)){ try { g = await Geo.geocode(q); } catch(e){} if (g) break; }
                if (!g){ toast('この宿の場所が見つかりませんでした。「変更」から住所を入れて設定してください', {error:true}); return; }
                const o = Object.assign({}, state.dayPlaces[d.date] || {}); o.end = { address: x.address || x.name, label: x.name, lat: g.lat, lng: g.lng }; state.dayPlaces[d.date] = o; saveDraft();
                m.close(); toast(`${UI.fmtDate(d.date)} の宿を「${x.name}」にしました。行程を計算し直しています…`); try { await computeAll(); } catch(e){ console.warn(e); } renderPlan();
              }}, '帰着地にする'))) : h('div',{class:'small muted'}, d.note || '候補が見つかりませんでした'),
            d.hotels.length && d.note ? h('div',{class:'small muted'}, d.note) : null); }),
          j.note ? h('p',{class:'small muted'}, j.note) : null);
        m = UI.modal({ title:'おすすめの宿', wide:true, body, actions:[{label:'閉じる', onClick:()=>{}}] });
      }
      /* 経路(「山水荘→羽田→仁川空港→청주역」)の区間ごとの手段と所要時間。手段は dayPlaces[date].segModes[i] */
      const SEG_Q = [[/羽田/, '東京国際空港'], [/成田/, '成田国際空港'], [/関空|関西空港/, '関西国際空港'], [/中部|セントレア/, '中部国際空港'], [/仁川/, '인천국제공항'], [/金浦/, '김포국제공항'], [/金海|釜山空港/, '김해국제공항'], [/清州空港/, '청주국제공항']];
      function segModeOf(date, i, a, b, ds, de){
        const dp = state.dayPlaces[date] || {}; const m = dp.segModes && dp.segModes[i]; if (m) return m;
        if (ds && de && a === ds.label && b === de.label) return dp.mode || 'car';   // 現地での区間はその日の手段
        if (AIRPORT_RE.test(a) && AIRPORT_RE.test(b)) return 'flight';
        return 'car';
      }
      async function segPoint(name, ds, de){
        if (ds && name === ds.label) return ds; if (de && name === de.label) return de;
        const S0 = Store.settings(), co = S0.company || '';
        if (co && isNum(S0.homeLat) && isNum(S0.homeLng) && (co.includes(name) || name.includes(co))) return { lat:Number(S0.homeLat), lng:Number(S0.homeLng) };   // 自社(山水荘)は設定の拠点
        for (const v of Object.values(state.dayPlaces)) for (const k of ['start','end']) if (v && v[k] && v[k].label === name && isNum(v[k].lat)) return v[k];
        let q = name; for (const [re, v] of SEG_Q) if (re.test(name)){ q = v; break; }
        try { const g = await Geo.geocode(q); if (g) return g; } catch(e){}
        return null;
      }
      async function computeSegments(date, ds, de){
        const memo = (state.dayPlaces[date] || {}).memo || ''; if (!/→|->/.test(memo)) return null;
        const pts = splitRoute(memo); if (pts.length < 2) return null;
        const segs = [];
        for (let i = 0; i < pts.length - 1; i++){
          const a = pts[i], b = pts[i+1], mode = segModeOf(date, i, a, b, ds, de);
          const pa = await segPoint(a, ds, de), pb = await segPoint(b, ds, de);
          let min = null, km = null;
          if (pa && pb){
            if (isRoadMode(mode)){ const rr = await Geo.route([pa, pb]); min = rr.durationMin; km = rr.distanceKm; }
            else { const L = estimateRoute([pa, pb], mode).legs[0]; min = L.durationMin; km = L.distanceKm; }
          }
          segs.push({ from:a, to:b, mode, min, km, estimated: !isRoadMode(mode) });
        }
        return segs;
      }
      async function setSegMode(day, i, mode, isLocal){
        const o = Object.assign({}, state.dayPlaces[day.date] || {}); o.segModes = Object.assign({}, o.segModes || {}); o.segModes[i] = mode;
        if (isLocal){ if (mode === 'car') delete o.mode; else if (MODES.some(m=>m[0]===mode)) o.mode = mode; }   // 現地での区間の手段は、その日の移動計算にも使う
        state.dayPlaces[day.date] = o; saveDraft(); await recompute(day);
      }
      /* 行程エディタ: 場所を行く順に並べ、間の移動手段を選ぶ(時間は入れない。所要時間の目安は自動計算)。
         保存先: dayPlaces[date].memo = 「A→B→C」、segModes = {区間番号: 手段}、note = メモ(便名など) */
      async function editMemo(date, di){
        const dp0 = state.dayPlaces[date] || {};
        const dates = planDates(); const ix = dates.indexOf(date);
        const ds = ix >= 0 ? resolveStart(dates, ix) : null, de = ix >= 0 ? resolveEnd(dates, ix) : null;
        const hasRoute = /→|->/.test(dp0.memo || '');
        let pts = hasRoute ? splitRoute(dp0.memo) : [];
        if (pts.length < 2) pts = [ds ? ds.label : '', de && !(ds && samePt(ds, de)) ? de.label : ''];   // 初期値: その日の出発地 → 帰着地
        let modes = pts.slice(0, -1).map((a, k)=>segModeOf(date, k, a, pts[k+1], ds, de));
        const note = h('input',{type:'text', value: dp0.note || (hasRoute ? '' : (dp0.memo || '')), placeholder:'便名・集合場所など(任意)'});
        const listEl = h('div');
        function draw(){
          UI.clear(listEl);
          pts.forEach((p, k)=>{
            listEl.appendChild(h('div',{class:'row', style:{gap:'6px', alignItems:'center', flexWrap:'nowrap', marginBottom:'4px'}},
              h('span',{class:'num', style:{flexShrink:0}}, k+1),
              h('input',{type:'text', value:p, placeholder: k === 0 ? '出発する場所(例: 山水荘)' : '次の場所(例: 羽田空港)', style:{flex:1, minWidth:0}, onInput:(e)=>{ pts[k] = e.target.value; }}),
              h('button',{class:'btn sm', disabled:k===0, title:'上へ', onClick:()=>{ [pts[k-1], pts[k]] = [pts[k], pts[k-1]]; draw(); }}, '↑'),
              h('button',{class:'btn sm', disabled:k===pts.length-1, title:'下へ', onClick:()=>{ [pts[k+1], pts[k]] = [pts[k], pts[k+1]]; draw(); }}, '↓'),
              h('button',{class:'btn sm danger', disabled:pts.length<=2, title:'この場所を消す', onClick:()=>{ const mi = k === pts.length-1 ? k-1 : k; pts.splice(k, 1); modes.splice(mi, 1); draw(); }}, '✕')));
            if (k < pts.length - 1) listEl.appendChild(h('div',{class:'row small', style:{gap:'6px', alignItems:'center', margin:'0 0 6px 34px'}},
              h('span',{class:'muted'}, '↓'),
              h('select',{class:'sm', style:{width:'auto', minHeight:'28px', padding:'2px 6px'}, onChange:(e)=>{ modes[k] = e.target.value; }}, SEG_MODES.map(([mk, ic, lb])=>h('option',{value:mk, selected:(modes[k] || 'car') === mk}, `${ic} ${lb}`)))));
          });
        }
        draw();
        async function save(clear){
          const o = Object.assign({}, state.dayPlaces[date] || {});
          if (clear){ delete o.memo; delete o.segModes; delete o.note; }
          else {
            const idx = pts.map((x, k)=>String(x||'').trim() ? k : -1).filter(k=>k >= 0);   // 空欄は飛ばす
            const kept = idx.map(k=>pts[k].trim());
            if (kept.length >= 2){
              o.memo = kept.join('→'); o.segModes = {};
              for (let k = 0; k < idx.length - 1; k++) o.segModes[k] = modes[idx[k+1] - 1] || 'car';   // 次の場所の直前の区間の手段
              for (let k = 0; k < kept.length - 1; k++) if (ds && de && kept[k] === ds.label && kept[k+1] === de.label && MODES.some(m=>m[0]===o.segModes[k])){ if (o.segModes[k] === 'car') delete o.mode; else o.mode = o.segModes[k]; }   // 現地での区間はその日の移動計算にも
            } else { delete o.memo; delete o.segModes; }
            const nt = note.value.trim(); if (nt) o.note = nt; else delete o.note;
          }
          if (Object.keys(o).length) state.dayPlaces[date] = o; else delete state.dayPlaces[date];
          saveDraft(); const day = state.plan && state.plan.days.find(d=>d.date===date); if (day) await recompute(day); else renderPlan();
        }
        UI.modal({ title:`${di+1}日目 ${UI.fmtDate(date)} の行程`,
          body: h('div',{class:'form'},
            h('p',{class:'small muted'}, '行く順に場所を並べ、間の移動手段を選んでください。時間は入れなくて大丈夫です(所要時間の目安は自動で出します)。'),
            listEl,
            h('div',{class:'row'}, h('button',{class:'btn sm', onClick:()=>{ pts.push(''); modes.push('car'); draw(); setTimeout(()=>{ const ins = listEl.querySelectorAll('input'); ins[ins.length-1]?.focus(); }, 0); }}, '＋ 場所を追加')),
            h('div',{class:'f mt'}, h('label',null,'メモ'), note)),
          actions:[ {label:'キャンセル', onClick:()=>{}}, ...(dp0.memo || dp0.note ? [{label:'行程を消す', onClick:()=>{ save(true); }}] : []), {label:'保存', cls:'primary', onClick:()=>{ save(false); }} ] });
      }
      /* 日ごとの出発地・帰着地の変更 */
      async function editPlace(date, kind, di){
        const cur = dayPlace(date, kind); const label = kind === 'start' ? '出発地' : '帰着地(その日の宿)';
        const inp = h('input',{type:'text', value: cur ? (cur.address || cur.label) : '', placeholder:'ホテル名・住所・駅名(例: 청주 ○○호텔)'});
        const note = h('div',{class:'small muted'}, kind === 'start' ? '未設定なら、前日の帰着地(初日は全体の出発地)から出発します。' : '未設定なら、「出発地に戻る」が有効ならその日の出発地へ、無効なら最終訪問先で終わります。');
        let m;
        const apply = async(place)=>{
          const o = Object.assign({}, state.dayPlaces[date] || {}); if (place) o[kind] = place; else delete o[kind];
          if (Object.keys(o).length) state.dayPlaces[date] = o; else delete state.dayPlaces[date];
          saveDraft(); m.close();
          if (state.plan){ toast('行程を計算し直しています…'); try { await computeAll(); } catch(e){ console.warn(e); } }
          renderPlan();
        };
        m = UI.modal({ title: `${di+1}日目 ${UI.fmtDate(date)} の${label}`, body: h('div',{class:'form'}, h('div',{class:'f'}, h('label',null, label), inp), note),
          actions:[ {label:'キャンセル', onClick:()=>{}}, ...(cur ? [{label:'既定に戻す', onClick:()=>{ apply(null); return false; }}] : []),
            {label:'設定', cls:'primary', onClick: async()=>{ const a = inp.value.trim(); if (!a){ toast('場所を入力してください', {error:true}); return false; } let g = null; try { g = await Geo.geocode(a); } catch(e){} if (!g){ toast('場所が見つかりませんでした。別の表記(ホテル名・駅名など)で試してください', {error:true}); return false; } apply({ address: a, label: a, lat: g.lat, lng: g.lng }); return false; }} ] });
        setTimeout(()=>inp.focus(), 50);
      }
      async function setTravelOnly(day, on){
        const o = Object.assign({}, state.dayPlaces[day.date] || {}); if (on) o.travelOnly = true; else delete o.travelOnly;
        if (Object.keys(o).length) state.dayPlaces[day.date] = o; else delete state.dayPlaces[day.date];
        if (on && day.stops.length){ state.plan.unassigned.push(...day.stops); day.stops = []; toast('この日の訪問先を未割当に移しました。別の日に入れてください', {ms:4000}); }
        saveDraft(); try { await computeAll(); } catch(e){ console.warn(e); } renderPlan();
      }
      /* その日の行程を地図アプリで開く。日本なら Googleマップ、韓国なら NAVER マップ(Google は韓国で車ルート案内が制限されるため)。
         NAVER はアプリの URL スキーム(経由地は5か所まで、スマホにアプリが必要)。PC では出発地→最終目的地のウェブ版リンク */
      const inKorea = p => Number(p.lat) >= 33 && Number(p.lat) <= 39 && Number(p.lng) >= 124 && Number(p.lng) <= 132;
      const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
      function dayPoints(day){
        const dates = planDates(); const i = dates.indexOf(day.date); const sp = resolveStart(dates, i); if (!sp) return [];
        const ep = resolveEnd(dates, i); const stops = day.stops.filter(hasCoord).map(s=>({lat:Number(s.lat), lng:Number(s.lng), label:s.label||s.name||''}));
        return [sp, ...stops, ...((ep && (stops.length || !samePt(ep, sp))) ? [ep] : [])];
      }
      function naverLinks(pts, mode){
        const nm = isRoadMode(mode) ? 'car' : mode === 'walk' ? 'walk' : 'public';
        const app = 'appname=' + encodeURIComponent(location.origin || 'eigyo-support');
        const links = [];
        for (let i = 0; i + 1 < pts.length; i += 6){ // 出発 + 経由地5 + 目的地 = 7点ずつ。次の区間は前の目的地から
          const seg = pts.slice(i, i + 7); const s0 = seg[0], d = seg[seg.length-1], vias = seg.slice(1, -1);
          const q = [`slat=${s0.lat}`, `slng=${s0.lng}`, `sname=${encodeURIComponent(s0.label)}`, `dlat=${d.lat}`, `dlng=${d.lng}`, `dname=${encodeURIComponent(d.label)}`, ...vias.map((v,k)=>`v${k+1}lat=${v.lat}&v${k+1}lng=${v.lng}&v${k+1}name=${encodeURIComponent(v.label)}`), app].join('&');
          links.push({ app: `nmap://route/${nm}?${q}`, from: s0.label, to: d.label, vias: nm === 'car' ? vias.length : 0 });
          if (nm !== 'car') break;   // 公共交通・徒歩は経由地なしの1本
        }
        // PC のウェブ版は経由地を渡せないので、出発地 → 最終訪問先(往復の戻りは省く)の1本だけ
        const last = (pts.length > 2 && pts[pts.length-1].lat === pts[0].lat && pts[pts.length-1].lng === pts[0].lng) ? pts[pts.length-2] : pts[pts.length-1];
        const web = { href: `https://map.naver.com/p/directions/${pts[0].lng},${pts[0].lat},${encodeURIComponent(pts[0].label)}/${last.lng},${last.lat},${encodeURIComponent(last.label)}/-/${nm === 'public' ? 'transit' : nm}`, from: pts[0].label, to: last.label };
        return { links, web };
      }
      function openNaver(day){
        const pts = dayPoints(day); if (pts.length < 2){ toast('座標のある訪問先がありません', {error:true}); return; }
        const { links, web } = naverLinks(pts, (state.dayPlaces[day.date] || {}).mode || 'car');
        const body = h('div', null,
          h('p',{class:'small muted'}, isMobile ? 'NAVER マップのアプリが開きます(インストールが必要)。経由地は1回に5か所までなので、多い日は区間ごとに分けています。' : 'PC のブラウザでは経由地を渡せないため、出発地 → 最終訪問先のリンクです。スマホで開くとアプリに経由地まで渡せます。'),
          h('div',{class:'list'}, isMobile
            ? links.map((l,i)=>h('a',{class:'btn', href:l.app, style:{display:'block', marginBottom:'6px'}}, `${links.length>1?`区間${i+1}: `:''}${l.from} → ${l.to}${l.vias?`(経由 ${l.vias}か所)`:''}`))
            : h('a',{class:'btn', href:web.href, target:'_blank', rel:'noopener', style:{display:'block'}}, `${web.from} → ${web.to}`)));
        UI.modal({ title:'NAVER マップで開く', body, actions:[{label:'閉じる', onClick:()=>{}}] });
      }
      function navButtons(day){
        const itx = state.plan && state.plan.itins && state.plan.itins[day.date]; if (itx && itx.travel && itx.travel.flight) return []; // 飛行機などの移動日は車ルートを出さない
        const pts = dayPoints(day); if (pts.length < 2) return []; // 訪問も移動もない日はボタンなし
        const korea = pts.some(inKorea);
        const mode = (state.dayPlaces[day.date] || {}).mode || 'car';
        const gmode = isRoadMode(mode) ? 'driving' : mode === 'walk' ? 'walking' : 'transit';
        const gurl = gmode === 'driving' ? Geo.gmapsUrl(pts.slice(0,11)) : `https://www.google.com/maps/dir/?api=1&origin=${pts[0].lat},${pts[0].lng}&destination=${pts[pts.length-1].lat},${pts[pts.length-1].lng}&travelmode=${gmode}`;   // 公共交通・徒歩は経由地を渡せない
        const g = h('a',{class:'btn sm'+(korea?'':' primary'), href: gurl, target:'_blank', rel:'noopener', title: korea ? '韓国では Google の車ルート案内が制限されます' : 'Googleマップで経路を開く(経由地は9か所まで)'}, '🗺️ Googleマップ');
        const n = h('button',{class:'btn sm'+(korea?' primary':''), title:'NAVER マップで経路を開く(韓国向け)', onClick:()=>openNaver(day)}, '🟢 NAVERマップ');
        return korea ? [n, g] : [g, n];
      }
      function renderPlan(){
        UI.clear(planEl);
        const p = state.plan;
        if (!p){ planEl.append(UI.empty('「計画を自動作成」を押すと、ここに日ごとの訪問計画が表示されます。')); return; }
        const we = toMin(state.workEnd) ?? 1080;
        const dayOptions = p.days.filter(d=>!isTravelOnly(d.date)).map(d=>[d.date, UI.fmtDate(d.date)]);   // 移動日には移せない
        const moveTo = (fromDay, stop, toDate) => { if (!toDate || (toDate!=='__un' && !p.days.find(d=>d.date===toDate))) return; fromDay.stops = fromDay.stops.filter(s=>s!==stop); if (toDate==='__un'){ p.unassigned.push(stop); } else { p.days.find(d=>d.date===toDate).stops.push(stop); } saveDraft(); computeAll().then(renderPlan); };
        p.days.forEach((day, di)=>{
          const it = p.itins[day.date];
          const over = it && it.end > we;
          const list = h('div',{class:'stop-list'});
          day.stops.forEach((s, i)=>{
            const row = it?.rows?.[i];
            list.appendChild(h('div',{class:'stop'},
              h('span',{class:'num'}, i+1),
              h('div',{class:'main'}, h('div',null, s.label, s.name ? h('span',{class:'small muted'}, ` / ${s.name}`) : null, s.customerId && Store.get('customers', s.customerId) ? h('a',{class:'tag', href:`#/customers?id=${s.customerId}`, title:'名刺を開く'}, '名刺') : null),
                h('div',{class:'sub'}, row ? `${fmtT(row.arr)} 着 → ${fmtT(row.dep)} 発 ・ ${modeOf(row.legMode || (it && it.mode))[1]} 移動 ${UI.fmtMin(row.legMin)} ${row.legKm?`(${row.legKm.toFixed(1)}km)`:''}${row.wait?` ・ 待ち${UI.fmtMin(row.wait)}`:''}` : '', s.timeFrom||s.timeTo ? h('span',{class: row?.late?'text-danger':'', style:{marginLeft:'4px'}}, `[希望 ${s.timeFrom||''}〜${s.timeTo||''}${row?.late?' 遅れ':''}]`) : null, s.date ? h('span',{class:'tag'}, '日指定') : null, s.address ? ` ・ ${s.address}` : '')),
              h('div',{class:'ctl'},
                h('select',{class:'sm', title:'ここへ向かう移動手段', style:{width:'auto'}, onChange: async(e)=>{
                  const v = e.target.value, base = (state.dayPlaces[day.date] || {}).mode || 'car';
                  if (v === base) delete s.legMode; else s.legMode = v;
                  const rowRef = state.rows.find(r=>r.key===s.key); if (rowRef){ if (s.legMode) rowRef.legMode = s.legMode; else delete rowRef.legMode; }   // 計画を作り直しても残す
                  saveDraft(); await recompute(day);
                }}, MODES.map(([k, ic, lb])=>h('option',{value:k, selected: (s.legMode || (state.dayPlaces[day.date] || {}).mode || 'car') === k}, `${ic} ${lb}`))),
                h('button',{class:'btn sm', disabled:i===0, onClick:()=>{ [day.stops[i-1],day.stops[i]]=[day.stops[i],day.stops[i-1]]; recompute(day); }}, '↑'),
                h('button',{class:'btn sm', disabled:i===day.stops.length-1, onClick:()=>{ [day.stops[i+1],day.stops[i]]=[day.stops[i],day.stops[i+1]]; recompute(day); }}, '↓'),
                h('select',{class:'sm', title:'別の日に移す', onChange:(e)=>moveTo(day, s, e.target.value)}, [['', '移す…'], ...dayOptions.filter(o=>o[0]!==day.date), ['__un','未割当へ']].map(([v,l])=>h('option',{value:v},l))),
              )));
          });
          const pdates = p.days.map(d=>d.date); const ds = resolveStart(pdates, di), de = resolveEnd(pdates, di); const dp = state.dayPlaces[day.date] || {};
          const placesRow = h('div',{class:'row small', style:{gap:'6px', alignItems:'center', flexWrap:'wrap', marginBottom:'6px'}},
            h('span',null, '出発: ', h('b',null, ds ? ds.label : '未設定'), h('span',{class:'muted'}, dp.start ? '' : ((di > 0 && resolveEnd(pdates, di-1) && !samePt(resolveEnd(pdates, di-1), globalStart())) ? '(前日の帰着地)' : '(全体の出発地)'))),
            h('button',{class:'btn sm', style:{padding:'2px 8px'}, onClick:()=>editPlace(day.date, 'start', di)}, '変更'),
            h('span',{style:{marginLeft:'8px'}}, '帰着: ', h('b',null, de ? de.label : 'なし(最終訪問先で終了)'), h('span',{class:'muted'}, dp.end ? '' : (de ? '(出発地に戻る)' : ''))),
            h('button',{class:'btn sm', style:{padding:'2px 8px'}, onClick:()=>editPlace(day.date, 'end', di)}, '変更'),
            h('label',{class:'row small', style:{gap:'4px', marginLeft:'8px', cursor:'pointer'}}, h('input',{type:'checkbox', checked: !!dp.travelOnly, onChange:(e)=>setTravelOnly(day, e.target.checked)}), '移動日(訪問なし)'),
            h('label',{class:'row small', style:{gap:'4px', marginLeft:'8px'}, title:'この日の基本の移動手段。訪問先ごとの区間は各行で変えられます'}, '移動手段',
              h('select',{class:'sm', style:{width:'auto', minHeight:'28px', padding:'2px 6px'}, onChange: async(e)=>{ const o = Object.assign({}, state.dayPlaces[day.date] || {}); if (e.target.value === 'car') delete o.mode; else o.mode = e.target.value; if (Object.keys(o).length) state.dayPlaces[day.date] = o; else delete state.dayPlaces[day.date]; saveDraft(); try { await computeAll(); } catch(err){ console.warn(err); } renderPlan(); }},
                MODES.map(([k, ic, lb])=>h('option',{value:k, selected: (dp.mode || 'car') === k}, `${ic} ${lb}`)))));
          planEl.appendChild(h('div',{class:'card'},
            h('h2',null, `${di+1}日目 ${UI.fmtDate(day.date)}`, h('span',{class:'small muted'}, dp.travelOnly ? ' 移動日' : ` ${day.stops.length}件`),
              it && !(it.travel && it.travel.flight) ? h('span',{class:'small '+(over?'text-danger':'muted'), style:{marginLeft:'auto'}}, dp.travelOnly ? ((it.segments && it.segments.length && it.segments.every(x=>x.min != null)) ? `${it.segments.map(x=>modeOf(x.mode)[1]).join('')} 移動 約${UI.fmtMin(it.segments.reduce((a,x)=>a+x.min,0))}(目安)` : `${modeOf(it.mode)[1]} ${it.distanceKm.toFixed(1)}km / 移動${UI.fmtMin(it.durationMin)}${it.estimated?'(推定)':''}`) : `${it.distanceKm.toFixed(1)}km / 移動${UI.fmtMin(it.durationMin)} / 終了 ${fmtT(it.end)}${it.estimated?'(推定)':''}${over?' ⚠ 業務終了を超過':''}`) : null),
            (day.warnings||[]).length ? h('div',{class:'notice text-danger small'}, day.warnings.map(w=>h('div',null,'⚠ '+w))) : null,
            placesRow,
            dp.memo ? (/→|->/.test(dp.memo)
              ? (()=>{ const pts = splitRoute(dp.memo); const segs = (it && it.segments) || []; const total = segs.length && segs.every(x=>x.min != null) ? segs.reduce((a,x)=>a+x.min,0) : null;
                  return h('div',{style:{marginBottom:'6px'}},
                    h('div',{class:'row small', style:{gap:'6px', alignItems:'center', flexWrap:'wrap'}}, h('span',null,'🧭 経路'), total != null ? h('span',{class:'muted'}, `合計 約${UI.fmtMin(total)}(目安)`) : null, h('button',{class:'btn sm', style:{padding:'2px 8px'}, onClick:()=>editMemo(day.date, di)}, '行程を編集')),
                    h('div',{class:'list', style:{marginTop:'4px'}}, pts.slice(0, -1).map((a, k)=>{ const b = pts[k+1]; const sg = segs[k]; const isLocal = !!(ds && de && a === ds.label && b === de.label); const cur = (sg && sg.mode) || segModeOf(day.date, k, a, b, ds, de);
                      return h('div',{class:'row small', style:{gap:'6px', alignItems:'center', flexWrap:'wrap', padding:'2px 0'}},
                        h('span',{class:'badge'+(isLocal?' done':'')}, a), h('span',{class:'muted'},'→'), h('span',{class:'badge'+(isLocal?' done':'')}, b),
                        h('select',{class:'sm', style:{width:'auto', minHeight:'28px', padding:'2px 6px'}, title:'この区間の移動手段', onChange:(e)=>setSegMode(day, k, e.target.value, isLocal)}, SEG_MODES.map(([mk, ic, lb])=>h('option',{value:mk, selected: cur === mk}, `${ic} ${lb}`))),
                        h('span',{class:'muted'}, sg ? (sg.min != null ? `約${UI.fmtMin(sg.min)}${sg.km ? ` (${sg.km.toFixed(0)}km)` : ''}${sg.estimated ? ' 目安' : ''}` : '場所が見つからず時間は未計算') : ''));
                    })));
                })()
              : h('div',{class:'row small', style:{gap:'6px', alignItems:'center', marginBottom:'6px'}}, h('span',null, `📝 ${dp.memo}`), h('button',{class:'btn sm', style:{padding:'2px 8px'}, onClick:()=>editMemo(day.date, di)}, '変更')))
              : (dp.travelOnly ? h('div',{class:'row small', style:{marginBottom:'6px'}}, h('button',{class:'btn sm', style:{padding:'2px 8px'}, onClick:()=>editMemo(day.date, di)}, '＋ 行程を作る')) : null),
            dp.note ? h('div',{class:'small', style:{marginBottom:'6px'}}, `📝 ${dp.note}`) : null,
            dp.startTime ? h('div',{class:'small muted', style:{marginBottom:'6px'}}, `この日の活動開始 ${dp.startTime}`) : null,
            it && it.travel && !(it.segments && it.segments.length) ? h('div',{class:'small', style:{marginBottom:'6px'}}, it.travel.flight ? `✈️ 移動 ${it.travel.from} → ${it.travel.to}(飛行機などの移動。所要時間は計算していません)` : `${modeOf(it.mode)[1]} ${modeOf(it.mode)[2]}で移動 ${it.travel.from} → ${it.travel.to} ・ ${UI.fmtMin(it.travel.min)}${it.travel.km ? ` (${it.travel.km.toFixed(1)}km)` : ''}${it.byMode ? '(目安: 直線距離から推定、乗り換え・待ち込み)' : it.estimated ? '(推定)' : ''}`) : null,
            dp.travelOnly && !dp.memo && !(ds && de && !samePt(ds, de)) ? h('div',{class:'small text-warn', style:{marginBottom:'6px'}}, '移動日です。「出発」「帰着」で空港や次の宿を設定すると移動の行程が出ます') : null,
            day.stops.length ? list : h('div',{class:'small muted'}, dp.travelOnly ? '移動日(訪問なし)' : 'この日は訪問なし'),
            h('div',{class:'row mt'},
              !day.stops.length ? null : h('button',{class:'btn sm', onClick: async()=>{ if (!ds){ toast('その日の出発地が決まりません', {error:true}); return; } try { const r = await Geo.optimize(ds, day.stops, { roundTrip: !!de && samePt(de, ds), end: de && !samePt(de, ds) ? de : null }); day.stops = r.stops; await recompute(day); toast('並べ直しました'); } catch(e){ toast(e.message,{error:true}); } }}, '✨ この日を最適化'),
              ...navButtons(day),
              day.stops.length ? h('a',{class:'btn sm', href:`#/route?date=${day.date}`}, '🚗 ルート画面(反映後)') : null)
          ));
        });
        /* 全日程を1枚の地図に(日ごとに色分け) */
        const pd0 = p.days.map(d=>d.date);
        if (MapKit.available() && p.days.some((d,i)=>d.stops.some(hasCoord) || (resolveStart(pd0,i) && resolveEnd(pd0,i) && !samePt(resolveStart(pd0,i), resolveEnd(pd0,i))))){
          const mapEl = h('div',{class:'map', style:{height:'480px'}});
          const legend = h('div',{class:'row small mt', style:{gap:'10px', flexWrap:'wrap'}}, p.days.map((d,i)=>h('span',{class:'row', style:{gap:'4px', alignItems:'center'}}, h('span',{style:{display:'inline-block', width:'12px', height:'12px', borderRadius:'50%', background:dayColor(i)}}), `${i+1}日目 ${UI.fmtDate(d.date)}(${d.stops.length}件)`)), h('span',{class:'muted'}, 'S = 出発地・帰着地(宿)。点線 = 道路経路が取れず直線で推定'));
          planEl.appendChild(h('div',{class:'card'}, h('h2',null, '全日程の地図'), mapEl, legend));
          setTimeout(async()=>{
            try {
              const m = await MapKit.create(mapEl, {scrollWheelZoom:false});
              if (!m){ legend.textContent = '地図を表示できませんでした'; return; }
              const pts = [];
              const pdates = p.days.map(d=>d.date);
              // 出発地・帰着地(日ごとに違ってよい)。同じ地点は1つのピンにまとめ、吹き出しに役割を列挙
              const anchors = [];
              p.days.forEach((d, di)=>{ const s = resolveStart(pdates, di), e = resolveEnd(pdates, di); [[s, `${di+1}日目 出発`], [e, `${di+1}日目 帰着`]].forEach(([q, role])=>{ if (!q) return; let a = anchors.find(x=>samePt(x, q)); if (!a){ a = { lat:q.lat, lng:q.lng, label:q.label, address:q.address||'', roles:[] }; anchors.push(a); } a.roles.push(role); }); });
              anchors.forEach((a, k)=>{ m.marker(a, { text: anchors.length > 1 ? `S${k+1}` : 'S', cls:'start', popup: h('div',null, h('b',null, a.label||'出発地'), h('div',{class:'small muted'}, a.address||''), h('div',{class:'small'}, a.roles.join(' / ')), placeLinks(a)) }); pts.push([a.lat, a.lng]); });
              p.days.forEach((d, di)=>{
                const it = p.itins[d.date]; const col = dayColor(di); const ds = resolveStart(pdates, di), de = resolveEnd(pdates, di);
                const hasVisit = d.stops.some(hasCoord), hasMove = !!(ds && de && !samePt(ds, de));
                if (!hasVisit && !hasMove) return; // 訪問も移動もない日は線を引かない
                if (!hasVisit && it && it.travel && it.travel.flight) return; // 飛行機などの移動は線を引かない
                const g0 = it && it.geometry && it.geometry.length > 1 ? it.geometry[0] : null;
                const stale = !ds || !g0 || Geo.haversineKm(ds, {lat:g0[0], lng:g0[1]}) > 50; // 出発地なし/変更前に計算した経路線は使わない
                if (!stale){ m.line(it.geometry, { color:col, weight:4, opacity:.75, dashed: !!it.estimated }); }
                else { const line = [ds, ...d.stops.filter(hasCoord), ...(de ? [de] : [])].filter(q=>q && hasCoord(q)).map(q=>[Number(q.lat),Number(q.lng)]); if (line.length > 1) m.line(line, { color:col, weight:3, opacity:.6, dashed:true }); }
                d.stops.forEach((st, i)=>{ if (!hasCoord(st)) return; const row = it?.rows?.[i];
                  m.marker(st, { text:i+1, color:col, popup: h('div',null, h('b',null, st.label||''), st.name ? h('div',{class:'small'}, st.name) : null, h('div',{class:'small muted'}, `${di+1}日目 ${UI.fmtDate(d.date)}${row ? ' ' + fmtT(row.arr) + ' 着' : ''}`), h('div',{class:'small muted'}, st.address||''), placeLinks(st)) });
                  pts.push([Number(st.lat), Number(st.lng)]); });
              });
              m.invalidate();
              m.fit(pts);
              if (!anchors.length) legend.appendChild(h('div',{class:'text-danger', style:{width:'100%'}}, '⚠ 出発地が未設定のため経路線は表示していません。「2. 計画の条件」で出発地を設定すると行程を計算し直します。'));
            } catch(e){ console.warn('plan map failed', e); legend.textContent = '地図の表示に失敗しました: ' + (e.message||e); }
          }, 60);
        }
        if (p.unassigned.length){
          planEl.appendChild(h('div',{class:'card'}, h('h2',null,'未割当', h('span',{class:'small muted'}, ` ${p.unassigned.length}件(日数を増やすか、各日に移してください)`)),
            h('div',{class:'stop-list'}, p.unassigned.map(s=>h('div',{class:'stop'}, h('span',{class:'num', style:{background:'var(--muted)'}}, '−'),
              h('div',{class:'main'}, h('div',null, s.label, s.name ? h('span',{class:'small muted'}, ` / ${s.name}`) : null), h('div',{class:'sub'}, s.address||'住所なし'), s.note ? h('div',{class:'small text-danger'}, '⚠ '+s.note) : null),
              h('div',{class:'ctl'}, h('select',{class:'sm', title:'この日に入れる', onChange:(e)=>{ if(!e.target.value) return; p.unassigned = p.unassigned.filter(x=>x!==s); p.days.find(d=>d.date===e.target.value).stops.push(s); saveDraft(); computeAll().then(renderPlan); }}, [['','日を選ぶ…'], ...dayOptions].map(([v,l])=>h('option',{value:v},l)))))))));
        }
        planEl.appendChild(h('div',{class:'card'}, h('h2',null,'🏨 宿'),
          h('p',{class:'small muted'}, '各日の最終訪問先と翌日の最初の訪問先の近くで、泊まるのに向いたホテルをAIがWeb検索で提案します(1回 数円)。気に入った宿を「帰着地にする」と、その日の帰着地・翌日の出発地になります。'),
          h('div',{class:'row'}, h('button',{class:'btn', onClick:suggestHotels}, '🏨 おすすめの宿を探す'))));
        planEl.appendChild(h('div',{class:'card'}, h('h2',null,'予定表に反映'),
          h('p',{class:'small muted'}, '各日の訪問を「スケジュール」に予定として登録し、日ごとのルートも保存します。訪問先が名刺に未登録なら登録します。'),
          h('div',{class:'row'},
            h('button',{class:'btn primary', onClick:applyPlan}, '📅 予定表に反映する'),
            h('button',{class:'btn', onClick:()=>UI.copy(planText())}, '📋 計画をテキストでコピー'))));
      }
      function planText(){
        const p = state.plan; if (!p) return '';
        const pdates = p.days.map(d=>d.date);
        return p.days.map((d,i)=>{ const it = p.itins[d.date]; const ds = resolveStart(pdates, i), de = resolveEnd(pdates, i); const head = `■${i+1}日目 ${UI.fmtDateLong(d.date)}${ds ? `  出発: ${ds.label}` : ''}${de ? ` → 帰着: ${de.label}` : ''}\n` + (it && it.travel ? `  移動 ${it.travel.from} → ${it.travel.to} ${UI.fmtMin(it.travel.min)}\n` : ''); return head + d.stops.map((s,j)=>{ const r = it?.rows?.[j]; return `${j+1}. ${r?fmtT(r.arr)+'-'+fmtT(r.dep)+' ':''}${s.label}${s.name?' / '+s.name:''}${s.address?' ('+s.address+')':''}`; }).join('\n') + (it?`\n  合計 ${it.distanceKm.toFixed(1)}km / 移動 ${UI.fmtMin(it.durationMin)}`:''); }).join('\n\n');
      }
      async function applyPlan(){
        const p = state.plan; if (!p) return;
        const pdates0 = p.days.map(d=>d.date);
        if (p.days.some((d,i)=>!resolveStart(pdates0, i))){ toast('出発地が決まらない日があります。「2. 計画の条件」で出発地を設定してから反映してください', {error:true}); return; }
        const total = p.days.reduce((a,d)=>a+d.stops.length,0);
        const existing = p.days.flatMap(d=>Store.where('events', e=>e.date===d.date && e.type==='visit'));
        const planKey = state.savedId || state.id; // 保存した計画なら保存IDで予定を紐付ける(別の計画や別端末の予定を消さない・重複させない)
        const prevCount = Store.where('events', e=>e.planId===planKey).length;
        const others = existing.filter(e=>e.planId!==planKey).length;
        const ok = await UI.confirm(`${p.days.length}日分・${total}件の訪問予定を登録します。${prevCount?`前回この計画で登録した ${prevCount} 件は置き換えます。`:''}${others?`対象日には別の訪問予定が ${others} 件あります。`:''}`, {ok:'登録する', danger:false});
        if (!ok) return;
        saveDraft();
        const planId = planKey;
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
          const di = p.days.indexOf(day); const ds = resolveStart(pdates0, di), de = resolveEnd(pdates0, di);
          if (!day.stops.length){
            const dpm0 = [(state.dayPlaces[day.date] || {}).memo || '', (state.dayPlaces[day.date] || {}).note || ''].filter(Boolean).join('\n');
            const dpm = it && it.segments && it.segments.length ? dpm0 + '\n' + it.segments.map(x=>`${x.from}→${x.to} ${modeOf(x.mode)[2]}${x.min != null ? ` 約${UI.fmtMin(x.min)}` : ''}`).join('\n') : dpm0;
            if (it && it.travel){ const ws0 = toMin((state.dayPlaces[day.date]||{}).startTime) ?? toMin(state.workStart) ?? 540; const fl = it.travel.flight; Store.save('events', { date: day.date, start: fl ? '' : fmtT(ws0).slice(0,5), end: fl ? '' : fmtT(Math.min(ws0 + it.travel.min, 1439)).slice(0,5), title: (/→|->/.test(dpm0) ? `移動 ${splitRoute(dpm0.split('\n')[0]).join('→').slice(0,60)}` : `移動 ${it.travel.from} → ${it.travel.to}`) + (it.travel.flight ? '' : `(${modeOf(it.mode)[2]})`), type:'move', customerId:'', address: de ? (de.address||de.label||'') : '', lat: de ? de.lat : null, lng: de ? de.lng : null, memo: [dpm, fl ? '営業計画の移動日(飛行機などの移動)' : `営業計画の移動日(${UI.fmtMin(it.travel.min)}${it.travel.km ? ` / ${it.travel.km.toFixed(1)}km` : ''})`].filter(Boolean).join('\n'), status:'planned', attachmentIds:[], planId }); ev++; }
            else if (dpm){ Store.save('events', { date: day.date, start:'', end:'', title: /→|->/.test(dpm0) ? `移動 ${splitRoute(dpm0.split('\n')[0]).join('→').slice(0,60)}` : `移動日: ${dpm.split('\n')[0].slice(0,40)}`, type:'move', customerId:'', address:'', lat:null, lng:null, memo: dpm, status:'planned', attachmentIds:[], planId }); ev++; }
            continue;
          }
          Store.save('routes', { planId, date: day.date, name:`営業計画 ${UI.fmtDate(day.date)}`, startLabel: ds ? ds.label : (state.startLabel||'出発地'), startAddress: ds ? ds.address : state.startAddress, startLat: ds ? ds.lat : null, startLng: ds ? ds.lng : null, roundTrip: !!(de && ds && samePt(de, ds)), departTime: (state.dayPlaces[day.date]||{}).startTime || state.workStart,
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
      /* 1か所を地図アプリで開くリンク(吹き出し用)。Google は座標検索、NAVER はスマホならアプリ(nmap://place)、PC ならウェブ版の検索 */
      function placeLinks(p){
        const lat = Number(p.lat), lng = Number(p.lng), name = p.label || p.company || p.name || '';
        const g = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
        const n = mobile ? `nmap://place?lat=${lat}&lng=${lng}&name=${encodeURIComponent(name)}&appname=${encodeURIComponent(location.origin || 'eigyo-support')}`
                         : `https://map.naver.com/p/search/${encodeURIComponent(p.address || name)}`;
        return h('div',{class:'row small', style:{gap:'8px', marginTop:'6px'}},
          h('a',{href:g, target:'_blank', rel:'noopener'}, '🗺️ Googleマップ'),
          h('a',{href:n, target: mobile ? '_self' : '_blank', rel:'noopener'}, '🟢 NAVERマップ'));
      }

      /* ===== 訪問先を地図で見る ===== */
      function showMap(focus){
        if (!MapKit.available()){ toast('地図ライブラリを読み込めませんでした(通信状況を確認してください)', {error:true}); return; }
        const list = state.rows.filter(r=>(!state.filter || r.category===state.filter));
        const withPos = list.filter(hasCoord), noPos = list.filter(r=>!hasCoord(r));
        if (!withPos.length && !(focus && hasCoord(focus))){ toast('座標のある訪問先がありません。「選択行の座標を取得」を先に押してください', {error:true}); return; }
        const mapEl = h('div',{class:'map', style:{height:'62vh'}});
        const legend = h('div',{class:'small muted mt'}, `● 番号は表の並び順。S は出発地。ピンを押すと Googleマップ / NAVERマップ で場所を開けます。日ごとの経路を開くボタンは「計画を自動作成」後の各日のカードにあります。` + (noPos.length ? ` 座標がなく地図に出ていない: ${noPos.map(r=>r.company||r.name).filter(Boolean).slice(0,8).join('、')}${noPos.length>8?' ほか':''}` : ''));
        UI.modal({ title: focus ? `${focus.company||focus.name||'訪問先'} の場所` : `訪問先の地図(${withPos.length}件)`, wide:true, body: h('div',null, mapEl, legend), actions:[{label:'閉じる', onClick:()=>{}}] });
        setTimeout(async()=>{
          try {
            const m = await MapKit.create(mapEl, {scrollWheelZoom:true});
            if (!m){ legend.textContent = '地図を表示できませんでした'; return; }
            const pts = [];
            const sp = startPt();
            if (sp){ m.marker(sp, { text:'S', cls:'start', popup: h('div',null, h('b',null, state.startLabel||'出発地'), h('div',{class:'small muted'}, state.startAddress||'')) }); pts.push([sp.lat, sp.lng]); }
            let focusMarker = null;
            withPos.forEach(r=>{ const i = list.indexOf(r)+1;
              const mk = m.marker(r, { text:i, cls: r===focus ? 'start' : '', popup: h('div',null, h('b',null, r.company||''), r.name ? h('div',{class:'small'}, r.name) : null, h('div',{class:'small muted'}, r.address||''), r.geoNote ? h('div',{class:'small text-warn'}, '⚠ 要確認: '+r.geoNote) : null, placeLinks(r)) });
              pts.push([Number(r.lat), Number(r.lng)]); if (r===focus) focusMarker = mk; });
            m.invalidate();
            if (focus && hasCoord(focus)){ m.setView([Number(focus.lat), Number(focus.lng)], 16); if (focusMarker) focusMarker.openPopup(); }
            else m.fit(pts);
          } catch(e){ console.error(e); legend.textContent = '地図の表示に失敗しました: ' + (e.message||e); }
        }, 60);
      }

      /* ===== 保存した計画(全員で共有。端末内の下書きとは別) ===== */
      const SAVE_KEYS = ['rows','filter','onlyNew','startDate','days','workStart','workEnd','roundTrip','startAddress','startLat','startLng','startLabel','dayPlaces','maxPerDay','aiText','aiApplied'];
      function snapshot(name){
        const o = { name };
        SAVE_KEYS.forEach(k=>{ o[k] = JSON.parse(JSON.stringify(state[k] === undefined ? null : state[k])); });
        o.plan = state.plan ? { days: JSON.parse(JSON.stringify(state.plan.days||[])), unassigned: JSON.parse(JSON.stringify(state.plan.unassigned||[])) } : null; // 行程(itins)は開いたときに計算し直す
        o.savedBy = Store.settings().userName || '';
        return o;
      }
      const savedInfo = h('span',{class:'small muted'});
      function refreshSaved(){
        const rec = state.savedId && Store.get('savedPlans', state.savedId);
        savedInfo.textContent = rec ? `保存済み: ${rec.name}(${UI.fmtDateTime(rec.updatedAt)}${rec.savedBy ? ' ' + rec.savedBy : ''})` : '未保存(下書きはこの端末に自動保存)';
      }
      async function savePlan(){
        if (!state.rows.length){ toast('保存する訪問先がありません', {error:true}); return; }
        const cur = state.savedId && Store.get('savedPlans', state.savedId);
        const def = cur ? cur.name : `${UI.fmtDate(state.startDate)}〜 営業計画`;
        const name = await UI.prompt('計画を保存', { label:'計画の名前(同じ名前なら上書き、変えると別の計画として保存)', value: def, placeholder:'例: 10月 清州出張' });
        if (name === null) return; const nm = String(name).trim() || def;
        const same = Store.list('savedPlans').find(p=>p.name === nm) || null; // 同じ名前の計画(いま開いているものでも、他の人が保存したものでも)
        if (same && !(cur && same.id === cur.id) && !(await UI.confirm(`「${nm}」はすでに保存されています(${UI.fmtDateTime(same.updatedAt)}${same.savedBy ? ' ' + same.savedBy : ''})。上書きしますか?`, {ok:'上書き', danger:false}))) return;
        const rec = snapshot(nm);
        if (same){ rec.id = same.id; rec.createdAt = same.createdAt; }
        const saved = Store.save('savedPlans', rec);
        state.savedId = saved.id; saveDraft(); refreshSaved();
        toast(same ? `「${nm}」に上書き保存しました` : `「${nm}」として保存しました(全員で共有)`, {ms:4000});
      }
      function openPlanList(){
        const list = Store.list('savedPlans').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
        let m;
        const body = h('div',{class:'list'}, list.length ? list.map(p => h('div',{class:'file-row', style:{alignItems:'center'}},
          h('div',{style:{flex:1, minWidth:0}}, h('div',null, h('b',null, p.name || '(名前なし)'), p.id === state.savedId ? h('span',{class:'badge done', style:{marginLeft:'6px'}}, '開いている') : null),
            h('div',{class:'small muted'}, `${UI.fmtDate(p.startDate)}〜 ${p.days||''}日 / 訪問先 ${(p.rows||[]).length}件${p.plan ? ' / 計画あり' : ''} / 更新 ${UI.fmtDateTime(p.updatedAt)}${p.savedBy ? ' ' + p.savedBy : ''}`)),
          h('button',{class:'btn sm primary', onClick: async()=>{
            if (state.rows.length && !(await UI.confirm((p.id === state.savedId ? '保存した時点の内容に戻しますか?' : 'いまのリストを閉じて「' + p.name + '」を開きますか?') + '(保存していない変更は消えます)', {ok:'開く', danger:false}))) return;
            const o = JSON.parse(JSON.stringify(p)); delete o.name; delete o.savedBy; delete o.createdAt; delete o.updatedAt;
            o.id = state.id || null; o.savedId = p.id; if (o.plan) o.plan.itins = {};
            Store.save('plans', o);
            m.close(); toast(`「${p.name}」を開きました`);
            window.dispatchEvent(new HashChangeEvent('hashchange')); // 画面を下書きから描き直す
          }}, '開く'),
          h('button',{class:'btn sm danger', onClick: async()=>{ if (await UI.confirm(`「${p.name}」を削除しますか?(全員の一覧から消えます)`)){ Store.remove('savedPlans', p.id); if (state.savedId === p.id){ state.savedId = null; saveDraft(); refreshSaved(); } m.close(); openPlanList(); } }}, '削除')
        )) : UI.empty('保存した計画はまだありません。「保存」を押すと、この一覧に入り全員で開けます。'));
        m = UI.modal({ title:'保存した計画を開く', body, actions:[{label:'閉じる', onClick:()=>{}}] });
      }
      refreshSaved();
      const offSaved = Store.on('savedPlans', refreshSaved);

      root.append(
        h('div',{class:'page-head'}, h('h1',null,'🧭 営業計画'), h('div',{class:'spacer'}), h('span',{class:'small muted'}, 'リスト取り込み → 日ごとに振り分け → 予定表へ')),
        h('div',{class:'card'}, h('div',{class:'row', style:{alignItems:'center'}}, h('h2',{style:{margin:0}}, '1. 訪問先リスト'), h('span',{style:{flex:1}}),
            h('button',{class:'btn sm primary', title:'訪問先リストと条件・計画を名前を付けて保存します(全員で共有)', onClick:savePlan}, '💾 保存'),
            h('button',{class:'btn sm', title:'保存した計画を開く', onClick:openPlanList}, '📂 開く')),
          h('div',{class:'small muted', style:{marginBottom:'8px'}}, savedInfo),
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
            h('div',{class:'f-row c3'}, field('業務開始', wsInp), field('業務終了', weInp), field('1日の訪問数の上限', maxInp, {hint:'希望日を指定した訪問先はこの上限を超えても入ります'})),
            field('出発地(毎日の出発点)', h('div',{class:'row', style:{flexWrap:'nowrap'}}, startAddrInp, h('button',{class:'btn', onClick:setStart}, '設定')), {hint:'未入力で「設定」を押すと設定画面の拠点住所になります。出張中は宿泊ホテルの住所を入れてください。'}),
            startInfo),
          h('div',{class:'mt'}, h('h3',null,'🤖 AIに注文する(任意)'),
            h('p',{class:'small muted'}, '「計画を自動作成」を押すと、ここに書いた注文を先に反映してから作成します。例:「제이여행사は2日目の午前、범한항공は最終日の15時以降」「청주市内は1日目にまとめて」「メディアは回らない」。表の希望日・時間帯・選択に反映されます(クラウド版のみ)。'),
            aiBox, h('div',{class:'row mt'}, aiMsg)),
          h('div',{class:'row mt'}, buildBtn, h('span',{class:'small muted'}, '選択した訪問先を、希望日・時間帯を守りつつ近い順に日ごとへ振り分け、各日の順番を最適化します。'))),
        h('h2',{class:'mt'}, '3. 日ごとの計画'), planEl
      );
      if (state.aiApplied && state.aiText && state.aiText.trim() === state.aiApplied) aiMsg.textContent = '注文は反映済みです(書き換えると次の「計画を自動作成」で反映します)';
      renderList(); renderPlan();
      if (state.plan && state.plan.days && (!state.plan.itins || !Object.keys(state.plan.itins).length) && startPt()){ computeAll().then(renderPlan).catch(e=>console.warn('recompute failed', e)); } // 保存した計画を開いた直後(行程は保存せず計算し直す)
      if (params.customer){ const c = Store.get('customers', params.customer); if (c && !state.rows.some(r=>r.customerId===c.id)){ state.rows.push(Object.assign(emptyRow(), {company:c.company||'', name:c.name||'', title:c.title||'', phone:c.phone||'', address:c.address||'', lat:c.lat, lng:c.lng, customerId:c.id})); saveDraft(); renderList(); } }
      return { destroy: ()=>offSaved() }; // 画面を離れたら購読を外す
    }
  });
})();
