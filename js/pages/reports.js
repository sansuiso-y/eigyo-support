/* 営業日報 */
App.register('reports', {
  title:'営業日報', icon:'📝', tab:true, short:'日報',
  render(root, {params}){
    const { h, field, input, select, textarea, toast } = UI;
    const S = App.Shared;
    const STATUS = { draft:'下書き', submitted:'提出済' };
    const date = (params && /^\d{4}-\d{2}-\d{2}$/.test(params.date||'')) ? params.date : UI.today();

    const findReport = d => Store.where('reports', r=>r.date===d)[0] || null;

    /* ---- 予定 → 本文行 ---- */
    function evLine(e){
      const c = e.customerId ? Store.get('customers', e.customerId) : null;
      const time = [e.start, e.end].filter(Boolean).join('-');
      const who = c ? S.customerLabel(c) : '';
      const addr = e.address || (c && c.address) || '';
      let main = who || e.title || '';
      if (addr) main += `(${addr})`;
      const parts = [time, S.eventTypeLabel(e.type), main];
      if (who && e.title && e.title !== who) parts.push(e.title);
      if (e.memo) parts.push(e.memo);
      if (e.status === 'cancelled') parts.push('※キャンセル');
      return parts.filter(Boolean).join(' ');
    }
    const draftFor = d => S.eventsOn(d).map(evLine).join('\n');

    /* ---- テキスト整形 ---- */
    function reportText(r){
      const s = Store.settings();
      const L = [];
      L.push(`件名: 営業日報 ${UI.fmtDate(r.date,{year:true,dow:false})} ${s.userName||''}`.trim());
      L.push('');
      if (s.company || s.userName) L.push([s.company, s.userName].filter(Boolean).join('  '));
      L.push(`日付: ${UI.fmtDateLong(r.date)}`);
      L.push(`天気: ${r.weather||'-'}`);
      L.push(`状態: ${STATUS[r.status]||'下書き'}`);
      L.push('');
      L.push('■訪問・活動内容'); L.push(r.body||'(なし)'); L.push('');
      L.push('■成果・商談結果'); L.push(r.results||'(なし)'); L.push('');
      L.push('■課題・相談事項'); L.push(r.issues||'(なし)'); L.push('');
      L.push('■明日の予定'); L.push(r.tomorrow||'(なし)');
      return L.join('\n');
    }

    /* ---- 印刷用帳票 ---- */
    function sheet(r){
      const s = Store.settings();
      const pre = (t, min='4em') => h('div',{style:{whiteSpace:'pre-wrap', minHeight:min}}, t||'');
      const th = t => h('th',null,t);
      return h('div',{class:'sheet c4'},
        h('div',{class:'head'},
          h('div',null, h('div',null, s.company||''), h('div',{class:'small'}, `作成日 ${UI.fmtDate(UI.today(),{year:true})}`)),
          h('div',{class:'sign', style:{marginTop:0}}, h('div',null,'部長'), h('div',null,'課長'), h('div',null,'担当'))
        ),
        h('h1',null,'営 業 日 報'),
        h('table',null, h('tbody',null,
          h('tr',null, th('日付'), h('td',null, UI.fmtDateLong(r.date)), th('天気'), h('td',null, r.weather||'')),
          h('tr',null, th('氏名'), h('td',null, s.userName||''), th('状態'), h('td',null, STATUS[r.status]||'下書き')),
          h('tr',null, th('訪問・活動内容'), h('td',{colspan:3}, pre(r.body,'8em'))),
          h('tr',null, th('成果・商談結果'), h('td',{colspan:3}, pre(r.results))),
          h('tr',null, th('課題・相談事項'), h('td',{colspan:3}, pre(r.issues))),
          h('tr',null, th('明日の予定'), h('td',{colspan:3}, pre(r.tomorrow)))
        ))
      );
    }

    /* ---- 集計 ---- */
    function weekRange(d){
      const dt = UI.parseDate(d); const dow = (dt.getDay()+6)%7; // 月曜起点
      const mon = UI.addDays(d, -dow); return [mon, UI.addDays(mon,6)];
    }
    function statsEl(){
      const [ws, we] = weekRange(date);
      const ms = date.slice(0,7);
      const evs = Store.list('events');
      const reps = Store.list('reports');
      const weekVisits = evs.filter(e=> e.type==='visit' && e.status!=='cancelled' && e.date>=ws && e.date<=we).length;
      const weekDone = evs.filter(e=> e.type==='visit' && e.status==='done' && e.date>=ws && e.date<=we).length;
      const monthReports = reps.filter(r=> (r.date||'').startsWith(ms)).length;
      const drafts = reps.filter(r=> r.status!=='submitted').length;
      const stat = (v,l)=>h('div',{class:'stat'}, h('div',{class:'v'}, v), h('div',{class:'l'}, l));
      return h('div',{class:'stats'},
        stat(weekVisits, `今週の訪問件数 (${UI.fmtDate(ws,{dow:false})}〜${UI.fmtDate(we,{dow:false})})`),
        stat(weekDone, '今週の訪問済み'),
        stat(monthReports, `${Number(ms.slice(5))}月の日報数`),
        stat(drafts, '未提出の日報')
      );
    }

    /* ---- 過去の日報一覧 ---- */
    function historyEl(){
      const rows = Store.list('reports').sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,30);
      const list = h('div',{class:'list'});
      if (!rows.length) list.appendChild(UI.empty('まだ日報がありません'));
      for (const r of rows){
        const first = (r.body||'').split('\n').find(Boolean) || '(本文なし)';
        list.appendChild(h('div',{class:'item'+(r.date===date?' active':''), style: r.date===date?{borderColor:'var(--primary)'}:null, onClick:()=>App.go(`reports?date=${r.date}`)},
          h('div',{class:'main'},
            h('div',{class:'title'}, UI.fmtDate(r.date,{year:true}), ' ', UI.badge(STATUS[r.status]||'下書き', r.status||'draft')),
            h('div',{class:'sub'}, r.weather?`${r.weather} · `:'', first)),
          h('div',{class:'side'}, UI.fmtDateTime(r.updatedAt))
        ));
      }
      return list;
    }

    /* ---- 日付ナビ ---- */
    function dateNav(){
      const inp = input({type:'date', value:date, style:{minWidth:'150px', width:'auto'}, onChange:()=>{ if(inp.value) App.go(`reports?date=${inp.value}`); }});
      return h('div',{class:'row'},
        h('button',{class:'btn sm', onClick:()=>App.go(`reports?date=${UI.addDays(date,-1)}`)}, '◀ 前日'),
        inp,
        h('button',{class:'btn sm', onClick:()=>App.go(`reports?date=${UI.addDays(date,1)}`)}, '翌日 ▶'),
        date!==UI.today() ? h('button',{class:'btn sm', onClick:()=>App.go(`reports?date=${UI.today()}`)}, '今日') : null
      );
    }

    /* ---- 本体描画 ---- */
    function draw(){
      UI.clear(root);
      const r = findReport(date);
      const evs = S.eventsOn(date);
      root.append(
        h('div',{class:'page-head'}, h('h1',null,'📝 営業日報'), h('div',{class:'spacer'}), dateNav()),
        h('h2',{class:'muted', style:{fontSize:'1rem'}}, UI.fmtDateLong(date), ' ', r ? UI.badge(STATUS[r.status]||'下書き', r.status||'draft') : UI.badge('未作成','other'))
      );

      if (!r){
        root.appendChild(h('div',{class:'card'},
          h('h2',null,'この日の日報はまだありません'),
          h('p',{class:'small muted'}, evs.length ? `この日の予定 ${evs.length}件から訪問・活動内容の下書きを作成します。` : 'この日の予定はありません。空の日報を作成します。'),
          evs.length ? h('pre',{class:'plain small'}, draftFor(date)) : null,
          h('div',{class:'row mt'},
            h('button',{class:'btn primary', onClick:()=>{
              Store.save('reports', { date, weather:'', body: draftFor(date), results:'', issues:'', tomorrow: draftFor(UI.addDays(date,1)), attachmentIds:[], status:'draft' });
              toast('下書きを作成しました'); draw();
            }}, '✏️ 下書きを作る'),
            h('a',{class:'btn', href:`#/schedule?date=${date}`}, '📅 予定を見る')
          )
        ));
      } else {
        let bodyTa, tomorrowTa;
        const form = h('div',{class:'form'},
          h('div',{class:'f-row'},
            field('天気', select([['','(未選択)'], ...S.weatherOptions], r.weather||'', {name:'weather'})),
            field('状態', select([['draft','下書き'],['submitted','提出済']], r.status||'draft', {name:'status'}))
          ),
          field('訪問・活動内容', bodyTa = textarea({name:'body', value:r.body||'', rows:8, placeholder:'HH:MM-HH:MM 訪問 会社名/氏名(住所) メモ'})),
          h('div',{class:'row'},
            h('button',{class:'btn sm', onClick: async()=>{
              const d = draftFor(date);
              if (!d){ toast('この日の予定がありません', {error:true}); return; }
              if (bodyTa.value.trim() && !(await UI.confirm('訪問・活動内容を予定から再生成して上書きします。現在の内容は失われます。', {ok:'上書きする'}))) return;
              bodyTa.value = d; toast('予定から再生成しました');
            }}, '🔄 予定から再生成'),
            h('span',{class:'small muted'}, `この日の予定: ${evs.length}件`)
          ),
          field('成果・商談結果', textarea({name:'results', value:r.results||'', placeholder:'受注・見積提出・次回アポ など'})),
          field('課題・相談事項', textarea({name:'issues', value:r.issues||'', placeholder:'競合状況、価格交渉、社内への相談 など'})),
          field('明日の予定', tomorrowTa = textarea({name:'tomorrow', value:r.tomorrow||'', rows:4})),
          h('div',{class:'row'},
            h('button',{class:'btn sm', onClick: async()=>{
              const d = draftFor(UI.addDays(date,1));
              if (!d){ toast('翌日の予定がありません', {error:true}); return; }
              if (tomorrowTa.value.trim() && !(await UI.confirm('明日の予定を翌日の予定から生成して上書きします。', {ok:'上書きする'}))) return;
              tomorrowTa.value = d; toast('翌日の予定から生成しました');
            }}, '📅 翌日の予定から生成')
          )
        );
        const current = ()=> Object.assign({}, r, UI.readForm(form));
        const save = (extra)=>{ const v = Object.assign(current(), extra||{}); Store.save('reports', v); return v; };

        root.appendChild(h('div',{class:'card'},
          h('h2',null,'日報を編集'),
          form,
          h('div',{class:'row mt'},
            h('button',{class:'btn primary', onClick:()=>{ save(); toast('保存しました'); draw(); }}, '💾 保存'),
            r.status!=='submitted'
              ? h('button',{class:'btn', onClick:()=>{ save({status:'submitted'}); toast('提出済みにしました'); draw(); }}, '✅ 提出済みにする')
              : h('button',{class:'btn', onClick:()=>{ save({status:'draft'}); toast('下書きに戻しました'); draw(); }}, '↩️ 下書きに戻す'),
            h('div',{class:'spacer', style:{flex:1}}),
            h('button',{class:'btn danger sm', onClick: async()=>{ if(await UI.confirm('この日報を削除しますか?(添付も削除されます)')){ for (const f of await Files.list('report', r.id)) await Files.remove(f.id); Store.remove('reports', r.id); toast('削除しました'); draw(); } }}, '削除')
          )
        ));

        root.appendChild(h('div',{class:'card'},
          h('h2',null,'出力'),
          h('p',{class:'small muted'}, '編集中の内容(未保存分も含む)をそのまま出力します。'),
          h('div',{class:'row'},
            h('button',{class:'btn', onClick:()=>UI.copy(reportText(current()))}, '📋 テキストをコピー'),
            h('button',{class:'btn', onClick:()=>UI.printElement(sheet(current()), `営業日報 ${UI.fmtDate(date,{year:true,dow:false})}`)}, '🖨️ 印刷/PDF'),
            h('button',{class:'btn', onClick:()=>{ UI.download(`営業日報_${date}.txt`, reportText(current()), 'text/plain'); toast('書き出しました'); }}, '⬇️ テキスト保存')
          )
        ));

        root.appendChild(h('div',{class:'card'}, h('h2',null,'添付(名刺・資料・写真など)'), S.attachments('report', r.id)));
      }

      root.appendChild(h('div',{class:'card'}, h('h2',null,'集計'), statsEl()));
      root.appendChild(h('div',{class:'card'}, h('h2',null,'過去の日報'), h('p',{class:'small muted'},'最新30件。クリックでその日の日報を開きます。'), historyEl()));
    }

    draw();
  }
});
