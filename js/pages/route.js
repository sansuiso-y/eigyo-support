/* ルート作成: 訪問先を選んで地図表示・順序最適化・行程表・Googleマップ連携 */
App.register('route', {
  title:'ルート作成', icon:'🗺️', tab:true, short:'ルート',
  render(root, {params}){
    const { h, field, input, select, toast, badge, clear, fmtDate, fmtMin } = UI;
    const S = Store.settings();
    const hasL = typeof L !== 'undefined';

    /* ---------- ユーティリティ ---------- */
    const num = v => (v === '' || v === null || v === undefined) ? null : (isNaN(Number(v)) ? null : Number(v));
    const hasCoord = p => !!p && num(p.lat) !== null && num(p.lng) !== null;
    const toMin = t => { if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null; const [hh,mm] = t.split(':').map(Number); return hh*60+mm; };
    const fmtTime = (m, {plain=false}={}) => {
      m = Math.round(m); const day = Math.floor(m/1440); const mm = ((m%1440)+1440)%1440;
      const s = `${UI.pad(Math.floor(mm/60))}:${UI.pad(mm%60)}`;
      if (plain) return day>0 ? '23:59' : s;
      return s + (day>0 ? '(翌日)' : '');
    };
    const fmtKm = km => (km===null||km===undefined) ? '' : `${Number(km).toFixed(1)} km`;
    const coordText = p => hasCoord(p) ? `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}` : '';

    /* ---------- 状態 ---------- */
    const homeStart = () => S.homeAddress || hasCoord({lat:S.homeLat,lng:S.homeLng})
      ? { label:'拠点', address:S.homeAddress||'', lat:num(S.homeLat), lng:num(S.homeLng) } : null;
    const state = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(params.date||'') ? params.date : UI.today(),
      start: homeStart(),
      stops: [],            // {key, customerId, eventId, label, address, lat, lng, stayMin}
      roundTrip: false, fixedLast: false,
      departTime: S.workStart || '09:00',
      result: null, itinerary: null,
      loadedRouteId: null
    };
    const routePoints = () => { const pts = [state.start, ...state.stops]; if (state.roundTrip) pts.push(state.start); return pts; };

    /* ---------- 要素 ---------- */
    const dateInp = input({type:'date', value:state.date, onChange:(e)=>{ state.date = e.target.value; }});
    const loadBtn = h('button',{class:'btn', onClick:()=>loadFromEvents()}, '📅 この日の訪問予定から読み込む');
    const planLink = h('a',{class:'btn', href:'#/plan'}, '🧭 複数日の営業計画を作る');
    const startBox = h('div');
    const startAddrInp = input({placeholder:'出発地の住所(例: 福島県福島市…)', onKeydown:(e)=>{ if(e.key==='Enter') useAddress(); }});
    const custOpts = App.Shared.customerOptions(false);
    const custSel = custOpts.length ? select(custOpts, '', {}) : null;
    const stayInp = input({type:'number', value:S.defaultStayMin||45, min:0, step:5, style:{width:'90px'}});
    const addrInp = input({placeholder:'住所または施設名を入力して追加', onKeydown:(e)=>{ if(e.key==='Enter') addAddress(); }});
    const addrLabelInp = input({placeholder:'表示名(任意)'});
    const stopList = h('div',{class:'stop-list'});
    const roundChk = h('input',{type:'checkbox', checked:state.roundTrip, onChange:(e)=>{ state.roundTrip = e.target.checked; invalidate(); }});
    const fixedChk = h('input',{type:'checkbox', checked:state.fixedLast, onChange:(e)=>{ state.fixedLast = e.target.checked; }});
    const departInp = input({type:'time', value:state.departTime, onChange:(e)=>{ state.departTime = e.target.value || S.workStart || '09:00'; if (state.result){ state.itinerary = buildItinerary(state.result); renderResult(); } }});
    const optBtn = h('button',{class:'btn', onClick:()=>optimize()}, '✨ 最適な順序を提案');
    const calcBtn = h('button',{class:'btn primary', onClick:()=>calcRoute()}, '🧭 経路を計算');
    const gmapBtn = h('button',{class:'btn', onClick:()=>openGmaps()}, '🗺️ Googleマップで開く');
    const applyBtn = h('button',{class:'btn', onClick:()=>applyToEvents()}, '📅 予定に反映');
    const saveBtn = h('button',{class:'btn', onClick:()=>saveRoute()}, '💾 ルートを保存');
    const mapEl = h('div',{class:'map'});
    const mapNote = h('div',{class:'small muted mt'});
    const summaryEl = h('div',{class:'mt'});
    const itinEl = h('div');
    const savedEl = h('div',{class:'list'});

    /* ---------- 地図(MapKit: Google Maps、鍵が無ければ OpenStreetMap) ---------- */
    let map = null, mapInit = null;
    function initMap(){
      if (mapInit) return mapInit;
      mapInit = (async()=>{ try { map = await MapKit.create(mapEl, {scrollWheelZoom:false}); } catch(e){ console.warn('map init failed', e); map = null; } return map; })();
      return mapInit;
    }
    function popupOf(p){ return h('div', null, h('div',{style:{fontWeight:600}}, p.label || ''), h('div',{class:'small muted'}, p.address || coordText(p))); }
    let drawSeq = 0;
    async function drawMap(){
      if (!MapKit.available()){ mapNote.textContent = '地図ライブラリを読み込めないため地図は表示できません。リストと行程表は利用できます。'; return; }
      const seq = ++drawSeq;
      await initMap();
      if (seq !== drawSeq) return; // 描画中に状態が変わったら最新の呼び出しに任せる
      if (!map){ mapNote.textContent = '地図の初期化に失敗しました。リストと行程表は利用できます。'; return; }
      mapNote.textContent = '';
      map.clear();
      const pts = [];
      if (hasCoord(state.start)){ map.marker(state.start, { text:'S', cls:'start', popup: popupOf(state.start) }); pts.push([Number(state.start.lat), Number(state.start.lng)]); }
      state.stops.forEach((s,i)=>{ if (hasCoord(s)){ map.marker(s, { text:i+1, popup: popupOf(s) }); pts.push([Number(s.lat), Number(s.lng)]); } });
      if (state.result && state.result.geometry && state.result.geometry.length > 1){
        map.line(state.result.geometry, { color:'#1f6fdb', weight:5, opacity:.8, dashed: !!state.result.estimated });
        state.result.geometry.forEach(g=>pts.push(g));
      }
      map.invalidate();
      map.fit(pts);
    }

    /* ---------- 出発地 ---------- */
    function renderStart(){
      clear(startBox);
      const s = state.start;
      startBox.append(
        s ? h('div',{class:'stop'},
              h('div',{class:'num start'}, 'S'),
              h('div',{class:'main'},
                h('div',null, s.label || '出発地'),
                h('div',{class:'sub'}, s.address || coordText(s), hasCoord(s) ? '' : ' (座標未取得: 経路計算時に住所から検索します)')))
          : h('div',{class:'small muted'}, '出発地が未設定です。設定画面で拠点住所を登録すると自動で入ります。'),
        h('div',{class:'row mt'},
          h('button',{class:'btn sm', onClick:useHome}, '🏠 拠点を使う'),
          h('button',{class:'btn sm', onClick:useCurrent}, '📍 現在地を使う')),
        h('div',{class:'row mt'},
          h('div',{style:{flex:'1', minWidth:'180px'}}, startAddrInp),
          h('button',{class:'btn sm', onClick:useAddress}, '住所から設定'))
      );
    }
    function setStart(st){ state.start = st; invalidate(); renderStart(); drawMap(); }
    function useHome(){
      const hs = homeStart();
      if (!hs){ toast('設定画面で拠点住所を登録してください', {error:true}); return; }
      setStart(hs);
    }
    async function useCurrent(){
      toast('現在地を取得中…');
      try {
        const p = await Geo.currentPosition();
        let address = '';
        try { address = (await Geo.reverse(p.lat, p.lng)) || ''; } catch(e){}
        setStart({label:'現在地', address, lat:p.lat, lng:p.lng});
        toast('現在地を出発地にしました');
      } catch(e){ toast(e.message, {error:true}); }
    }
    async function useAddress(){
      const a = startAddrInp.value.trim();
      if (!a){ toast('住所を入力してください', {error:true}); return; }
      toast('住所を検索中…');
      try {
        const g = await Geo.geocode(a);
        if (!g){ toast('住所が見つかりませんでした', {error:true}); return; }
        setStart({label:a, address:a, lat:g.lat, lng:g.lng});
        startAddrInp.value = '';
      } catch(e){ toast(e.message, {error:true}); }
    }
    async function ensureStart(){
      if (!state.start){ toast('出発地を設定してください', {error:true}); return false; }
      if (hasCoord(state.start)) return true;
      if (!state.start.address){ toast('出発地の座標がありません', {error:true}); return false; }
      toast('出発地の座標を検索中…');
      try {
        const g = await Geo.geocode(state.start.address);
        if (!g){ toast('出発地の住所が見つかりませんでした。住所を見直してください', {error:true}); return false; }
        state.start.lat = g.lat; state.start.lng = g.lng; renderStart(); return true;
      } catch(e){ toast(e.message, {error:true}); return false; }
    }

    /* ---------- 訪問先 ---------- */
    function invalidate(){ state.result = null; state.itinerary = null; renderResult(); }
    function pushStop(s){ s.key = s.key || UI.uid(); s.stayMin = num(s.stayMin) ?? (S.defaultStayMin||45); state.stops.push(s); }
    function renderStops(){
      clear(stopList);
      if (!state.stops.length){ stopList.append(h('div',{class:'small muted'}, '訪問先がありません。上の欄から追加するか、日付を選んで予定から読み込んでください。')); return; }
      state.stops.forEach((s,i)=>{
        const row = h('div',{class:'stop'},
          h('div',{class:'num'}, i+1),
          h('div',{class:'main'},
            h('div',null, s.label || s.address || '(名称なし)', ' ', s.eventId ? badge('予定','visit') : null, hasCoord(s) ? null : badge('座標なし','cancelled')),
            h('div',{class:'sub'}, s.address || coordText(s))),
          h('label',{class:'stay small nowrap'}, input({type:'number', value:s.stayMin, min:0, step:5, 'aria-label':'滞在分', onChange:(e)=>{ s.stayMin = num(e.target.value) ?? 0; if (state.result){ state.itinerary = buildItinerary(state.result); renderResult(); } }}), '分'),
          h('div',{class:'ctl'},
            h('button',{class:'btn sm', disabled:i===0, 'aria-label':'上へ', onClick:()=>{ [state.stops[i-1], state.stops[i]] = [state.stops[i], state.stops[i-1]]; invalidate(); renderStops(); drawMap(); }}, '↑'),
            h('button',{class:'btn sm', disabled:i===state.stops.length-1, 'aria-label':'下へ', onClick:()=>{ [state.stops[i+1], state.stops[i]] = [state.stops[i], state.stops[i+1]]; invalidate(); renderStops(); drawMap(); }}, '↓'),
            h('button',{class:'btn sm danger', 'aria-label':'削除', onClick:()=>{ state.stops.splice(i,1); invalidate(); renderStops(); drawMap(); }}, '✕'))
        );
        stopList.append(row);
      });
    }
    async function addCustomer(){
      if (!custSel || !custSel.value){ toast('顧客を選択してください', {error:true}); return; }
      const c = Store.get('customers', custSel.value);
      if (!c){ toast('顧客が見つかりません', {error:true}); return; }
      let lat = num(c.lat), lng = num(c.lng);
      if ((lat===null || lng===null) && c.address){
        toast('住所を検索中…');
        try { const g = await Geo.geocode(c.address); if (g){ lat=g.lat; lng=g.lng; } } catch(e){ toast(e.message, {error:true}); return; }
      }
      if (lat===null || lng===null){ toast('この顧客の住所から座標を取得できませんでした。顧客情報の住所を確認してください', {error:true}); return; }
      pushStop({customerId:c.id, eventId:'', label:App.Shared.customerLabel(c), address:c.address||'', lat, lng, stayMin:num(stayInp.value)});
      invalidate(); renderStops(); drawMap();
      toast('追加しました');
    }
    async function addAddress(){
      const a = addrInp.value.trim();
      if (!a){ toast('住所を入力してください', {error:true}); return; }
      toast('住所を検索中…');
      try {
        const g = await Geo.geocode(a);
        if (!g){ toast('住所が見つかりませんでした', {error:true}); return; }
        pushStop({customerId:'', eventId:'', label:addrLabelInp.value.trim() || a, address:a, lat:g.lat, lng:g.lng, stayMin:num(stayInp.value)});
        addrInp.value=''; addrLabelInp.value='';
        invalidate(); renderStops(); drawMap();
        toast('追加しました');
      } catch(e){ toast(e.message, {error:true}); }
    }
    async function loadFromEvents(){
      const date = state.date;
      if (!date){ toast('日付を選んでください', {error:true}); return; }
      const evs = Store.where('events', e=>e.date===date && e.type!=='move' && e.status!=='cancelled')
        .sort((a,b)=>(a.start||'').localeCompare(b.start||''));
      if (!evs.length){ toast(`${fmtDate(date)}の訪問予定がありません`); return; }
      loadBtn.disabled = true;
      let added=0, skipped=0, dup=0;
      try {
        for (let i=0;i<evs.length;i++){
          const e = evs[i];
          if (state.stops.some(s=>s.eventId===e.id)){ dup++; continue; }
          const c = e.customerId ? Store.get('customers', e.customerId) : null;
          let lat = num(e.lat), lng = num(e.lng);
          const address = e.address || (c && c.address) || '';
          if ((lat===null||lng===null) && c && hasCoord(c)){ lat = num(c.lat); lng = num(c.lng); }
          if ((lat===null||lng===null) && address){
            toast(`住所を検索中 (${i+1}/${evs.length}): ${address}`);
            try { const g = await Geo.geocode(address); if (g){ lat=g.lat; lng=g.lng; } } catch(err){ console.warn(err); }
          }
          if (lat===null || lng===null){ skipped++; continue; }
          const st = toMin(e.start), en = toMin(e.end);
          const stay = (st!==null && en!==null && en>st) ? en-st : (S.defaultStayMin||45);
          pushStop({customerId:e.customerId||'', eventId:e.id, label:e.title || App.Shared.customerLabel(c) || address, address, lat, lng, stayMin:stay});
          added++;
        }
        // 最初に読み込んだ予定の開始時刻を出発時刻の目安にはしない(設定の業務開始を尊重)
      } finally { loadBtn.disabled = false; }
      invalidate(); renderStops(); drawMap();
      const parts = [`${added}件を追加しました`];
      if (skipped) parts.push(`住所・座標の無い${skipped}件はスキップ`);
      if (dup) parts.push(`既に追加済み${dup}件`);
      toast(parts.join('。'), {error: added===0});
    }

    /* ---------- 最適化・経路 ---------- */
    async function optimize(){
      if (!await ensureStart()) return;
      if (state.stops.length < 2){ toast('訪問先を2件以上追加してください', {error:true}); return; }
      if (state.stops.some(s=>!hasCoord(s))){ toast('座標の無い訪問先があります。削除するか住所を見直してください', {error:true}); return; }
      optBtn.disabled = true; toast('最適な順序を計算中…');
      try {
        const r = await Geo.optimize(state.start, state.stops, {roundTrip:state.roundTrip, fixedLast:state.fixedLast});
        const M = r.matrix;
        const cost = (order)=>{ if(!M||!order.length) return 0; let c=M[0][order[0]+1]; for(let i=1;i<order.length;i++) c+=M[order[i-1]+1][order[i]+1]; if(state.roundTrip) c+=M[order[order.length-1]+1][0]; return c; };
        const before = cost(state.stops.map((_,i)=>i)), after = cost(r.order);
        state.stops = r.stops;
        invalidate(); renderStops(); drawMap();
        const saved = before - after;
        if (saved > 0.5) toast(`順序を最適化しました: 移動 約${fmtMin(before)} → 約${fmtMin(after)}(約${fmtMin(saved)}短縮)`, {ms:4000});
        else toast('現在の順序がすでに最短です', {ms:3000});
        await calcRoute();
      } catch(e){ console.error(e); toast('最適化に失敗しました: '+e.message, {error:true}); }
      finally { optBtn.disabled = false; }
    }
    async function calcRoute(){
      if (!await ensureStart()) return;
      if (!state.stops.length){ toast('訪問先を追加してください', {error:true}); return; }
      if (state.stops.some(s=>!hasCoord(s))){ toast('座標の無い訪問先があります。削除するか住所を見直してください', {error:true}); return; }
      calcBtn.disabled = true; toast('経路を計算中…');
      try {
        const res = await Geo.route(routePoints());
        state.result = res;
        state.itinerary = buildItinerary(res);
        renderResult(); drawMap();
        toast(`総移動 ${fmtKm(res.distanceKm)} / ${fmtMin(res.durationMin)}` + (res.estimated ? '(直線距離からの推定)' : ''), {ms:3500});
      } catch(e){ console.error(e); toast('経路計算に失敗しました: '+e.message, {error:true}); }
      finally { calcBtn.disabled = false; }
    }
    function buildItinerary(res){
      const legs = (res.legs && res.legs.length) ? res.legs : null;
      let cur = toMin(state.departTime) ?? toMin(S.workStart) ?? 540;
      const rows = [];
      state.stops.forEach((s,i)=>{
        const leg = legs && legs[i] ? legs[i] : {distanceKm:null, durationMin:0};
        const arrive = cur + (leg.durationMin||0);
        const depart = arrive + (num(s.stayMin)||0);
        rows.push({stop:s, leg, arrive, depart});
        cur = depart;
      });
      let back = null;
      if (state.roundTrip && legs && legs[state.stops.length]){ const leg = legs[state.stops.length]; back = {leg, arrive: cur + (leg.durationMin||0)}; }
      const endMin = toMin(S.workEnd);
      const finish = back ? back.arrive : cur;
      return { rows, back, endMin, finish, over: endMin!==null && finish > endMin };
    }

    /* ---------- 結果表示 ---------- */
    function renderResult(){
      clear(summaryEl); clear(itinEl);
      const res = state.result, it = state.itinerary;
      if (!res || !it){ itinEl.append(h('div',{class:'small muted'}, '「経路を計算」を押すと、到着・出発予定時刻の行程表が表示されます。')); return; }
      UI.append(summaryEl, [
        h('div',{class:'row'},
          h('span',{class:'badge visit'}, `総距離 ${fmtKm(res.distanceKm)}`),
          h('span',{class:'badge visit'}, `移動時間 ${fmtMin(res.durationMin)}`),
          h('span',{class:'badge other'}, `滞在合計 ${fmtMin(state.stops.reduce((a,s)=>a+(num(s.stayMin)||0),0))}`),
          h('span',{class:'badge '+(it.over?'cancelled':'done')}, `${state.roundTrip?'帰着':'最終出発'} ${fmtTime(it.finish)}`)),
        res.estimated ? h('div',{class:'small text-warn mt'}, '⚠ 経路サーバーに接続できなかったため、直線距離×1.3からの推定値です。') : null,
        it.over ? h('div',{class:'small text-danger mt'}, `⚠ 業務終了(${S.workEnd})を超える見込みです。訪問先や滞在時間を見直してください。`) : null
      ]);
      const tbl = h('table',{class:'tbl'},
        h('thead',null, h('tr',null, h('th',null,'#'), h('th',null,'訪問先'), h('th',null,'移動'), h('th',null,'到着'), h('th',null,'出発'))),
        h('tbody',null,
          h('tr',null, h('td',null,'S'), h('td',null, h('div',null, state.start.label||'出発地'), h('div',{class:'small muted'}, state.start.address||'')), h('td',null,'—'), h('td',null,'—'), h('td',{class:'nowrap'}, fmtTime(toMin(state.departTime) ?? 540))),
          it.rows.map((r,i)=> h('tr',{class: (it.endMin!==null && r.arrive>it.endMin) ? 'text-danger' : ''},
            h('td',null, i+1),
            h('td',null, h('div',null, r.stop.label||''), h('div',{class:'small muted'}, r.stop.address||'')),
            h('td',{class:'nowrap small'}, fmtKm(r.leg.distanceKm), h('br'), fmtMin(r.leg.durationMin)),
            h('td',{class:'nowrap'}, fmtTime(r.arrive)),
            h('td',{class:'nowrap'}, fmtTime(r.depart), h('div',{class:'small muted'}, `滞在${num(r.stop.stayMin)||0}分`))
          )),
          it.back ? h('tr',{class: it.over ? 'text-danger' : ''}, h('td',null,'S'), h('td',null,'出発地に戻る'), h('td',{class:'nowrap small'}, fmtKm(it.back.leg.distanceKm), h('br'), fmtMin(it.back.leg.durationMin)), h('td',{class:'nowrap'}, fmtTime(it.back.arrive)), h('td',null,'—')) : null
        ));
      itinEl.append(h('div',{class:'tbl-wrap'}, tbl));
    }

    /* ---------- Googleマップ ---------- */
    function gmapsLinks(){
      const pts = routePoints();
      const MAX = 11; // origin + waypoints(9) + destination
      const out = [];
      for (let i=0; i<pts.length-1; i+=MAX-1){
        const seg = pts.slice(i, i+MAX);
        if (seg.length < 2) break;
        const nameOf = idx => idx===0 ? '出発地' : (state.roundTrip && idx===pts.length-1) ? '出発地(戻り)' : `訪問先${idx}`;
        out.push({ url: Geo.gmapsUrl(seg.map(p=>({lat:Number(p.lat), lng:Number(p.lng)}))), label: `${nameOf(i)} → ${nameOf(i+seg.length-1)}` });
      }
      return out;
    }
    function openGmaps(){
      if (!state.start || !hasCoord(state.start)){ toast('出発地(座標付き)を設定してください', {error:true}); return; }
      if (!state.stops.length){ toast('訪問先を追加してください', {error:true}); return; }
      if (state.stops.some(s=>!hasCoord(s))){ toast('座標の無い訪問先があります', {error:true}); return; }
      const links = gmapsLinks();
      if (links.length === 1){ window.open(links[0].url, '_blank', 'noopener'); return; }
      UI.modal({ title:'Googleマップで開く', body: h('div', null,
        h('p',{class:'small muted'}, `Googleマップの経由地は最大9か所のため、${links.length}つのリンクに分割しました。順番に開いてください。`),
        h('div',{class:'link-list'}, links.map((l,i)=> h('a',{href:l.url, target:'_blank', rel:'noopener noreferrer'}, h('span',null,'🗺️'), h('span',{class:'lk-main'}, h('div',null,`リンク ${i+1}`), h('div',{class:'lk-sub'}, l.label)))))),
        actions:[{label:'閉じる'}] });
    }

    /* ---------- 予定へ反映 ---------- */
    async function applyToEvents(){
      if (!state.itinerary){ toast('先に「経路を計算」を実行してください', {error:true}); return; }
      const linked = state.itinerary.rows.filter(r=>r.stop.eventId && Store.get('events', r.stop.eventId));
      if (!linked.length){ toast('予定から読み込んだ訪問先がありません(手動で追加した訪問先は反映対象外です)', {error:true}); return; }
      const targets = linked.filter(r=>r.arrive < 1440);           // 到着が翌日になる訪問先は反映しない
      const overnight = linked.length - targets.length;
      if (!targets.length){ toast('到着予定が翌日になるため反映できません。訪問先や出発時刻を見直してください', {error:true}); return; }
      const noEvent = state.itinerary.rows.length - linked.length;
      const notes = [];
      if (noEvent) notes.push(`元の予定が無い${noEvent}件`);
      if (overnight) notes.push(`到着が翌日になる${overnight}件`);
      const ok = await UI.confirm(`${fmtDate(state.date)}の予定 ${targets.length}件の開始/終了時刻を、行程表の到着/出発時刻で上書きします。` + (notes.length?`(${notes.join('、')}はスキップ)`:'') + ' 実行しますか?', {ok:'反映する', danger:false});
      if (!ok) return;
      targets.forEach(r=>{
        const ev = Store.get('events', r.stop.eventId); if (!ev) return;
        ev.start = fmtTime(r.arrive, {plain:true});
        ev.end = fmtTime(Math.max(r.arrive, Math.min(r.depart, 1439)), {plain:true});
        if (!ev.lat && hasCoord(r.stop)){ ev.lat = r.stop.lat; ev.lng = r.stop.lng; }
        Store.save('events', ev);
      });
      toast(`${targets.length}件の予定に反映しました`);
    }

    /* ---------- 保存 / 読み込み ---------- */
    async function saveRoute(){
      if (!state.start){ toast('出発地を設定してください', {error:true}); return; }
      if (!state.stops.length){ toast('訪問先を追加してください', {error:true}); return; }
      const existing = state.loadedRouteId ? Store.get('routes', state.loadedRouteId) : null;
      const name = await UI.prompt('ルート名', {label:'名前', value: existing ? existing.name : `${fmtDate(state.date)} ${state.stops.length}件`});
      if (name === null) return;
      const obj = {
        id: existing ? existing.id : undefined,
        createdAt: existing ? existing.createdAt : undefined,
        date: state.date, name: name.trim() || `${fmtDate(state.date)} ${state.stops.length}件`,
        startAddress: state.start.address||'', startLat: num(state.start.lat), startLng: num(state.start.lng), startLabel: state.start.label||'',
        stops: state.stops.map(s=>({customerId:s.customerId||'', eventId:s.eventId||'', label:s.label||'', address:s.address||'', lat:num(s.lat), lng:num(s.lng), stayMin:num(s.stayMin)||0})),
        distanceKm: state.result ? Math.round(state.result.distanceKm*10)/10 : null,
        durationMin: state.result ? Math.round(state.result.durationMin) : null,
        roundTrip: state.roundTrip, fixedLast: state.fixedLast, departTime: state.departTime
      };
      if (!obj.id) delete obj.id;
      if (!obj.createdAt) delete obj.createdAt;
      const saved = Store.save('routes', obj);
      state.loadedRouteId = saved.id;
      renderSaved();
      toast(existing ? '上書き保存しました' : '保存しました');
    }
    function loadRoute(r){
      state.loadedRouteId = r.id;
      state.date = r.date || state.date; dateInp.value = state.date;
      state.start = { label: r.startLabel || '出発地', address: r.startAddress||'', lat:num(r.startLat), lng:num(r.startLng) };
      state.stops = (r.stops||[]).map(s=>Object.assign({}, s, {key:UI.uid()}));
      state.roundTrip = !!r.roundTrip; roundChk.checked = state.roundTrip;
      state.fixedLast = !!r.fixedLast; fixedChk.checked = state.fixedLast;
      if (r.departTime){ state.departTime = r.departTime; departInp.value = r.departTime; }
      invalidate(); renderStart(); renderStops(); drawMap();
      toast(`「${r.name||'ルート'}」を読み込みました`);
      window.scrollTo({top:0, behavior:'smooth'});
    }
    function renderSaved(){
      clear(savedEl);
      const rs = Store.list('routes').sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.createdAt||'').localeCompare(a.createdAt||''));
      if (!rs.length){ savedEl.append(UI.empty('保存済みルートはありません')); return; }
      rs.forEach(r=>{
        const meta = [fmtDate(r.date), `${(r.stops||[]).length}件`, r.distanceKm!=null ? fmtKm(r.distanceKm) : '', r.durationMin!=null ? fmtMin(r.durationMin) : '', r.roundTrip ? '往復' : ''].filter(Boolean).join(' · ');
        savedEl.append(h('div',{class:'item', onClick:()=>loadRoute(r)},
          h('div',{class:'main'}, h('div',{class:'title'}, r.name||'(無題)', state.loadedRouteId===r.id ? [' ', badge('編集中','visit')] : null), h('div',{class:'sub'}, meta), h('div',{class:'sub'}, (r.stops||[]).map(s=>s.label).filter(Boolean).join(' → '))),
          h('div',{class:'row', style:{flexShrink:0}},
            h('button',{class:'btn sm', onClick:(e)=>{ e.stopPropagation(); loadRoute(r); }}, '読み込む'),
            h('button',{class:'btn sm danger', onClick: async(e)=>{ e.stopPropagation(); if (await UI.confirm(`「${r.name||'ルート'}」を削除しますか?`)){ Store.remove('routes', r.id); if (state.loadedRouteId===r.id) state.loadedRouteId=null; renderSaved(); toast('削除しました'); } }}, '削除'))));
      });
    }

    /* ---------- 画面構築 ---------- */
    root.append(
      h('div',{class:'page-head'}, h('h1',null,'🗺️ ルート作成')),
      h('div',{class:'grid cols-2'},
        h('div',null,
          h('div',{class:'card'}, h('h2',null,'1. 日付と出発地'),
            h('div',{class:'form'},
              h('div',{class:'row'}, h('div',{style:{flex:'1', minWidth:'160px'}}, dateInp), loadBtn, planLink),
              h('div',{class:'small muted'}, '読み込み対象: その日の予定(移動・キャンセルを除く)で住所または座標があるもの'),
              field('出発地', startBox))),
          h('div',{class:'card'}, h('h2',null,'2. 訪問先を追加'),
            h('div',{class:'form'},
              custSel
                ? field('顧客から追加', h('div',{class:'row'}, h('div',{style:{flex:'1', minWidth:'160px'}}, custSel), h('button',{class:'btn sm', onClick:addCustomer}, '＋ 追加')))
                : h('div',{class:'small muted'}, '顧客が登録されていません。顧客・名刺管理から登録すると選択できます。'),
              field('住所・施設名から追加', h('div',{class:'row'}, h('div',{style:{flex:'2', minWidth:'160px'}}, addrInp), h('div',{style:{flex:'1', minWidth:'120px'}}, addrLabelInp), h('button',{class:'btn sm', onClick:addAddress}, '＋ 追加'))),
              h('div',{class:'f inline'}, h('label',null,'追加時の滞在時間'), stayInp, h('span',{class:'small muted'},'分'))))),
        h('div',null,
          h('div',{class:'card'}, h('h2',null,'3. 訪問先リスト'),
            stopList,
            h('div',{class:'form mt'},
              h('div',{class:'row'},
                h('label',{class:'row small', style:{gap:'4px'}}, roundChk, '出発地に戻る(往復)'),
                h('label',{class:'row small', style:{gap:'4px'}}, fixedChk, '最後の訪問先を固定')),
              h('div',{class:'f inline'}, h('label',null,'出発時刻'), h('div',{style:{width:'130px'}}, departInp))),
            h('div',{class:'row mt'}, optBtn, calcBtn),
            h('div',{class:'row mt'}, gmapBtn, applyBtn, saveBtn)))),
      h('div',{class:'card'}, h('h2',null,'地図'), mapEl, mapNote, summaryEl),
      h('div',{class:'card'}, h('h2',null,'行程表'), h('p',{class:'small muted'}, `出発時刻から各区間の移動時間と滞在時間を累積して算出。業務終了(${S.workEnd||'未設定'})を超える行は赤で表示します。`), itinEl),
      h('div',{class:'card'}, h('h2',null,'保存済みルート'), savedEl)
    );
    renderStart(); renderStops(); renderResult(); renderSaved();
    setTimeout(()=>{ drawMap(); if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) && !state.stops.length) loadFromEvents(); }, 0);

    return { destroy(){ if (map){ try { map.remove(); } catch(e){} map = null; layer = null; } } };
  }
});
