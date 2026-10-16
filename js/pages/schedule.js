/* スケジュール(月/週/日表示、予定の追加・編集) */
(function(){
  const VIEWS = [['month','月'],['week','週'],['day','日']];
  const STATUS = [['planned','予定'],['done','完了'],['cancelled','中止']];
  const statusLabel = s => (STATUS.find(x=>x[0]===s)||[,'予定'])[1];
  const isISO = d => /^\d{4}-\d{2}-\d{2}$/.test(d||'') && !isNaN(UI.parseDate(d));
  const evClass = e => ['ev', e.type||'other', e.status==='done'?'done':'', e.status==='cancelled'?'cancelled':''].filter(Boolean).join(' ');
  const timeLabel = e => e.start ? (e.end ? `${e.start}〜${e.end}` : e.start) : '時間未定';

  App.register('schedule', {
    title:'スケジュール', icon:'📅', tab:true, short:'予定',
    render(root, {params}){
      const { h, toast } = UI;
      let view = VIEWS.some(v=>v[0]===params.view) ? params.view : 'week';
      let selected = isISO(params.date) ? params.date : UI.today();

      /* ---------- 日付ユーティリティ ---------- */
      function weekStart(iso){ return UI.addDays(iso, -UI.parseDate(iso).getDay()); }
      function shift(n){
        if (view === 'month'){
          const cur = UI.parseDate(selected);
          const first = new Date(cur.getFullYear(), cur.getMonth()+n, 1);
          const dim = new Date(first.getFullYear(), first.getMonth()+1, 0).getDate();
          first.setDate(Math.min(cur.getDate(), dim));
          selected = UI.toISODate(first);
        } else if (view === 'week') selected = UI.addDays(selected, 7*n);
        else selected = UI.addDays(selected, n);
        rerender();
      }
      function periodLabel(){
        const d = UI.parseDate(selected);
        if (view === 'month') return `${d.getFullYear()}年${d.getMonth()+1}月`;
        if (view === 'week'){ const s = weekStart(selected); return `${UI.fmtDate(s,{year:true})} 〜 ${UI.fmtDate(UI.addDays(s,6))}`; }
        return UI.fmtDateLong(selected);
      }
      function syncHash(){
        try { history.replaceState(null, '', `#/schedule?view=${view}&date=${selected}`); } catch(e){}
      }

      /* ---------- 予定モーダル ---------- */
      function openEventModal(ev){
        const isNew = !ev || !ev.id;
        const data = Object.assign({ date:selected, start:'', end:'', title:'', type:'visit', customerId:'', address:'', lat:null, lng:null, memo:'', status:'planned', attachmentIds:[] }, ev||{});
        const { field, input, select, textarea } = UI;
        const titleInp = input({name:'title', value:data.title, placeholder:'例: ○○トラベル 訪問'});
        const addrInp = input({name:'address', value:data.address, placeholder:'訪問先の住所'});
        let autoTitle = '', autoAddr = '';
        const custSel = select(App.Shared.customerOptions(), data.customerId, {name:'customerId', onChange:()=>{
          const c = Store.get('customers', custSel.value);
          if (!c) return;
          const label = c.company || c.name || '';
          if (!titleInp.value.trim() || titleInp.value === autoTitle){ autoTitle = label ? `${label} 訪問` : ''; titleInp.value = autoTitle; }
          if (!addrInp.value.trim() || addrInp.value === autoAddr){ autoAddr = c.address || ''; addrInp.value = autoAddr; }
        }});
        const form = h('div',{class:'form'},
          h('div',{class:'f-row c3'},
            field('日付', input({type:'date', name:'date', value:data.date})),
            field('開始', input({type:'time', name:'start', value:data.start})),
            field('終了', input({type:'time', name:'end', value:data.end}))
          ),
          field('タイトル', titleInp),
          h('div',{class:'f-row'},
            field('種別', select(App.Shared.eventTypes, data.type, {name:'type'})),
            field('状態', select(STATUS, data.status, {name:'status'}))
          ),
          field('顧客', custSel, {hint:'選ぶと住所・タイトルを自動補完します'}),
          field('住所', addrInp, {hint:'保存時に座標を取得します(ルート作成で使用)'}),
          field('メモ', textarea({name:'memo', value:data.memo, rows:3})),
          h('div',{class:'f'}, h('label',null,'添付'),
            isNew ? h('div',{class:'small muted'}, '保存後に添付できます(「保存して添付」を押すと続けて添付できます)')
                  : App.Shared.attachments('event', data.id))
        );

        async function save(){
          const v = UI.readForm(form);
          v.title = (v.title||'').trim(); v.address = (v.address||'').trim(); v.memo = (v.memo||'').trim();
          if (!isISO(v.date)){ toast('日付を入力してください', {error:true}); return null; }
          if (!v.title){ toast('タイトルを入力してください', {error:true}); titleInp.focus(); return null; }
          if (v.start && v.end && v.end < v.start){ toast('終了時刻は開始時刻より後にしてください', {error:true}); return null; }
          const out = Object.assign({}, data, v, { attachmentIds: Array.isArray(data.attachmentIds) ? data.attachmentIds : [] });
          if (!out.address){ out.lat = null; out.lng = null; }
          else if (out.lat == null || out.lng == null || out.address !== data.address){
            const c = out.customerId ? Store.get('customers', out.customerId) : null;
            if (c && c.address === out.address && c.lat != null && c.lng != null){ out.lat = c.lat; out.lng = c.lng; }
            else {
              out.lat = null; out.lng = null;
              try {
                const g = await Geo.geocode(out.address);
                if (g){ out.lat = g.lat; out.lng = g.lng; } else toast('住所の座標が見つかりませんでした(予定は保存します)');
              } catch(e){ console.warn('geocode failed', e); toast('座標の取得に失敗しました(予定は保存します)'); }
            }
          }
          const saved = Store.save('events', out);
          selected = saved.date;
          return saved;
        }

        const actions = [];
        if (!isNew){
          actions.push({label:'削除', cls:'danger', left:true, onClick: async()=>{
            if (!await UI.confirm('この予定を削除しますか?')) return false;
            try { const fs = await Files.list('event', data.id); for (const f of fs) await Files.remove(f.id); } catch(e){ console.warn(e); }
            Store.remove('events', data.id); toast('削除しました');
          }});
          if (data.status !== 'done') actions.push({label:'✓ 完了にする', onClick:()=>{ Store.save('events', Object.assign({}, data, {status:'done'})); toast('完了にしました'); }});
        }
        actions.push({label:'キャンセル', onClick:()=>{}});
        if (isNew) actions.push({label:'保存して添付', onClick: async()=>{ const s = await save(); if(!s) return false; toast('保存しました'); setTimeout(()=>openEventModal(s), 0); }});
        actions.push({label:'保存', cls:'primary', onClick: async()=>{ const s = await save(); if(!s) return false; toast('保存しました'); }});
        UI.modal({ title: isNew ? '予定を追加' : '予定を編集', body: form, actions });
        if (isNew) setTimeout(()=>titleInp.focus(), 60);
      }

      function markDone(ev){ Store.save('events', Object.assign({}, ev, {status:'done'})); toast('完了にしました'); }

      /* ---------- タイムライン ---------- */
      function evRow(ev){
        const c = ev.customerId ? Store.get('customers', ev.customerId) : null;
        return h('div',{class:evClass(ev), onClick:()=>openEventModal(ev)},
          h('div',{class:'time'}, timeLabel(ev)),
          h('div',{class:'main'},
            h('div',{class:'row', style:{gap:'6px'}},
              h('span',{class:'title'}, ev.title || '(無題)'),
              UI.badge(App.Shared.eventTypeLabel(ev.type), ev.type||'other'),
              ev.status && ev.status !== 'planned' ? UI.badge(statusLabel(ev.status), ev.status) : null
            ),
            c ? h('div',{class:'small'}, h('a',{href:`#/customers?id=${encodeURIComponent(c.id)}`, onClick:(e)=>e.stopPropagation()}, '👤 ', App.Shared.customerLabel(c))) : null,
            ev.address ? h('div',{class:'small muted'}, '📍 ', ev.address) : null,
            ev.memo ? h('div',{class:'small muted'}, ev.memo.length > 60 ? ev.memo.slice(0,60)+'…' : ev.memo) : null
          ),
          (!ev.status || ev.status === 'planned') ? h('div',{class:'actions'}, h('button',{class:'btn sm', title:'完了にする', onClick:(e)=>{ e.stopPropagation(); markDone(ev); }}, '完了')) : null
        );
      }
      function daySection(date, {routeAlways=true}={}){
        const evs = App.Shared.eventsOn(date);
        const isToday = date === UI.today();
        const head = h('div',{class:'row between'},
          h('h3',null, UI.fmtDateLong(date), ' ', isToday ? UI.badge('今日','visit') : null, h('span',{class:'small muted'}, ` ${evs.length}件`)),
          h('div',{class:'row'},
            h('button',{class:'btn sm', onClick:()=>openEventModal({date})}, '＋ 追加'),
            (routeAlways || evs.length) ? h('button',{class:'btn sm', onClick:()=>App.go(`#/route?date=${date}`)}, '🚗 この日のルートを作る') : null
          )
        );
        const tl = h('div',{class:'timeline mt'});
        if (!evs.length) tl.appendChild(h('div',{class:'small muted', style:{padding:'4px 0'}}, '予定なし'));
        evs.forEach(e=>tl.appendChild(evRow(e)));
        return h('div',{class:'day-sec'}, head, tl);
      }

      /* ---------- 月表示 ---------- */
      function monthGrid(){
        const d = UI.parseDate(selected); const y = d.getFullYear(), m = d.getMonth();
        const first = new Date(y, m, 1); const offset = first.getDay();
        const dim = new Date(y, m+1, 0).getDate();
        const rows = Math.ceil((offset + dim) / 7);
        const startISO = UI.addDays(UI.toISODate(first), -offset);
        const byDate = {};
        Store.list('events').forEach(e=>{ (byDate[e.date] = byDate[e.date] || []).push(e); });
        const grid = h('div',{class:'cal-grid'});
        UI.DOW.forEach(w=>grid.appendChild(h('div',{class:'cal-dow'}, w)));
        const today = UI.today();
        for (let i=0; i<rows*7; i++){
          const iso = UI.addDays(startISO, i);
          const dd = UI.parseDate(iso);
          const evs = (byDate[iso]||[]).sort((a,b)=>(a.start||'').localeCompare(b.start||''));
          const cls = ['cal-cell', dd.getMonth()!==m ? 'other' : '', iso===today ? 'today' : '', iso===selected ? 'selected' : ''].filter(Boolean).join(' ');
          const cell = h('div',{class:cls, role:'button', tabindex:'0', 'aria-label':`${UI.fmtDate(iso)} ${evs.length}件`,
            onClick:()=>{ selected = iso; rerender(); },
            onKeydown:(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); selected = iso; rerender(); } }},
            h('div',{class:'d'}, dd.getDate()));
          evs.slice(0,3).forEach(e=>cell.appendChild(h('div',{class:evClass(e), title:`${e.start||''} ${e.title||''}`}, e.start ? e.start+' ' : '', e.title || '(無題)')));
          if (evs.length > 3) cell.appendChild(h('div',{class:'ev other'}, `+${evs.length-3}件`));
          if (evs.length) cell.appendChild(h('div',{class:'dots'}, evs.slice(0,4).map(()=>h('span',{class:'dot'}))));
          grid.appendChild(cell);
        }
        return grid;
      }

      /* ---------- 表示 ---------- */
      function controls(){
        return h('div',{class:'card compact'},
          h('div',{class:'row between'},
            h('div',{class:'btn-group'}, VIEWS.map(([v,l])=>h('button',{class:'btn'+(view===v?' active':''), onClick:()=>{ view = v; rerender(); }}, l))),
            h('div',{class:'row'},
              h('button',{class:'btn sm', 'aria-label':'前へ', onClick:()=>shift(-1)}, '◀'),
              h('button',{class:'btn sm', onClick:()=>{ selected = UI.today(); rerender(); }}, '今日'),
              h('button',{class:'btn sm', 'aria-label':'次へ', onClick:()=>shift(1)}, '▶')
            )
          ),
          h('div',{class:'mt', style:{fontWeight:600}}, periodLabel())
        );
      }
      function viewEl(){
        if (view === 'month') return [ h('div',{class:'card'}, monthGrid()), h('div',{class:'card'}, daySection(selected)) ];
        if (view === 'week'){ const s = weekStart(selected); return h('div',{class:'card'}, Array.from({length:7},(_,i)=>daySection(UI.addDays(s,i), {routeAlways:false}))); }
        return h('div',{class:'card'}, daySection(selected));
      }
      const body = h('div');
      function rerender(){ syncHash(); UI.clear(body); UI.append(body, [controls(), viewEl()]); }

      root.append(
        h('div',{class:'page-head'}, h('h1',null,'📅 スケジュール'), h('div',{class:'spacer'}),
          h('button',{class:'btn primary', onClick:()=>openEventModal({date:selected})}, '＋ 予定を追加')),
        body
      );
      rerender();
      const offs = [Store.on('events', rerender), Store.on('customers', rerender)];
      return { destroy(){ offs.forEach(f=>f()); } };
    }
  });
})();
