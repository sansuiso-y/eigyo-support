/* 企業分析: 取引先の規模(年商・社員数・設立)、事業内容、客層・ターゲット、日本との関わり、営業の提案ポイントを
   AI(Google 検索つき)で調べて一覧にする。結果は Store 'companyInfo'(サーバー同期で全員共有)に会社ごとに1件。
   対象 = 顧客・名刺 + 営業計画の訪問先リスト(会社名の表記ゆれは normKey でまとめる) */
(function(){
  const { h, toast } = UI;
  const SCALES = ['大手','中堅','中小','零細','不明'];
  const SCALE_CLS = { '大手':'visit', '中堅':'meeting', '中小':'move', '零細':'other', '不明':'other' };
  const CONF = { high:'確度 高', medium:'確度 中', low:'確度 低' };
  // 会社名の比較用: 法人格(㈜・(주)・株式会社・주식회사)・空白・記号を除いて小文字に
  const normKey = s => String(s||'').replace(/㈜|\(주\)|（주）|주식회사|株式会社|有限会社|\(株\)|（株）|㈱|co\.?,?\s*ltd\.?|inc\.?/gi,'').replace(/[\s・·.,()（）\-]/g,'').toLowerCase();
  const BATCH = 3;   // 1回のAI呼び出しで調べる社数(/api/analyze の上限)

  App.register('analysis', {
    title:'企業分析', icon:'🔎', tab:false,
    render(root, {params}){
      let filter = '', query = '', running = false;
      const selected = new Set();

      /* 対象の会社一覧(顧客・名刺 + 営業計画の訪問先) */
      function targets(){
        const map = new Map();
        const add = (o)=>{ const k = normKey(o.company); if (!k) return; const cur = map.get(k); if (!cur) map.set(k, Object.assign({ key:k }, o)); else { for (const f of ['name','title','address','category','website','customerId']) if (!cur[f] && o[f]) cur[f] = o[f]; cur.inPlan = cur.inPlan || o.inPlan; } };
        for (const c of Store.list('customers')) add({ company:c.company, name:c.name, title:c.title, address:c.address, category:(c.tags||[])[0]||'', website:c.website, customerId:c.id });
        const draft = Store.list('plans')[0];
        for (const r of ((draft && draft.rows) || [])) add({ company:r.company, name:r.name, title:r.title, address:r.address, category:r.category, customerId:r.customerId, inPlan:true });
        return [...map.values()];
      }
      const infoOf = k => Store.list('companyInfo').find(x=>x.key===k) || null;

      const listEl = h('div');
      const progress = h('span',{class:'small muted'});
      const search = h('input',{type:'search', placeholder:'会社名で検索', onInput:(e)=>{ query = e.target.value.trim(); render(); }});

      async function runAnalyze(list){
        if (running) return; if (!list.length){ toast('分析する会社を選んでください', {error:true}); return; }
        if (!(await UI.confirm(`${list.length}社をAIで分析します(Web検索つき、1社あたり数円・10〜30秒)。よろしいですか?`, {ok:'分析する', danger:false}))) return;
        running = true; render();
        let done = 0, failed = 0;
        const me = Store.settings().company ? `日本の温泉旅館・ホテル「${Store.settings().company}」` : '日本(福島)の温泉旅館・ホテル';
        for (let i = 0; i < list.length; i += BATCH){
          const part = list.slice(i, i + BATCH);
          progress.textContent = `分析中… ${done}/${list.length}社(${part.map(t=>t.company).join('、')})`;
          try {
            const res = await fetch('api/analyze', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ me, companies: part.map(t=>({ key:t.key, company:t.company, name:t.name, title:t.title, address:t.address, category:t.category, website:t.website })) }) });
            let j = null; try { j = await res.json(); } catch(e){}
            if (!res.ok) throw new Error((j && j.error) || `失敗 (${res.status})`);
            for (const t of part){
              const r = (j.results || []).find(x=>x.key === t.key);
              if (!r){ failed++; continue; }
              const cur = infoOf(t.key);
              Store.save('companyInfo', Object.assign(cur ? { id:cur.id, createdAt:cur.createdAt } : {}, r, { key:t.key, company:t.company, customerId:t.customerId || '', analyzedAt: new Date().toISOString(), analyzedBy: Store.settings().userName || '' }));
              done++;
            }
          } catch(e){ console.error(e); failed += part.length; toast(`分析に失敗: ${e.message}`, {error:true, ms:6000}); }
          render();
        }
        running = false; progress.textContent = '';
        toast(`${done}社を分析しました${failed ? `(${failed}社は失敗・結果なし)` : ''}`, {ms:5000});
        render();
      }

      function detail(t){
        const x = infoOf(t.key); if (!x){ runAnalyze([t]); return; }
        const row = (label, v) => v ? h('div',{style:{marginBottom:'8px'}}, h('div',{class:'small muted'}, label), h('div',{style:{whiteSpace:'pre-wrap'}}, v)) : null;
        const cust = t.customerId && Store.get('customers', t.customerId);
        UI.modal({ title: t.company, wide:true, body: h('div', null,
          h('div',{class:'row', style:{gap:'6px', marginBottom:'10px', flexWrap:'wrap'}}, h('span',{class:'badge '+(SCALE_CLS[x.scale]||'other')}, x.scale), h('span',{class:'badge other'}, CONF[x.confidence]||''), x.officialName && x.officialName !== t.company ? h('span',{class:'small muted'}, x.officialName) : null, cust ? h('a',{class:'btn sm', href:`#/customers?id=${cust.id}`}, '名刺を開く') : null),
          h('div',{class:'f-row c3'}, row('年商・売上', x.revenue), row('社員数', x.employees), row('設立', x.founded)),
          h('div',{class:'f-row'}, row('代表者', x.ceo), row('本社', x.hq)),
          row('主な事業', x.business), row('主力の商品・サービス', x.products), row('客層・ターゲット', x.customers), row('日本・福島との関わり', x.japan),
          x.salesPoints ? h('div',{class:'notice', style:{marginBottom:'8px'}}, h('div',{class:'small muted'}, '💡 営業の提案ポイント'), h('div',{style:{whiteSpace:'pre-wrap'}}, x.salesPoints)) : null,
          row('注意点', x.note),
          (x.sources||[]).length ? h('div',null, h('div',{class:'small muted'}, '根拠'), h('ul',{class:'small', style:{margin:'4px 0 0', paddingLeft:'18px'}}, x.sources.map(s=>h('li',null, /^https?:\/\//.test(s) ? h('a',{href:s, target:'_blank', rel:'noopener'}, s) : s)))) : null,
          h('p',{class:'small muted mt'}, `AIがWeb検索で調べた結果です。数値は出典で確認してください。分析日: ${UI.fmtDateTime(x.analyzedAt)}${x.analyzedBy ? ' ' + x.analyzedBy : ''}`)),
          actions:[ {label:'閉じる', onClick:()=>{}}, {label:'分析し直す', onClick:()=>{ setTimeout(()=>runAnalyze([t]), 0); }} ] });
      }

      function render(){
        UI.clear(listEl);
        const all = targets();
        const counts = { '未分析':0 }; SCALES.forEach(s=>counts[s]=0);
        all.forEach(t=>{ const x = infoOf(t.key); counts[x ? x.scale : '未分析']++; });
        const shown = all.filter(t=>{ const x = infoOf(t.key); if (filter === '計画' && !t.inPlan) return false; if (filter && filter !== '計画' && (x ? x.scale : '未分析') !== filter) return false; if (query && !(t.company||'').toLowerCase().includes(query.toLowerCase()) && !(t.name||'').toLowerCase().includes(query.toLowerCase())) return false; return true; })
          .sort((a,b)=>{ const order = s => s ? SCALES.indexOf(s.scale) : 9; return order(infoOf(a.key)) - order(infoOf(b.key)) || String(a.company).localeCompare(String(b.company)); });
        const chip = (k, label) => h('button',{class:'chip'+(filter===k?' active':''), onClick:()=>{ filter = k; render(); }}, label);
        listEl.append(
          h('div',{class:'chip-row'}, chip('', `すべて (${all.length})`), chip('計画', `営業計画の訪問先 (${all.filter(t=>t.inPlan).length})`), ...SCALES.filter(s=>counts[s]).map(s=>chip(s, `${s} (${counts[s]})`)), counts['未分析'] ? chip('未分析', `未分析 (${counts['未分析']})`) : null),
          h('div',{class:'row mt', style:{alignItems:'center'}},
            h('button',{class:'btn primary', disabled: running || !selected.size, onClick:()=>runAnalyze(all.filter(t=>selected.has(t.key)))}, `🔎 選択した${selected.size||''}社を分析`),
            h('button',{class:'btn', disabled: running || !shown.some(t=>!infoOf(t.key)), onClick:()=>runAnalyze(shown.filter(t=>!infoOf(t.key)))}, '表示中の未分析をまとめて分析'),
            progress));
        if (!all.length){ listEl.append(UI.empty('分析する会社がありません。「顧客・名刺」に名刺を登録するか、「営業計画」に訪問先を取り込んでください。')); return; }
        const allChk = h('input',{type:'checkbox', checked: shown.length && shown.every(t=>selected.has(t.key)), onChange:(e)=>{ shown.forEach(t=>{ if (e.target.checked) selected.add(t.key); else selected.delete(t.key); }); render(); }});
        const tbl = h('table',{class:'tbl'}, h('thead',null, h('tr',null, h('th',null, allChk), ...['会社','規模','年商・売上','社員数','設立','客層・ターゲット',''].map(x=>h('th',null,x)))));
        const tb = h('tbody');
        for (const t of shown){
          const x = infoOf(t.key);
          tb.appendChild(h('tr',null,
            h('td',null, h('input',{type:'checkbox', checked: selected.has(t.key), onChange:(e)=>{ if (e.target.checked) selected.add(t.key); else selected.delete(t.key); render(); }})),
            h('td',null, h('div',{style:{fontWeight:600}}, t.company), h('div',{class:'small muted'}, [t.name, t.category].filter(Boolean).join(' / '))),
            h('td',{class:'nowrap'}, x ? h('span',{class:'badge '+(SCALE_CLS[x.scale]||'other'), title: CONF[x.confidence]||''}, x.scale) : h('span',{class:'small muted'}, '未分析')),
            h('td',{class:'small'}, x ? (x.revenue || '不明') : ''),
            h('td',{class:'small nowrap'}, x ? (x.employees || '不明') : ''),
            h('td',{class:'small nowrap'}, x ? (x.founded || '不明') : ''),
            h('td',{class:'small', style:{minWidth:'220px'}}, x ? (x.customers || '') : ''),
            h('td',{class:'nowrap'}, h('button',{class:'btn sm', disabled: running, onClick:()=>detail(t)}, x ? '詳細' : '分析'))));
        }
        tbl.appendChild(tb);
        listEl.append(h('div',{class:'tbl-wrap mt'}, tbl));
      }

      root.append(
        h('div',{class:'page-head'}, h('h1',null,'🔎 企業分析'), h('div',{class:'spacer'}), h('span',{class:'small muted'}, '規模・年商・社員数・客層・提案ポイント')),
        h('div',{class:'card'},
          h('p',{class:'small muted'}, '「顧客・名刺」と「営業計画」の訪問先の会社を、AIがWeb検索で調べて分析します(1社あたり数円)。結果は全員で共有されます。小さな会社は年商や社員数が公開されていないことが多く、その場合は「不明」と表示します。'),
          h('div',{class:'row'}, search),
          h('div',{class:'mt'}, listEl)));
      render();
      const off = Store.on('companyInfo', ()=>{ if (!running) render(); });
      if (params.q){ search.value = params.q; query = params.q; render(); }
      if (params.f){ filter = params.f; render(); }
      return { destroy: ()=>off() };
    }
  });
})();
