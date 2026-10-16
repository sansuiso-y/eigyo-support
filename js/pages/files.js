/* 資料(添付ファイル)一覧 */
App.register('files', {
  title:'資料', icon:'📎', tab:false,
  render(root){
    const { h, toast } = UI;
    const KIND = { customer:'顧客', event:'予定', report:'日報', group:'団体表', hotel:'ホテル', car:'レンタカー', general:'共通資料' };
    const linkTarget = (f)=>{
      switch(f.linkedKind){
        case 'customer': { const c = Store.get('customers', f.linkedId); return c ? {label: App.Shared.customerLabel(c), href:`#/customers?id=${f.linkedId}`} : null; }
        case 'event': { const e = Store.get('events', f.linkedId); return e ? {label:`${UI.fmtDate(e.date)} ${e.title||''}`, href:`#/schedule?date=${e.date}`} : null; }
        case 'report': { const r = Store.get('reports', f.linkedId); return r ? {label:`日報 ${UI.fmtDate(r.date)}`, href:`#/reports?date=${r.date}`} : null; }
        case 'group': { const g = Store.get('groups', f.linkedId); return g ? {label:g.groupName||'団体表', href:`#/groups?id=${f.linkedId}`} : null; }
        default: return null;
      }
    };
    const search = h('input',{type:'search', placeholder:'ファイル名で検索'});
    let filter = '';
    const chips = h('div',{class:'chip-row'});
    const list = h('div',{class:'list'});
    async function refresh(){
      const all = await Files.list();
      UI.clear(chips);
      const kinds = ['', ...new Set(all.map(f=>f.linkedKind||'general'))];
      kinds.forEach(k=> chips.appendChild(h('button',{class:'chip'+(filter===k?' active':''), onClick:()=>{filter=k; refresh();}}, k?KIND[k]||k:'すべて')));
      const q = search.value.trim().toLowerCase();
      const rows = all.filter(f=> (!filter || (f.linkedKind||'general')===filter) && (!q || f.name.toLowerCase().includes(q)));
      UI.clear(list);
      if (!rows.length){ list.appendChild(UI.empty('資料がありません。下の欄から追加するか、顧客・予定・日報の画面で添付できます。')); return; }
      for (const f of rows){
        const t = linkTarget(f);
        list.appendChild(h('div',{class:'file-row'},
          h('span',null, f.type.startsWith('image/')?'🖼️':f.type.includes('pdf')?'📄':'📎'),
          h('div',{class:'nm'},
            h('a',{href:'#', onClick: async(e)=>{ e.preventDefault(); window.open(await Files.url(f.id),'_blank'); }}, f.name),
            h('div',{class:'small muted'}, UI.fmtBytes(f.size), ' · ', UI.fmtDateTime(f.createdAt), ' · ', t ? h('a',{href:t.href}, `${KIND[f.linkedKind]||''}: ${t.label}`) : (KIND[f.linkedKind]||'共通資料'))
          ),
          h('button',{class:'btn sm', onClick: async()=>{ const u = await Files.url(f.id); const a = h('a',{href:u, download:f.name}); document.body.appendChild(a); a.click(); a.remove(); }}, '保存'),
          h('button',{class:'btn sm danger', onClick: async()=>{ if(await UI.confirm(`「${f.name}」を削除しますか?`)){ await Files.remove(f.id); toast('削除しました'); refresh(); } }}, '削除')
        ));
      }
    }
    search.addEventListener('input', UI.debounce(refresh, 200));
    root.append(
      h('div',{class:'page-head'}, h('h1',null,'📎 資料'), h('div',{class:'spacer'}), h('div',{class:'search', style:{minWidth:'220px'}}, search)),
      h('div',{class:'card'}, h('h2',null,'共通資料を追加'), h('p',{class:'small muted'},'パンフレット・料金表・提案書など、訪問先に関係なく使う資料はここに置きます。'),
        App.Shared.attachments('general','', {editable:true, onChange:refresh})),
      h('div',{class:'card'}, chips, h('div',{class:'mt'}, list))
    );
    refresh();
  }
});
