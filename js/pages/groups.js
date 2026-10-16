/* 団体打ち合わせ表 */
App.register('groups', {
  title:'団体打ち合わせ表', icon:'🚌', tab:false,
  render(root, {params}){
    const { h, field, input, select, textarea, toast } = UI;
    const S = App.Shared;
    const STATUS = [['lead','見込'],['confirmed','確定'],['done','実施済'],['cancelled','キャンセル']];
    const STATUS_CLS = { lead:'draft', confirmed:'submitted', done:'done', cancelled:'cancelled' };
    const TYPES = ['観光','研修','スポーツ','宴会','慰安旅行','修学旅行・教育旅行','その他'];
    const PAYMENTS = ['現地精算','請求書(後払い)','事前振込','クレジットカード','その他'];
    const BANQUET_STYLES = ['座敷(お膳)','テーブル','立食','半立食','なし'];
    const ROOM_TYPES = ['和室','洋室ツイン','洋室シングル','洋室トリプル','和洋室','特別室','ドライバー室'];
    const statusLabel = s => (STATUS.find(x=>x[0]===s)||[,'-'])[1];
    const statusBadge = s => UI.badge(statusLabel(s), STATUS_CLS[s]||'other');
    const num = v => { const n = Number(v); return isNaN(n)?0:n; };
    const paxTotal = g => num(g.pax&&g.pax.adult)+num(g.pax&&g.pax.child)+num(g.pax&&g.pax.infant);
    const roomsTotal = g => (g.rooms||[]).reduce((a,r)=>({count:a.count+num(r.count), cap:a.cap+num(r.count)*num(r.capacity)}), {count:0,cap:0});
    const nightsOf = (a,d) => (a&&d) ? Math.max(0, UI.diffDays(a,d)) : 0;
    const fmtD = d => d ? UI.fmtDate(d,{year:true}) : '';
    const fmtTime = (d,t) => [fmtD(d), t].filter(Boolean).join(' ');

    function blank(){
      const s = Store.settings(); const t = UI.today();
      return { groupName:'', groupType:'観光', status:'lead',
        agency:'', agencyContact:'', agencyTel:'', agencyEmail:'',
        representative:'', organizerContact:'',
        arrival:t, arrivalTime:'15:00', departure:UI.addDays(t,1), departureTime:'10:00', nights:1,
        pax:{adult:'',child:'',infant:''}, escorts:'', drivers:'', buses:'', transport:'',
        rooms:[{type:'和室', count:'', capacity:4}], roomRequest:'',
        meals:{dinner:'', breakfast:'', lunch:''}, allergy:'', drinks:'',
        banquet:{room:'', start:'18:00', end:'20:00', style:'座敷(お膳)'}, afterParty:'',
        rate:'', payment:'現地精算', paymentDue:'', cancelPolicyConfirmed:false,
        luggage:'', notes:'', staff:s.userName||'' };
    }
    function unflatten(flat){
      const out = {};
      for (const [k,v] of Object.entries(flat)){
        const ks = k.split('.'); let o = out;
        ks.slice(0,-1).forEach(p=>{ o = o[p] = o[p] || {}; });
        o[ks[ks.length-1]] = v;
      }
      return out;
    }

    /* ---------- 編集フォーム(モーダル) ---------- */
    function openEditor(src, onSaved){
      const g = Object.assign(blank(), JSON.parse(JSON.stringify(src||{})));
      g.pax = Object.assign({adult:'',child:'',infant:''}, g.pax||{});
      g.meals = Object.assign({dinner:'',breakfast:'',lunch:''}, g.meals||{});
      g.banquet = Object.assign({room:'',start:'',end:'',style:''}, g.banquet||{});

      /* 客室 動的行 */
      const roomsBox = h('div',{class:'room-rows'});
      const roomsTotalEl = h('span',{class:'small muted'});
      const readRooms = ()=> Array.from(roomsBox.children).map(row=>{
        const o = {}; row.querySelectorAll('input').forEach(i=>{ o[i.dataset.k] = i.type==='number' ? (i.value===''?'':Number(i.value)) : i.value; }); return o;
      }).filter(r=> r.type || r.count);
      const updRooms = ()=>{ const t = roomsTotal({rooms:readRooms()}); roomsTotalEl.textContent = `合計 ${t.count}室 / 収容 ${t.cap}名`; };
      function roomRow(r){
        const row = h('div',{class:'room-row'},
          input({value:r.type||'', placeholder:'部屋タイプ', list:'group-room-types', dataset:{k:'type'}}),
          input({type:'number', min:0, value:r.count===undefined?'':r.count, placeholder:'室数', dataset:{k:'count'}}),
          input({type:'number', min:0, value:r.capacity===undefined?'':r.capacity, placeholder:'定員', dataset:{k:'capacity'}}),
          h('button',{class:'btn sm danger', type:'button', 'aria-label':'行を削除', onClick:()=>{ row.remove(); updRooms(); }}, '✕'));
        row.addEventListener('input', updRooms);
        return row;
      }
      (g.rooms && g.rooms.length ? g.rooms : [{type:'',count:'',capacity:''}]).forEach(r=>roomsBox.appendChild(roomRow(r)));
      updRooms();
      const datalist = h('datalist',{id:'group-room-types'}, ROOM_TYPES.map(t=>h('option',{value:t})));

      /* 宿泊数・人数の自動計算 */
      const arrInp = input({type:'date', name:'arrival', value:g.arrival});
      const depInp = input({type:'date', name:'departure', value:g.departure});
      const nightsInp = input({type:'number', name:'nights', value:g.nights, min:0});
      const updNights = ()=>{ if(arrInp.value && depInp.value){ if(depInp.value < arrInp.value){ depInp.value = arrInp.value; } nightsInp.value = nightsOf(arrInp.value, depInp.value); } };
      arrInp.addEventListener('change', updNights); depInp.addEventListener('change', updNights);
      const paxTotalEl = h('span',{class:'small muted'});
      const paxInp = k => input({type:'number', name:'pax.'+k, value:g.pax[k], min:0, onInput:updPax});
      function updPax(){ const v = UI.readForm(paxRow); paxTotalEl.textContent = `合計 ${num(v['pax.adult'])+num(v['pax.child'])+num(v['pax.infant'])}名`; }
      const paxRow = h('div',{class:'f-row c3'},
        field('大人', paxInp('adult')), field('子供', paxInp('child')), field('幼児', paxInp('infant')));
      updPax();

      const sec = (title)=>h('h3',{class:'mt', style:{borderBottom:'1px solid var(--border)', paddingBottom:'4px'}}, title);
      const form = h('div',{class:'form'},
        sec('基本情報'),
        field('団体名 *', input({name:'groupName', value:g.groupName, placeholder:'例: ○○株式会社 社員旅行御一行様'})),
        h('div',{class:'f-row'},
          field('団体種別', select(TYPES, g.groupType, {name:'groupType'})),
          field('状態', select(STATUS, g.status, {name:'status'}))
        ),
        h('div',{class:'f-row'},
          field('旅行会社 / 法人名', input({name:'agency', value:g.agency, placeholder:'例: ○○トラベル 大阪支店'})),
          field('代理店担当者', input({name:'agencyContact', value:g.agencyContact}))
        ),
        h('div',{class:'f-row'},
          field('代理店TEL', input({type:'tel', name:'agencyTel', value:g.agencyTel})),
          field('代理店メール', input({type:'email', name:'agencyEmail', value:g.agencyEmail}))
        ),
        h('div',{class:'f-row'},
          field('団体代表者名', input({name:'representative', value:g.representative})),
          field('幹事連絡先', input({name:'organizerContact', value:g.organizerContact, placeholder:'氏名・携帯番号など'}))
        ),
        sec('日程・人数'),
        h('div',{class:'f-row'},
          field('到着日', arrInp), field('到着時刻', input({type:'time', name:'arrivalTime', value:g.arrivalTime}))
        ),
        h('div',{class:'f-row'},
          field('出発日', depInp), field('出発時刻', input({type:'time', name:'departureTime', value:g.departureTime}))
        ),
        field('宿泊数(泊)', nightsInp, {hint:'到着日・出発日から自動計算されます(手入力も可)'}),
        paxRow, paxTotalEl,
        h('div',{class:'f-row c3'},
          field('添乗員(名)', input({type:'number', name:'escorts', value:g.escorts, min:0})),
          field('ドライバー(名)', input({type:'number', name:'drivers', value:g.drivers, min:0})),
          field('バス台数', input({type:'number', name:'buses', value:g.buses, min:0}))
        ),
        field('送迎・交通', input({name:'transport', value:g.transport, placeholder:'例: 貸切バス2台 / ○○駅送迎あり'})),
        sec('客室'),
        h('div',{class:'small muted'}, '部屋タイプ / 室数 / 定員'),
        roomsBox, datalist,
        h('div',{class:'row'},
          h('button',{class:'btn sm', type:'button', onClick:()=>{ roomsBox.appendChild(roomRow({type:'',count:'',capacity:''})); updRooms(); }}, '+ 部屋を追加'),
          roomsTotalEl
        ),
        field('部屋割り希望', textarea({name:'roomRequest', value:g.roomRequest, rows:2, placeholder:'例: 幹事は1階、男女フロア分け など'})),
        sec('食事'),
        field('夕食', input({name:'meals.dinner', value:g.meals.dinner, placeholder:'例: 会席 ¥8,000 大広間 18:00'})),
        h('div',{class:'f-row'},
          field('朝食', input({name:'meals.breakfast', value:g.meals.breakfast, placeholder:'例: バイキング 7:00〜'})),
          field('昼食', input({name:'meals.lunch', value:g.meals.lunch, placeholder:'例: なし / 弁当手配'}))
        ),
        field('アレルギー・食事制限', textarea({name:'allergy', value:g.allergy, rows:2})),
        field('飲み放題・追加注文', input({name:'drinks', value:g.drinks, placeholder:'例: 飲み放題90分 ¥2,000 / ビール追加'})),
        sec('宴会'),
        h('div',{class:'f-row'},
          field('会場', input({name:'banquet.room', value:g.banquet.room, placeholder:'例: 大広間「鶴」'})),
          field('形式', select(BANQUET_STYLES.includes(g.banquet.style)||!g.banquet.style ? BANQUET_STYLES : [...BANQUET_STYLES, g.banquet.style], g.banquet.style||'座敷(お膳)', {name:'banquet.style'}))
        ),
        h('div',{class:'f-row'},
          field('開始', input({type:'time', name:'banquet.start', value:g.banquet.start})),
          field('終了', input({type:'time', name:'banquet.end', value:g.banquet.end}))
        ),
        field('カラオケ・二次会', input({name:'afterParty', value:g.afterParty, placeholder:'例: カラオケルーム 20:30〜22:00'})),
        sec('料金・精算'),
        field('料金', input({name:'rate', value:g.rate, placeholder:'例: 1名 ¥15,000(税サ込)/ 子供 ¥9,000'})),
        h('div',{class:'f-row'},
          field('精算方法', select(PAYMENTS.includes(g.payment)||!g.payment ? PAYMENTS : [...PAYMENTS, g.payment], g.payment||'現地精算', {name:'payment'})),
          field('入金予定', input({name:'paymentDue', value:g.paymentDue, placeholder:'例: 出発後翌月末 / 10/20 振込'}))
        ),
        h('div',{class:'f inline'}, h('input',{type:'checkbox', name:'cancelPolicyConfirmed', id:'g-cancel', checked:!!g.cancelPolicyConfirmed}), h('label',{for:'g-cancel'}, 'キャンセル規定を先方に確認済み')),
        sec('その他'),
        field('荷物', input({name:'luggage', value:g.luggage, placeholder:'例: 事前宅配あり(前日着)'})),
        field('特記事項', textarea({name:'notes', value:g.notes, rows:3})),
        field('担当者', input({name:'staff', value:g.staff}))
      );

      UI.modal({ title: src && src.id ? '団体打ち合わせ表を編集' : '団体打ち合わせ表を作成', body: form, wide:true,
        actions:[
          {label:'キャンセル', onClick:()=>{}},
          {label:'保存', cls:'primary', onClick:()=>{
            const v = unflatten(UI.readForm(form));
            if (!v.groupName || !v.groupName.trim()){ toast('団体名を入力してください', {error:true}); return false; }
            Object.assign(g, v);
            g.rooms = readRooms();
            if (g.arrival && g.departure && g.nights === '') g.nights = nightsOf(g.arrival, g.departure);
            Store.save('groups', g);
            toast('保存しました');
            onSaved && onSaved(g);
          }}
        ]});
    }

    /* ---------- 帳票 ---------- */
    function sheet(g){
      const s = Store.settings();
      const th = t => h('th',null,t);
      const td = (t, attrs) => h('td', attrs||null, t===undefined||t===null?'':t);
      const pre = t => h('div',{style:{whiteSpace:'pre-wrap', minHeight:'1.5em'}}, t||'');
      const pt = paxTotal(g), rt = roomsTotal(g);
      const rooms = (g.rooms||[]).length
        ? h('table',{class:'inner'}, h('tbody',null,
            h('tr',null, td(h('b',null,'タイプ')), td(h('b',null,'室数')), td(h('b',null,'定員')), td(h('b',null,'収容'))),
            ...(g.rooms||[]).map(r=>h('tr',null, td(r.type||''), td(r.count!==''&&r.count!==undefined?`${r.count}室`:''), td(r.capacity!==''&&r.capacity!==undefined?`${r.capacity}名`:''), td(`${num(r.count)*num(r.capacity)}名`))),
            h('tr',null, td(h('b',null,'合計')), td(h('b',null,`${rt.count}室`)), td(''), td(h('b',null,`${rt.cap}名`)))
          ))
        : pre('');
      return h('div',{class:'sheet c4'},
        h('div',{class:'head'},
          h('div',null, h('div',{style:{fontWeight:600}}, s.company||''), h('div',{class:'small'}, `作成日 ${UI.fmtDate(UI.today(),{year:true})}`), h('div',{class:'small'}, `担当者 ${g.staff||s.userName||''}`)),
          h('div',{class:'sign', style:{marginTop:0}}, h('div',null,'社長'), h('div',null,'部長'), h('div',null,'担当'))
        ),
        h('h1',null,'団 体 打 合 せ 表'),
        h('div',{class:'meta'}, h('span',null,`状態: ${statusLabel(g.status)}`), h('span',null,`団体種別: ${g.groupType||''}`), g.updatedAt?h('span',null,`更新: ${UI.fmtDateTime(g.updatedAt)}`):null),
        h('table',null, h('tbody',null,
          h('tr',null, th('団体名'), td(h('b',null,g.groupName||''), {colspan:3})),
          h('tr',null, th('旅行会社 / 法人'), td(g.agency), th('代理店担当'), td([g.agencyContact, g.agencyTel, g.agencyEmail].filter(Boolean).join(' / '))),
          h('tr',null, th('団体代表者'), td(g.representative), th('幹事連絡先'), td(g.organizerContact)),
          h('tr',null, th('到着'), td(fmtTime(g.arrival, g.arrivalTime)), th('出発'), td(`${fmtTime(g.departure, g.departureTime)}${g.nights!==''&&g.nights!==undefined?`(${g.nights}泊)`:''}`)),
          h('tr',null, th('人数'), td(`大人 ${num(g.pax&&g.pax.adult)}名 / 子供 ${num(g.pax&&g.pax.child)}名 / 幼児 ${num(g.pax&&g.pax.infant)}名  計 ${pt}名`), th('添乗員 / ドライバー'), td(`添乗員 ${num(g.escorts)}名 / ドライバー ${num(g.drivers)}名`)),
          h('tr',null, th('バス'), td(g.buses!==''&&g.buses!==undefined?`${g.buses}台`:''), th('送迎・交通'), td(g.transport)),
          h('tr',null, th('客室'), td(rooms, {colspan:3})),
          h('tr',null, th('部屋割り希望'), td(pre(g.roomRequest), {colspan:3})),
          h('tr',null, th('夕食'), td(g.meals&&g.meals.dinner), th('朝食'), td(g.meals&&g.meals.breakfast)),
          h('tr',null, th('昼食'), td(g.meals&&g.meals.lunch), th('アレルギー・食事制限'), td(pre(g.allergy))),
          h('tr',null, th('宴会'), td([g.banquet&&g.banquet.room, [g.banquet&&g.banquet.start, g.banquet&&g.banquet.end].filter(Boolean).join('〜'), g.banquet&&g.banquet.style].filter(Boolean).join(' / ')), th('飲み放題・追加'), td(g.drinks)),
          h('tr',null, th('カラオケ・二次会'), td(g.afterParty, {colspan:3})),
          h('tr',null, th('料金'), td(g.rate), th('精算方法'), td(g.payment)),
          h('tr',null, th('入金予定'), td(g.paymentDue), th('キャンセル規定'), td(g.cancelPolicyConfirmed?'先方確認済':'未確認')),
          h('tr',null, th('荷物'), td(g.luggage, {colspan:3})),
          h('tr',null, th('特記事項'), td(pre(g.notes), {colspan:3}))
        ))
      );
    }

    /* ---------- テキスト ---------- */
    function groupText(g){
      const s = Store.settings();
      const pt = paxTotal(g), rt = roomsTotal(g);
      const L = [];
      L.push(`【団体打合せ表】${g.groupName||''}(${statusLabel(g.status)})`);
      if (s.company) L.push(s.company);
      L.push(`担当: ${g.staff||s.userName||''}`);
      L.push('');
      L.push(`団体種別: ${g.groupType||''}`);
      L.push(`旅行会社/法人: ${g.agency||''}  担当: ${[g.agencyContact, g.agencyTel, g.agencyEmail].filter(Boolean).join(' / ')}`);
      L.push(`代表者: ${g.representative||''}  幹事連絡先: ${g.organizerContact||''}`);
      L.push('');
      L.push(`到着: ${fmtTime(g.arrival, g.arrivalTime)}`);
      L.push(`出発: ${fmtTime(g.departure, g.departureTime)}(${g.nights||0}泊)`);
      L.push(`人数: 大人${num(g.pax&&g.pax.adult)} 子供${num(g.pax&&g.pax.child)} 幼児${num(g.pax&&g.pax.infant)} 計${pt}名  添乗員${num(g.escorts)} ドライバー${num(g.drivers)}`);
      L.push(`バス: ${g.buses||0}台  送迎・交通: ${g.transport||''}`);
      L.push('');
      L.push('■客室');
      (g.rooms||[]).forEach(r=> L.push(`  ${r.type||''} ${r.count||0}室 × 定員${r.capacity||0}名`));
      L.push(`  合計 ${rt.count}室 / 収容 ${rt.cap}名`);
      if (g.roomRequest) L.push(`  部屋割り希望: ${g.roomRequest}`);
      L.push('');
      L.push('■食事');
      L.push(`  夕食: ${g.meals&&g.meals.dinner||''}`);
      L.push(`  朝食: ${g.meals&&g.meals.breakfast||''}`);
      L.push(`  昼食: ${g.meals&&g.meals.lunch||''}`);
      if (g.allergy) L.push(`  アレルギー・食事制限: ${g.allergy}`);
      if (g.drinks) L.push(`  飲み放題・追加: ${g.drinks}`);
      L.push('');
      L.push('■宴会');
      L.push(`  会場: ${g.banquet&&g.banquet.room||''}  時間: ${[g.banquet&&g.banquet.start, g.banquet&&g.banquet.end].filter(Boolean).join('〜')}  形式: ${g.banquet&&g.banquet.style||''}`);
      if (g.afterParty) L.push(`  カラオケ・二次会: ${g.afterParty}`);
      L.push('');
      L.push('■料金・精算');
      L.push(`  料金: ${g.rate||''}`);
      L.push(`  精算方法: ${g.payment||''}  入金予定: ${g.paymentDue||''}`);
      L.push(`  キャンセル規定: ${g.cancelPolicyConfirmed?'先方確認済':'未確認'}`);
      if (g.luggage){ L.push(''); L.push(`荷物: ${g.luggage}`); }
      if (g.notes){ L.push(''); L.push('■特記事項'); L.push(g.notes); }
      return L.join('\n');
    }

    /* ---------- 予定に追加 ---------- */
    function addToSchedule(g){
      if (!g.arrival){ toast('到着日が未設定です', {error:true}); return; }
      const title = `【団体】${g.groupName||''} 到着${g.arrivalTime?' '+g.arrivalTime:''}`;
      if (Store.where('events', e=>e.date===g.arrival && e.title===title).length){ toast('同じ予定がすでに登録されています'); return; }
      Store.save('events', { date:g.arrival, start:g.arrivalTime||'', end:'', title, type:'other', customerId:'', address:'', lat:null, lng:null,
        memo:[g.agency, `${paxTotal(g)}名`, g.buses?`バス${g.buses}台`:''].filter(Boolean).join(' '), status:'planned', attachmentIds:[] });
      toast('到着日の予定に追加しました');
    }

    /* ---------- 詳細 ---------- */
    function drawDetail(g){
      UI.clear(root);
      const pt = paxTotal(g), rt = roomsTotal(g);
      root.append(
        h('div',{class:'page-head'},
          h('button',{class:'btn sm', onClick:()=>App.go('groups')}, '◀ 一覧'),
          h('h1',null,'🚌 ', g.groupName||'(団体名なし)'), statusBadge(g.status),
          h('div',{class:'spacer'}),
          h('button',{class:'btn primary', onClick:()=>openEditor(g, (ng)=>drawDetail(ng))}, '✏️ 編集')
        ),
        h('div',{class:'stats mb'},
          h('div',{class:'stat'}, h('div',{class:'v'}, fmtD(g.arrival)), h('div',{class:'l'}, `到着 ${g.arrivalTime||''}`)),
          h('div',{class:'stat'}, h('div',{class:'v'}, `${g.nights||0}泊`), h('div',{class:'l'}, `出発 ${fmtD(g.departure)} ${g.departureTime||''}`)),
          h('div',{class:'stat'}, h('div',{class:'v'}, `${pt}名`), h('div',{class:'l'}, `大人${num(g.pax&&g.pax.adult)} 子供${num(g.pax&&g.pax.child)} 幼児${num(g.pax&&g.pax.infant)}`)),
          h('div',{class:'stat'}, h('div',{class:'v'}, `${rt.count}室`), h('div',{class:'l'}, `収容 ${rt.cap}名`))
        ),
        h('div',{class:'card'},
          h('h2',null,'操作'),
          h('div',{class:'row'},
            h('button',{class:'btn', onClick:()=>UI.printElement(sheet(g), `団体打合せ表 ${g.groupName||''}`)}, '🖨️ 印刷/PDF'),
            h('button',{class:'btn', onClick:()=>UI.copy(groupText(g))}, '📋 テキストでコピー'),
            h('button',{class:'btn', onClick:()=>addToSchedule(g)}, '📅 予定に追加'),
            h('button',{class:'btn', onClick:()=>{
              const c = JSON.parse(JSON.stringify(g)); delete c.id; delete c.createdAt; delete c.updatedAt;
              c.groupName = (c.groupName||'')+'(コピー)'; c.status = 'lead';
              const saved = Store.save('groups', c); toast('複製しました'); App.go(`groups?id=${saved.id}`);
            }}, '📑 複製'),
            h('button',{class:'btn danger', onClick: async()=>{ if(await UI.confirm(`「${g.groupName}」を削除しますか?(添付も削除されます)`)){ for (const f of await Files.list('group', g.id)) await Files.remove(f.id); Store.remove('groups', g.id); toast('削除しました'); App.go('groups'); } }}, '削除')
          ),
          g.status==='lead' ? h('div',{class:'row mt'}, h('button',{class:'btn sm', onClick:()=>{ g.status='confirmed'; Store.save('groups', g); toast('確定にしました'); drawDetail(g); }}, '✅ 確定にする')) :
          g.status==='confirmed' && g.departure && g.departure < UI.today() ? h('div',{class:'row mt'}, h('button',{class:'btn sm', onClick:()=>{ g.status='done'; Store.save('groups', g); toast('実施済にしました'); drawDetail(g); }}, '🏁 実施済にする')) : null
        ),
        h('div',{class:'card'}, h('h2',null,'帳票プレビュー'), h('div',{class:'tbl-wrap'}, sheet(g))),
        h('div',{class:'card'}, h('h2',null,'添付(行程表・バス配車表など)'), S.attachments('group', g.id))
      );
    }

    /* ---------- 一覧 ---------- */
    let filter = '';
    function drawList(){
      UI.clear(root);
      const search = h('input',{type:'search', placeholder:'団体名・旅行会社で検索'});
      const chips = h('div',{class:'chip-row'});
      const list = h('div',{class:'list'});
      const summary = h('div',{class:'small muted mb'});
      function refresh(){
        UI.clear(chips);
        [['','すべて'], ...STATUS].forEach(([k,l])=> chips.appendChild(h('button',{class:'chip'+(filter===k?' active':''), onClick:()=>{ filter=k; refresh(); }}, l)));
        const q = search.value.trim().toLowerCase();
        const rows = Store.list('groups')
          .filter(g=> (!filter || g.status===filter) && (!q || (g.groupName||'').toLowerCase().includes(q) || (g.agency||'').toLowerCase().includes(q)))
          .sort((a,b)=> (a.arrival||'').localeCompare(b.arrival||'') || (b.updatedAt||'').localeCompare(a.updatedAt||''));
        const today = UI.today();
        const upcoming = Store.list('groups').filter(g=>g.status==='confirmed' && g.arrival>=today);
        summary.textContent = `全${Store.list('groups').length}件 / 今後の確定 ${upcoming.length}件(${upcoming.reduce((a,g)=>a+paxTotal(g),0)}名)`;
        UI.clear(list);
        if (!rows.length){ list.appendChild(UI.empty('団体打ち合わせ表がありません。「新規作成」から追加してください。')); return; }
        for (const g of rows){
          const past = g.departure && g.departure < today;
          list.appendChild(h('div',{class:'item', style: past?{opacity:.7}:null, onClick:()=>App.go(`groups?id=${g.id}`)},
            h('div',{class:'main'},
              h('div',{class:'title'}, g.groupName||'(団体名なし)', ' ', statusBadge(g.status)),
              h('div',{class:'sub'}, [g.agency, g.groupType].filter(Boolean).join(' · ')),
              h('div',{class:'sub'}, `${fmtD(g.arrival)} ${g.arrivalTime||''} 〜 ${fmtD(g.departure)}(${g.nights||0}泊) · ${paxTotal(g)}名 · ${roomsTotal(g).count}室${g.buses?` · バス${g.buses}台`:''}`)
            ),
            h('div',{class:'side'}, g.staff||'', g.updatedAt?h('div',null,UI.fmtDateTime(g.updatedAt)):null)
          ));
        }
      }
      search.addEventListener('input', UI.debounce(refresh, 200));
      root.append(
        h('div',{class:'page-head'}, h('h1',null,'🚌 団体打ち合わせ表'), h('div',{class:'spacer'}),
          h('div',{class:'search', style:{minWidth:'200px'}}, search),
          h('button',{class:'btn primary', onClick:()=>openEditor(null, (g)=>App.go(`groups?id=${g.id}`))}, '＋ 新規作成')),
        h('div',{class:'card'}, summary, chips, h('div',{class:'mt'}, list))
      );
      refresh();
    }

    const id = params && params.id;
    const g = id ? Store.get('groups', id) : null;
    if (id && !g){ toast('団体表が見つかりません', {error:true}); }
    if (g) drawDetail(g); else drawList();
  }
});
