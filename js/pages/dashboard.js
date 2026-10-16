/* ホーム(ダッシュボード) */
App.register('dashboard', {
  title:'ホーム', icon:'🏠', tab:true, short:'ホーム',
  render(root){
    const { h } = UI;
    const S = App.Shared;
    const num = v => { const n = Number(v); return isNaN(n)?0:n; };

    function greeting(name){
      const hr = new Date().getHours();
      const g = hr < 11 ? 'おはようございます' : hr < 18 ? 'こんにちは' : 'こんばんは';
      return name ? `${name}さん、${g}` : g;
    }
    function weekRange(d){
      const dt = UI.parseDate(d); const dow = (dt.getDay()+6)%7;
      const mon = UI.addDays(d, -dow); return [mon, UI.addDays(mon,6)];
    }
    const stat = (v, l, href) => {
      const el = h(href?'a':'div', {class:'stat', href: href||null, style: href?{color:'inherit'}:null}, h('div',{class:'v'}, v), h('div',{class:'l'}, l));
      return el;
    };
    const evRow = (e, date) => {
      const c = e.customerId ? Store.get('customers', e.customerId) : null;
      const label = S.customerLabel(c);
      return h('a',{class:`ev ${e.type||'other'}${e.status==='done'?' done':''}`, href:`#/schedule?date=${date}`},
        h('div',{class:'time'}, [e.start, e.end].filter(Boolean).join('-') || '終日'),
        h('div',{class:'main', style:{minWidth:0, flex:1}},
          h('div',null, UI.badge(S.eventTypeLabel(e.type), e.type||'other'), ' ', e.status==='cancelled' ? h('s',null, e.title||label) : (e.title||label||'(無題)')),
          (label && e.title && e.title!==label) || e.address || (c&&c.address) ? h('div',{class:'small muted', style:{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}, [label && e.title!==label ? label : '', e.address || (c&&c.address) || ''].filter(Boolean).join(' · ')) : null
        )
      );
    };
    const linkItem = (href, title, sub, side) => h('a',{class:'item', href, style:{color:'inherit'}},
      h('div',{class:'main'}, h('div',{class:'title'}, title), sub?h('div',{class:'sub'}, sub):null),
      side?h('div',{class:'side'}, side):null);

    function draw(){
      UI.clear(root);
      const s = Store.settings();
      const today = UI.today(), tomorrow = UI.addDays(today,1);
      const [ws, we] = weekRange(today);
      const customers = Store.list('customers');
      const events = Store.list('events');
      const reports = Store.list('reports');
      const groups = Store.list('groups');
      const todayEvs = S.eventsOn(today);
      const tomorrowEvs = S.eventsOn(tomorrow);
      const weekVisits = events.filter(e=>e.type==='visit' && e.status!=='cancelled' && e.date>=ws && e.date<=we).length;
      const drafts = reports.filter(r=>r.status!=='submitted').length;
      const upcomingGroups = groups.filter(g=>g.status==='confirmed' && g.arrival>=today).length;
      const todayReport = reports.find(r=>r.date===today);

      root.appendChild(h('div',{class:'page-head'},
        h('div',null, h('h1',null, greeting(s.userName)), h('div',{class:'muted'}, UI.fmtDateLong(today), s.company?` · ${s.company}`:''))
      ));

      /* はじめに */
      if (!customers.length && !events.length){
        root.appendChild(h('div',{class:'card'},
          h('h2',null,'👋 はじめに'),
          h('p',{class:'small muted'},'3ステップで使い始められます。データはこの端末のブラウザ内に保存されます。'),
          h('div',{class:'steps'},
            h('a',{href:'#/settings'}, h('span',{class:'n'},'1'), h('div',null, h('div',{class:'title'},'設定で氏名・会社・拠点住所を登録'), h('div',{class:'small muted'},'拠点住所はルート作成の出発地になります'))),
            h('a',{href:'#/customers?new=1'}, h('span',{class:'n'},'2'), h('div',null, h('div',{class:'title'},'名刺(顧客)を登録'), h('div',{class:'small muted'},'名刺写真の保存・OCR読み取りもできます'))),
            h('a',{href:'#/schedule'}, h('span',{class:'n'},'3'), h('div',null, h('div',{class:'title'},'予定を入れる'), h('div',{class:'small muted'},'訪問予定から日報の下書きが自動で作られます')))
          )
        ));
      }

      /* クイックアクション */
      root.appendChild(h('div',{class:'link-list mb'},
        h('a',{href:'#/schedule'}, '📅 予定を追加'),
        h('a',{href:'#/customers?new=1'}, '📇 名刺を追加'),
        h('a',{href:`#/reports?date=${today}`}, '📝 日報を書く'),
        h('a',{href:'#/travel'}, '🏨 出張手配')
      ));

      /* 統計 */
      root.appendChild(h('div',{class:'stats mb'},
        stat(todayEvs.filter(e=>e.status!=='cancelled').length, '今日の予定', `#/schedule?date=${today}`),
        stat(weekVisits, '今週の訪問', '#/schedule'),
        stat(customers.length, '顧客数', '#/customers'),
        stat(drafts, '未提出の日報', '#/reports'),
        stat(upcomingGroups, '今後の団体(確定)', '#/groups')
      ));

      const grid = h('div',{class:'dash-grid'});
      root.appendChild(grid);

      /* 今日の予定 */
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'今日の予定', h('span',{class:'small muted'}, `${todayEvs.length}件`), h('span',{style:{flex:1}}),
          h('a',{class:'btn sm', href:`#/route?date=${today}`}, '🗺️ ルートを作る')),
        todayEvs.length ? h('div',{class:'timeline'}, todayEvs.map(e=>evRow(e, today))) : UI.empty('今日の予定はありません'),
        h('div',{class:'row mt'}, h('a',{class:'btn sm', href:`#/schedule?date=${today}`}, '予定を開く'))
      ));

      /* 明日の予定 */
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'明日の予定', h('span',{class:'small muted'}, `${UI.fmtDate(tomorrow)} ${tomorrowEvs.length}件`)),
        tomorrowEvs.length ? h('div',{class:'timeline'}, tomorrowEvs.slice(0,6).map(e=>evRow(e, tomorrow))) : UI.empty('明日の予定はありません'),
        tomorrowEvs.length>6 ? h('div',{class:'small muted mt'}, `他 ${tomorrowEvs.length-6}件`) : null
      ));

      /* 今日の日報 */
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'今日の日報'),
        todayReport
          ? h('div',null,
              h('div',{class:'row'}, UI.badge(todayReport.status==='submitted'?'提出済':'下書き', todayReport.status||'draft'), h('span',{class:'small muted'}, `更新 ${UI.fmtDateTime(todayReport.updatedAt)}`)),
              todayReport.body ? h('pre',{class:'plain small mt', style:{maxHeight:'120px', overflow:'hidden'}}, todayReport.body) : null,
              h('div',{class:'row mt'}, h('a',{class:'btn sm', href:`#/reports?date=${today}`}, todayReport.status==='submitted'?'日報を見る':'続きを書く')))
          : h('div',null, h('p',{class:'small muted'}, todayEvs.length ? `今日の予定 ${todayEvs.length}件から下書きを自動作成できます。` : '今日の日報はまだ作成されていません。'),
              h('a',{class:'btn primary', href:`#/reports?date=${today}`}, '📝 日報を書く'))
      ));

      /* 直近の出張手配 */
      const hotels = Store.list('hotels').filter(x=>(x.checkIn||'')>=today && x.status!=='cancelled').map(x=>({d:x.checkIn, kind:'🏨', title:x.hotelName||x.area||'ホテル', sub:[`${UI.fmtDate(x.checkIn)}〜${UI.fmtDate(x.checkOut)}`, x.area, x.confirmationNo?`予約番号 ${x.confirmationNo}`:'', x.status==='booked'?'予約済':'検索中'].filter(Boolean).join(' · ')}));
      const cars = Store.list('cars').filter(x=>(x.pickupAt||'').slice(0,10)>=today && x.status!=='cancelled').map(x=>({d:(x.pickupAt||'').slice(0,10), kind:'🚗', title:x.company||'レンタカー', sub:[`${UI.fmtDateTime(x.pickupAt)}〜${UI.fmtDateTime(x.returnAt)}`, x.pickupPlace, x.carClass, x.confirmationNo?`予約番号 ${x.confirmationNo}`:''].filter(Boolean).join(' · ')}));
      const travel = [...hotels, ...cars].sort((a,b)=>a.d.localeCompare(b.d)).slice(0,5);
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'直近の出張手配'),
        travel.length ? h('div',{class:'list'}, travel.map(t=>linkItem('#/travel', `${t.kind} ${t.title}`, t.sub, UI.fmtDate(t.d)))) : UI.empty('予定されている出張手配はありません'),
        h('div',{class:'row mt'}, h('a',{class:'btn sm', href:'#/travel'}, '出張手配を開く'))
      ));

      /* 直近の団体 */
      const upGroups = groups.filter(g=>(g.arrival||'')>=today && g.status!=='cancelled').sort((a,b)=>(a.arrival||'').localeCompare(b.arrival||'')).slice(0,5);
      const GST = { lead:['見込','draft'], confirmed:['確定','submitted'], done:['実施済','done'], cancelled:['キャンセル','cancelled'] };
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'直近の団体'),
        upGroups.length ? h('div',{class:'list'}, upGroups.map(g=>{
          const pax = num(g.pax&&g.pax.adult)+num(g.pax&&g.pax.child)+num(g.pax&&g.pax.infant);
          const st = GST[g.status]||['-','other'];
          return h('a',{class:'item', href:`#/groups?id=${g.id}`, style:{color:'inherit'}},
            h('div',{class:'main'}, h('div',{class:'title'}, g.groupName||'(団体名なし)', ' ', UI.badge(st[0], st[1])), h('div',{class:'sub'}, [g.agency, `${pax}名`, g.nights!==undefined&&g.nights!==''?`${g.nights}泊`:''].filter(Boolean).join(' · '))),
            h('div',{class:'side'}, UI.fmtDate(g.arrival), h('div',null, g.arrivalTime||'')));
        })) : UI.empty('今後の団体はありません'),
        h('div',{class:'row mt'}, h('a',{class:'btn sm', href:'#/groups'}, '団体打ち合わせ表を開く'))
      ));

      /* 最近更新した顧客 */
      const recent = customers.slice().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,5);
      grid.appendChild(h('div',{class:'card'},
        h('h2',null,'最近更新した顧客'),
        recent.length ? h('div',{class:'list'}, recent.map(c=>linkItem(`#/customers?id=${c.id}`, S.customerLabel(c)||'(名称なし)', [c.department, c.title, c.phone||c.mobile].filter(Boolean).join(' · '), UI.fmtDateTime(c.updatedAt)))) : UI.empty('顧客がまだありません'),
        h('div',{class:'row mt'}, h('a',{class:'btn sm', href:'#/customers'}, '顧客一覧を開く'))
      ));
    }

    draw();
    const refresh = UI.debounce(draw, 50);
    const off1 = Store.on('*', refresh);
    const off2 = Store.on('settings', refresh);
    return { destroy(){ off1(); off2(); } };
  }
});
