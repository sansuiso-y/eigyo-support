/* 出張手配: ホテル・レンタカーの検索サイトを条件付きで開く + 予約結果の記録 */
App.register('travel', {
  title:'出張手配', icon:'🏨', tab:false,
  render(root, {params}){
    const { h, field, input, select, textarea, toast, badge, clear, fmtDate, fmtDateTime, fmtYen } = UI;
    const enc = encodeURIComponent;
    const today = UI.today();
    const tomorrow = UI.addDays(today, 1);
    let tab = params.tab === 'car' ? 'car' : 'hotel';

    const STATUS = [['searching','検討中'],['booked','予約済'],['cancelled','キャンセル']];
    const statusLabel = s => (STATUS.find(x=>x[0]===s)||[,s||''])[1];
    const CAR_CLASSES = ['軽','コンパクト','ミドル','ワゴン','バン'];
    const HOTEL_SITES = ['楽天トラベル','じゃらん','Booking.com','Google ホテル','一休.com','Yahoo!トラベル','Agoda','公式サイト','電話','その他'];
    const CAR_COMPANIES = ['トヨタレンタカー','ニッポンレンタカー','タイムズカーレンタル','オリックスレンタカー','ニッサンレンタカー','じゃらんレンタカー','楽天トラベル レンタカー','その他'];
    const dtLocal = (date, time) => `${date}T${time}`;
    const addMinutes = (hhmm, n) => { const [hh,mm] = (hhmm||'09:00').split(':').map(Number); const t = Math.min(23*60+59, hh*60+mm+n); return `${UI.pad(Math.floor(t/60))}:${UI.pad(t%60)}`; };
    const nightsOf = (a,b) => { if(!a||!b) return 0; const n = UI.diffDays(a,b); return isNaN(n) ? 0 : n; };
    const yen = n => (n===''||n===null||n===undefined||isNaN(Number(n))) ? '' : `${Number(n).toLocaleString('ja-JP')}円`;

    /* ---------- 共通部品 ---------- */
    function linkEl(l){
      return h('a',{href:l.url, target:'_blank', rel:'noopener noreferrer'},
        h('span',null, l.icon||'🔗'),
        h('span',{class:'lk-main'}, h('div',null,l.name), l.note ? h('div',{class:'lk-sub'}, l.note) : null));
    }
    function datalist(id, items){ return h('datalist',{id}, items.map(x=>h('option',{value:x}))); }
    function foldList(title, rows){
      if (!rows.length) return null;
      return h('details',{class:'fold'}, h('summary',null,`${title}(${rows.length}件)`), h('div',{class:'list mt'}, rows));
    }

    /* ---------- サマリ ---------- */
    const summaryEl = h('div');
    function renderSummary(){
      clear(summaryEl);
      const items = [];
      Store.list('hotels').forEach(x=>{ if (x.status==='cancelled') return; if ((x.checkOut||x.checkIn||'') < today) return;
        items.push({sort:(x.checkIn||'')+'T00:00', text:`🏨 ${fmtDate(x.checkIn)}〜${fmtDate(x.checkOut)} ${x.hotelName||x.area||'ホテル'}`, status:x.status, tab:'hotel'}); });
      Store.list('cars').forEach(x=>{ if (x.status==='cancelled') return; if ((x.returnAt||x.pickupAt||'').slice(0,10) < today) return;
        items.push({sort:x.pickupAt||'', text:`🚗 ${fmtDateTime(x.pickupAt)} ${x.company||'レンタカー'} ${x.pickupPlace||''}`, status:x.status, tab:'car'}); });
      items.sort((a,b)=>a.sort.localeCompare(b.sort));
      if (!items.length){ summaryEl.append(h('div',{class:'small muted'}, '今後の宿泊・レンタカーの記録はありません。')); return; }
      summaryEl.append(h('div',{class:'list'}, items.slice(0,8).map(it=>
        h('div',{class:'row small', style:{cursor:'pointer'}, onClick:()=>switchTab(it.tab)}, h('span',{style:{flex:'1', minWidth:'0'}}, it.text), badge(statusLabel(it.status), it.status)))));
    }

    /* ---------- ホテル ---------- */
    const hForm = h('div',{class:'form'});
    const hCheckIn = input({type:'date', name:'checkIn', value:tomorrow});
    const hCheckOut = input({type:'date', name:'checkOut', value:UI.addDays(today,2)});
    hCheckIn.addEventListener('change', ()=>{ if (hCheckIn.value && (!hCheckOut.value || hCheckOut.value <= hCheckIn.value)) hCheckOut.value = UI.addDays(hCheckIn.value, 1); });
    hCheckOut.addEventListener('change', ()=>{ if (hCheckIn.value && hCheckOut.value && hCheckOut.value <= hCheckIn.value){ hCheckOut.value = UI.addDays(hCheckIn.value, 1); toast('チェックアウトはチェックインの翌日以降にしてください', {error:true}); } });
    hForm.append(
      h('div',{class:'f-row c3'},
        field('チェックイン', hCheckIn), field('チェックアウト', hCheckOut),
        field('人数', input({type:'number', name:'guests', value:1, min:1, max:20}))),
      h('div',{class:'f-row'},
        field('エリア / キーワード', input({name:'area', placeholder:'例: 新潟駅、郡山市、○○ホテル'})),
        field('上限予算(円/泊・任意)', input({type:'number', name:'budget', min:0, step:500, placeholder:'例: 8000'})))
    );
    const hLinks = h('div',{class:'link-list mt'});
    const hLinkNote = h('div',{class:'small muted mt'});
    function hotelCond(v){
      const n = nightsOf(v.checkIn, v.checkOut);
      return [v.checkIn ? `${fmtDate(v.checkIn)}〜${fmtDate(v.checkOut)}` : '', n>0 ? `${n}泊` : '', `${v.guests||1}名`, v.area||'', v.budget ? `予算${yen(v.budget)}` : ''].filter(Boolean).join(' ');
    }
    function hotelLinks(v){
      const kw = (v.area||'').trim(); const k = enc(kw);
      const nights = Math.max(1, nightsOf(v.checkIn, v.checkOut) || 1);
      const adults = Math.max(1, Number(v.guests)||1);
      return [
        {name:'楽天トラベル', icon:'🏨', url: kw ? `https://search.travel.rakuten.co.jp/ds/undated/search?f_keyword=${k}` : 'https://travel.rakuten.co.jp/', note: kw ? 'キーワード検索。日付・人数はサイト側で入力' : 'トップページ'},
        {name:'じゃらん(キーワード検索)', icon:'🏨', url: kw ? `https://www.jalan.net/uw/uwp3200/uww3201init.do?keyword=${k}` : 'https://www.jalan.net/', note: kw ? '動かない場合は下の「じゃらん トップ」から' : 'トップページ'},
        kw ? {name:'じゃらん トップ', icon:'🏨', url:'https://www.jalan.net/', note:'条件はサイト側で入力'} : null,
        {name:'Booking.com', icon:'🌐', url:`https://www.booking.com/searchresults.ja.html?ss=${k}&checkin=${enc(v.checkIn||'')}&checkout=${enc(v.checkOut||'')}&group_adults=${adults}&no_rooms=1&group_children=0`, note:'日付・人数付きで検索'},
        {name:'Google ホテル', icon:'🔍', url:`https://www.google.com/travel/search?q=${enc((kw ? kw+' ' : '')+'ホテル')}`, note:'キーワード検索。日付はサイト側で調整'},
        {name:'一休.com', icon:'🏨', url:'https://www.ikyu.com/', note:'トップページ(条件はサイト側で入力)'},
        {name:'Yahoo!トラベル', icon:'🏨', url:'https://travel.yahoo.co.jp/', note:'トップページ(条件はサイト側で入力)'},
        {name:'Agoda', icon:'🌐', url: kw ? `https://www.agoda.com/ja-jp/search?textToSearch=${k}&checkIn=${enc(v.checkIn||'')}&los=${nights}&adults=${adults}&rooms=1` : 'https://www.agoda.com/ja-jp/', note: kw ? '非公式パラメータ。開けない場合はトップから検索' : 'トップページ'}
      ].filter(Boolean);
    }
    function showHotelLinks(){
      const v = UI.readForm(hForm);
      if (!v.checkIn || !v.checkOut){ toast('チェックイン・チェックアウト日を入力してください', {error:true}); return; }
      clear(hLinks);
      hotelLinks(v).forEach(l=>hLinks.append(linkEl(l)));
      hLinkNote.textContent = `検索条件: ${hotelCond(v)} — 各サイトは新しいタブで開きます。日付・人数が引き継がれないサイトでは、サイト側で再入力してください。`;
    }
    const hList = h('div');
    function hotelRow(x){
      const n = nightsOf(x.checkIn, x.checkOut);
      const meta = [`${fmtDate(x.checkIn)}〜${fmtDate(x.checkOut)}` + (n>0 ? `(${n}泊)` : ''), x.area||'', x.price!==''&&x.price!=null ? fmtYen(x.price) : '', x.site||'', x.confirmationNo ? `予約番号 ${x.confirmationNo}` : ''].filter(Boolean).join(' · ');
      return h('div',{class:'item', style:{cursor:'default'}},
        h('div',{class:'main'},
          h('div',{class:'title'}, x.hotelName || x.area || '(ホテル未定)', ' ', badge(statusLabel(x.status), x.status||'other')),
          h('div',{class:'sub', style:{whiteSpace:'normal'}}, meta),
          x.memo ? h('div',{class:'sub', style:{whiteSpace:'pre-wrap'}}, x.memo) : null,
          h('div',{class:'row mt'},
            h('button',{class:'btn sm', onClick:()=>hotelModal(x)}, '編集'),
            h('button',{class:'btn sm', onClick:()=>addHotelEvent(x)}, '📅 予定に追加'),
            h('button',{class:'btn sm danger', onClick: async()=>{ if (await UI.confirm(`「${x.hotelName||x.area||'ホテル'}」の記録を削除しますか?`)){ Store.remove('hotels', x.id); toast('削除しました'); refreshAll(); } }}, '削除'))));
    }
    function renderHotelList(){
      clear(hList);
      const all = Store.list('hotels').sort((a,b)=>(a.checkIn||'').localeCompare(b.checkIn||''));
      if (!all.length){ hList.append(UI.empty('ホテル予約の記録はありません。「予約を記録」から追加できます。')); return; }
      const upcoming = all.filter(x=>(x.checkOut||x.checkIn||'') >= today);
      const past = all.filter(x=>(x.checkOut||x.checkIn||'') < today);
      hList.append(upcoming.length ? h('div',{class:'list'}, upcoming.map(hotelRow)) : h('div',{class:'small muted'}, '今後の宿泊記録はありません。'));
      const f = foldList('過去の宿泊', past.map(hotelRow)); if (f) hList.append(f);
    }
    function hotelModal(rec){
      const isNew = !rec.id;
      const form = h('div',{class:'form'},
        h('div',{class:'f-row'},
          field('チェックイン', input({type:'date', name:'checkIn', value:rec.checkIn||''})),
          field('チェックアウト', input({type:'date', name:'checkOut', value:rec.checkOut||''}))),
        h('div',{class:'f-row'},
          field('エリア', input({name:'area', value:rec.area||'', placeholder:'例: 新潟駅周辺'})),
          field('ホテル名', input({name:'hotelName', value:rec.hotelName||'', placeholder:'例: ○○ホテル新潟'}))),
        h('div',{class:'f-row'},
          field('料金(円・合計)', input({type:'number', name:'price', value:(rec.price===undefined||rec.price===null)?'':rec.price, min:0})),
          field('予約番号', input({name:'confirmationNo', value:rec.confirmationNo||''}))),
        h('div',{class:'f-row'},
          field('予約サイト', h('input',{type:'text', name:'site', value:rec.site||'', list:'travel-hotel-sites', placeholder:'選択または入力'})),
          field('状態', select(STATUS, rec.status||'searching', {name:'status'}))),
        field('メモ', textarea({name:'memo', value:rec.memo||'', rows:3, placeholder:'朝食付き、駐車場あり など'})),
        datalist('travel-hotel-sites', HOTEL_SITES)
      );
      UI.modal({ title: isNew ? 'ホテル予約を記録' : 'ホテル予約を編集', body: form,
        actions:[ {label:'キャンセル'}, {label:'保存', cls:'primary', onClick:()=>{
          const v = UI.readForm(form);
          if (!v.checkIn){ toast('チェックイン日を入力してください', {error:true}); return false; }
          if (v.checkOut && v.checkOut <= v.checkIn){ toast('チェックアウトはチェックインより後の日付にしてください', {error:true}); return false; }
          if (!v.checkOut) v.checkOut = UI.addDays(v.checkIn, 1);
          Store.save('hotels', Object.assign({}, rec, v));
          toast(isNew ? '記録しました' : '更新しました'); refreshAll();
        }} ] });
    }
    function addHotelEvent(x){
      if (!x.checkIn){ toast('チェックイン日がありません', {error:true}); return; }
      if (Store.where('events', e=>e.hotelId===x.id).length){ toast('この宿泊はすでに予定に追加されています'); return; }
      const name = x.hotelName || x.area || 'ホテル';
      Store.save('events', { date:x.checkIn, start:'15:00', end:'16:00', title:`宿泊: ${name}`, type:'other', customerId:'', address:x.area||'', lat:null, lng:null,
        memo:[`${fmtDate(x.checkIn)}〜${fmtDate(x.checkOut)}`, x.site||'', x.confirmationNo ? `予約番号 ${x.confirmationNo}` : '', x.memo||''].filter(Boolean).join(' / '),
        status:'planned', attachmentIds:[], hotelId:x.id });
      toast(`${fmtDate(x.checkIn)}の予定に「宿泊: ${name}」を追加しました(チェックイン目安15:00)`);
    }
    const hotelPanel = h('div', null,
      h('div',{class:'card'}, h('h2',null,'ホテルを探す'),
        hForm,
        h('div',{class:'row mt'},
          h('button',{class:'btn primary', onClick:showHotelLinks}, '🔎 検索サイトを開く'),
          h('button',{class:'btn', onClick:()=>{ const v = UI.readForm(hForm); UI.copy(hotelCond(v)); }}, '📋 検索条件をコピー'),
          h('button',{class:'btn', onClick:()=>{ const v = UI.readForm(hForm); hotelModal({checkIn:v.checkIn, checkOut:v.checkOut, area:v.area, price:v.budget!=='' && v.budget!=null ? v.budget*Math.max(1,nightsOf(v.checkIn,v.checkOut)) : '', status:'searching'}); }}, '📝 予約を記録')),
        hLinks, hLinkNote),
      h('div',{class:'card'}, h('h2',null,'ホテル予約の記録'), hList)
    );

    /* ---------- レンタカー ---------- */
    const cForm = h('div',{class:'form'});
    const cPickup = input({type:'datetime-local', name:'pickupAt', value:dtLocal(tomorrow,'09:00')});
    const cReturn = input({type:'datetime-local', name:'returnAt', value:dtLocal(UI.addDays(today,2),'18:00')});
    cPickup.addEventListener('change', ()=>{ if (cPickup.value && (!cReturn.value || cReturn.value <= cPickup.value)) cReturn.value = dtLocal(UI.addDays(cPickup.value.slice(0,10),1), '18:00'); });
    const cSame = h('input',{type:'checkbox', name:'returnSame', checked:true});
    const cReturnPlace = input({name:'returnPlace', placeholder:'返却場所', disabled:true});
    cSame.addEventListener('change', ()=>{ cReturnPlace.disabled = cSame.checked; if (cSame.checked) cReturnPlace.value=''; });
    cForm.append(
      h('div',{class:'f-row'}, field('貸出日時', cPickup), field('返却日時', cReturn)),
      h('div',{class:'f-row'},
        field('貸出場所', input({name:'pickupPlace', placeholder:'例: 新潟駅前、新潟空港'})),
        field('返却場所', h('div',null, h('label',{class:'row small', style:{gap:'4px', marginBottom:'4px'}}, cSame, '貸出場所と同じ'), cReturnPlace))),
      field('車クラス', select(CAR_CLASSES.map(c=>[c, c]), 'コンパクト', {name:'carClass'}))
    );
    const cLinks = h('div',{class:'link-list mt'});
    const cLinkNote = h('div',{class:'small muted mt'});
    function carCond(v){
      const ret = v.returnSame ? (v.pickupPlace||'') : (v.returnPlace||'');
      return [`貸出 ${fmtDateTime(v.pickupAt)} ${v.pickupPlace||''}`.trim(), `→ 返却 ${fmtDateTime(v.returnAt)} ${ret}`.trim(), v.carClass ? `${v.carClass}クラス` : ''].filter(Boolean).join(' ');
    }
    const CAR_LINKS = [
      {name:'トヨタレンタカー', icon:'🚗', url:'https://rent.toyota.co.jp/'},
      {name:'ニッポンレンタカー', icon:'🚗', url:'https://www.nipponrentacar.co.jp/'},
      {name:'タイムズカーレンタル', icon:'🚗', url:'https://rental.timescar.jp/'},
      {name:'オリックスレンタカー', icon:'🚗', url:'https://car.orix.co.jp/'},
      {name:'ニッサンレンタカー', icon:'🚗', url:'https://nissan-rentacar.com/'},
      {name:'じゃらんレンタカー', icon:'🔍', url:'https://www.jalan.net/rentacar/', note:'各社横断の比較検索'},
      {name:'楽天トラベル レンタカー', icon:'🔍', url:'https://travel.rakuten.co.jp/cars/', note:'各社横断の比較検索'}
    ];
    function showCarLinks(){
      const v = UI.readForm(cForm);
      if (!v.pickupAt || !v.returnAt){ toast('貸出・返却日時を入力してください', {error:true}); return; }
      if (v.returnAt <= v.pickupAt){ toast('返却日時は貸出日時より後にしてください', {error:true}); return; }
      clear(cLinks);
      CAR_LINKS.forEach(l=>cLinks.append(linkEl(Object.assign({note:'トップページ(条件はサイト側で入力)'}, l))));
      cLinkNote.textContent = `検索条件: ${carCond(v)} — 各社の検索URLパラメータは公開されていないためトップページを開きます。「検索条件をコピー」で条件を貼り付けてください。`;
    }
    const cList = h('div');
    function carRow(x){
      const meta = [`${fmtDateTime(x.pickupAt)} ${x.pickupPlace||''}`.trim(), `→ ${fmtDateTime(x.returnAt)} ${x.returnPlace||x.pickupPlace||''}`.trim(), x.carClass ? `${x.carClass}クラス` : '', x.price!==''&&x.price!=null ? fmtYen(x.price) : '', x.confirmationNo ? `予約番号 ${x.confirmationNo}` : ''].filter(Boolean).join(' · ');
      return h('div',{class:'item', style:{cursor:'default'}},
        h('div',{class:'main'},
          h('div',{class:'title'}, x.company || '(会社未定)', ' ', badge(statusLabel(x.status), x.status||'other')),
          h('div',{class:'sub', style:{whiteSpace:'normal'}}, meta),
          x.memo ? h('div',{class:'sub', style:{whiteSpace:'pre-wrap'}}, x.memo) : null,
          h('div',{class:'row mt'},
            h('button',{class:'btn sm', onClick:()=>carModal(x)}, '編集'),
            h('button',{class:'btn sm', onClick:()=>addCarEvent(x)}, '📅 予定に追加'),
            h('button',{class:'btn sm danger', onClick: async()=>{ if (await UI.confirm(`「${x.company||'レンタカー'}」の記録を削除しますか?`)){ Store.remove('cars', x.id); toast('削除しました'); refreshAll(); } }}, '削除'))));
    }
    function renderCarList(){
      clear(cList);
      const all = Store.list('cars').sort((a,b)=>(a.pickupAt||'').localeCompare(b.pickupAt||''));
      if (!all.length){ cList.append(UI.empty('レンタカー予約の記録はありません。「予約を記録」から追加できます。')); return; }
      const upcoming = all.filter(x=>(x.returnAt||x.pickupAt||'').slice(0,10) >= today);
      const past = all.filter(x=>(x.returnAt||x.pickupAt||'').slice(0,10) < today);
      cList.append(upcoming.length ? h('div',{class:'list'}, upcoming.map(carRow)) : h('div',{class:'small muted'}, '今後のレンタカー記録はありません。'));
      const f = foldList('過去のレンタカー', past.map(carRow)); if (f) cList.append(f);
    }
    function carModal(rec){
      const isNew = !rec.id;
      const form = h('div',{class:'form'},
        h('div',{class:'f-row'},
          field('貸出日時', input({type:'datetime-local', name:'pickupAt', value:rec.pickupAt||''})),
          field('返却日時', input({type:'datetime-local', name:'returnAt', value:rec.returnAt||''}))),
        h('div',{class:'f-row'},
          field('貸出場所', input({name:'pickupPlace', value:rec.pickupPlace||''})),
          field('返却場所', input({name:'returnPlace', value:rec.returnPlace||'', placeholder:'空欄なら貸出場所と同じ'}))),
        h('div',{class:'f-row'},
          field('会社', h('input',{type:'text', name:'company', value:rec.company||'', list:'travel-car-companies', placeholder:'選択または入力'})),
          field('車クラス', select(CAR_CLASSES.map(c=>[c,c]), rec.carClass||'コンパクト', {name:'carClass'}))),
        h('div',{class:'f-row'},
          field('料金(円・合計)', input({type:'number', name:'price', value:(rec.price===undefined||rec.price===null)?'':rec.price, min:0})),
          field('予約番号', input({name:'confirmationNo', value:rec.confirmationNo||''}))),
        field('状態', select(STATUS, rec.status||'searching', {name:'status'})),
        field('メモ', textarea({name:'memo', value:rec.memo||'', rows:3, placeholder:'ETCカード、チャイルドシート、免責補償 など'})),
        datalist('travel-car-companies', CAR_COMPANIES)
      );
      UI.modal({ title: isNew ? 'レンタカー予約を記録' : 'レンタカー予約を編集', body: form,
        actions:[ {label:'キャンセル'}, {label:'保存', cls:'primary', onClick:()=>{
          const v = UI.readForm(form);
          if (!v.pickupAt){ toast('貸出日時を入力してください', {error:true}); return false; }
          if (v.returnAt && v.returnAt <= v.pickupAt){ toast('返却日時は貸出日時より後にしてください', {error:true}); return false; }
          Store.save('cars', Object.assign({}, rec, v));
          toast(isNew ? '記録しました' : '更新しました'); refreshAll();
        }} ] });
    }
    function addCarEvent(x){
      if (!x.pickupAt || x.pickupAt.length < 16){ toast('貸出日時がありません', {error:true}); return; }
      if (Store.where('events', e=>e.carId===x.id).length){ toast('このレンタカーはすでに予定に追加されています'); return; }
      const date = x.pickupAt.slice(0,10), start = x.pickupAt.slice(11,16);
      const name = x.company || 'レンタカー';
      Store.save('events', { date, start, end:addMinutes(start, 30), title:`レンタカー貸出: ${name}`, type:'move', customerId:'', address:x.pickupPlace||'', lat:null, lng:null,
        memo:[`返却 ${fmtDateTime(x.returnAt)} ${x.returnPlace||x.pickupPlace||''}`.trim(), x.carClass ? `${x.carClass}クラス` : '', x.confirmationNo ? `予約番号 ${x.confirmationNo}` : '', x.memo||''].filter(Boolean).join(' / '),
        status:'planned', attachmentIds:[], carId:x.id });
      toast(`${fmtDate(date)} ${start}の予定に「レンタカー貸出: ${name}」を追加しました`);
    }
    const carPanel = h('div', {style:{display:'none'}},
      h('div',{class:'card'}, h('h2',null,'レンタカーを探す'),
        cForm,
        h('div',{class:'row mt'},
          h('button',{class:'btn primary', onClick:showCarLinks}, '🔎 検索サイトを開く'),
          h('button',{class:'btn', onClick:()=>{ const v = UI.readForm(cForm); UI.copy(carCond(v)); }}, '📋 検索条件をコピー'),
          h('button',{class:'btn', onClick:()=>{ const v = UI.readForm(cForm); carModal({pickupAt:v.pickupAt, returnAt:v.returnAt, pickupPlace:v.pickupPlace, returnPlace: v.returnSame ? '' : v.returnPlace, carClass:v.carClass, status:'searching'}); }}, '📝 予約を記録')),
        cLinks, cLinkNote),
      h('div',{class:'card'}, h('h2',null,'レンタカー予約の記録'), cList)
    );

    /* ---------- タブ ---------- */
    const tabBtns = {};
    const tabGroup = h('div',{class:'btn-group'},
      tabBtns.hotel = h('button',{class:'btn', onClick:()=>switchTab('hotel')}, '🏨 ホテル'),
      tabBtns.car = h('button',{class:'btn', onClick:()=>switchTab('car')}, '🚗 レンタカー'));
    function switchTab(t){
      tab = t;
      hotelPanel.style.display = t==='hotel' ? '' : 'none';
      carPanel.style.display = t==='car' ? '' : 'none';
      Object.entries(tabBtns).forEach(([k,b])=>b.classList.toggle('active', k===t));
    }
    function refreshAll(){ renderSummary(); renderHotelList(); renderCarList(); }

    root.append(
      h('div',{class:'page-head'}, h('h1',null,'🏨 出張手配'), h('div',{class:'spacer'}), tabGroup),
      h('div',{class:'card compact notice'},
        h('div',{class:'small'}, h('strong',null,'このページでは予約そのものはできません。'), ' 条件を入力して各予約サイトを開き(可能な範囲で条件を引き継ぎます)、各サイトで予約した結果(予約番号・料金)をここに記録して管理します。')),
      h('div',{class:'card'}, h('h2',null,'今後の出張'), summaryEl),
      hotelPanel, carPanel
    );
    switchTab(tab);
    refreshAll();
    return { destroy(){} };
  }
});
