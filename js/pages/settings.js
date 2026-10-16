/* 設定・バックアップ */
(function(){
    function seedDemo(){
      const today = UI.today();
      const cs = [
        {company:'東都トラベル株式会社', department:'団体営業部', name:'佐藤 健一', title:'部長', phone:'03-1234-5678', mobile:'090-1111-2222', email:'sato@example.com', zip:'100-0005', address:'東京都千代田区丸の内1-9-1', lat:35.6812, lng:139.7671, tags:['旅行会社','重点'], memo:'秋の団体ツアー検討中'},
        {company:'株式会社みなと観光', department:'営業課', name:'鈴木 美咲', title:'課長', phone:'045-222-3333', mobile:'080-3333-4444', email:'suzuki@example.com', zip:'220-0011', address:'神奈川県横浜市西区高島2-16-1', lat:35.4657, lng:139.6224, tags:['旅行会社'], memo:''},
        {company:'大宮商事株式会社', department:'総務部', name:'高橋 大輔', title:'総務部長', phone:'048-555-6666', mobile:'', email:'takahashi@example.com', zip:'330-0853', address:'埼玉県さいたま市大宮区錦町630', lat:35.9064, lng:139.6239, tags:['法人','社員旅行'], memo:'毎年11月に社員旅行(約40名)'},
        {company:'千葉県教職員互助会', department:'事業課', name:'田中 さくら', title:'主任', phone:'043-777-8888', mobile:'', email:'tanaka@example.com', zip:'260-0013', address:'千葉県千葉市中央区中央4-5-1', lat:35.6073, lng:140.1233, tags:['団体','研修'], memo:''},
        {company:'シニアクラブ川崎', department:'', name:'渡辺 正夫', title:'会長', phone:'044-999-0000', mobile:'090-5555-6666', email:'', zip:'210-0007', address:'神奈川県川崎市川崎区駅前本町26-1', lat:35.5318, lng:139.6966, tags:['団体'], memo:'湯治・長期滞在に興味'}
      ].map(c=>Store.save('customers', c));
      const ev = [
        {date:today, start:'10:00', end:'11:00', title:'東都トラベル 秋ツアー提案', type:'visit', customerId:cs[0].id, address:cs[0].address, lat:cs[0].lat, lng:cs[0].lng, memo:'パンフレット持参', status:'planned'},
        {date:today, start:'13:30', end:'14:30', title:'大宮商事 社員旅行ヒアリング', type:'visit', customerId:cs[2].id, address:cs[2].address, lat:cs[2].lat, lng:cs[2].lng, memo:'', status:'planned'},
        {date:today, start:'16:00', end:'17:00', title:'みなと観光 定期訪問', type:'visit', customerId:cs[1].id, address:cs[1].address, lat:cs[1].lat, lng:cs[1].lng, memo:'', status:'planned'},
        {date:UI.addDays(today,1), start:'11:00', end:'12:00', title:'千葉県教職員互助会 研修プラン打合せ', type:'meeting', customerId:cs[3].id, address:cs[3].address, lat:cs[3].lat, lng:cs[3].lng, memo:'', status:'planned'},
        {date:UI.addDays(today,1), start:'15:00', end:'16:00', title:'シニアクラブ川崎 挨拶', type:'visit', customerId:cs[4].id, address:cs[4].address, lat:cs[4].lat, lng:cs[4].lng, memo:'', status:'planned'}
      ];
      ev.forEach(e=>Store.save('events', e));
      Store.save('hotels', {checkIn:UI.addDays(today,1), checkOut:UI.addDays(today,2), area:'千葉駅', hotelName:'サンプルビジネスホテル千葉', price:7800, confirmationNo:'RSV-0001', site:'楽天トラベル', memo:'', status:'booked'});
      Store.save('groups', {groupName:'大宮商事 社員旅行', agency:'東都トラベル株式会社', agencyContact:'佐藤 健一', agencyTel:'03-1234-5678', arrival:UI.addDays(today,30), departure:UI.addDays(today,31), nights:1,
        pax:{adult:40, child:0, infant:0}, rooms:[{type:'和室', count:10, capacity:4}], meals:{dinner:'会席', breakfast:'バイキング', lunch:'なし'},
        banquet:{room:'大広間', start:'18:30', end:'20:30', style:'宴会'}, arrivalTime:'15:30', departureTime:'10:00', buses:1, rate:18000, payment:'請求書', notes:'アレルギー対応2名(えび・かに)', status:'lead'});
      if (!Store.settings().homeAddress) Store.saveSettings({userName:'山田 太郎', company:'サンプル温泉旅館', homeAddress:'東京都新宿区西新宿2-8-1', homeLat:35.6896, homeLng:139.6921});
    }

App.register('settings', {
  title:'設定', icon:'⚙️', tab:false,

  render(root){
    const { h, field, input, select, toast } = UI;
    const s = Store.settings();
    const form = h('div',{class:'form'},
      h('div',{class:'f-row'},
        field('氏名', input({name:'userName', value:s.userName, placeholder:'例: 山田 太郎'})),
        field('会社・施設名', input({name:'company', value:s.company, placeholder:'例: 山水荘'}))
      ),
      field('拠点(出発地)の住所', input({name:'homeAddress', value:s.homeAddress, placeholder:'ルート作成の出発地になります'}), {hint:'保存時に座標を自動取得します'}),
      h('div',{class:'f-row c3'},
        field('業務開始', input({type:'time', name:'workStart', value:s.workStart})),
        field('業務終了', input({type:'time', name:'workEnd', value:s.workEnd})),
        field('1訪問の標準滞在(分)', input({type:'number', name:'defaultStayMin', value:s.defaultStayMin, min:5, step:5}))
      ),
      field('表示テーマ', select([['auto','端末に合わせる'],['light','ライト'],['dark','ダーク']], s.theme, {name:'theme'}))
    );
    const saveBtn = h('button',{class:'btn primary', onClick: async()=>{
      const v = UI.readForm(form);
      saveBtn.disabled = true;
      try {
        if (v.homeAddress && v.homeAddress !== s.homeAddress){
          let g = null;
          try { g = await Geo.geocode(v.homeAddress); }
          catch(e){ toast('住所検索に接続できませんでした(設定は保存します)。通信できる環境で再保存すると座標を取得します', {error:true}); }
          if (g){ v.homeLat = g.lat; v.homeLng = g.lng; }
          else { if (g===null && navigator.onLine) toast('拠点住所の座標が見つかりませんでした。住所を見直してください', {error:true}); v.homeLat=null; v.homeLng=null; }
        } else if (!v.homeAddress){ v.homeLat=null; v.homeLng=null; }
        else { v.homeLat = s.homeLat; v.homeLng = s.homeLng; }
        Store.saveSettings(v);
        toast('保存しました');
      } catch(e){ toast(e.message, {error:true}); }
      finally { saveBtn.disabled = false; }
    }}, '保存');

    const fileInp = h('input',{type:'file', accept:'application/json', style:{display:'none'}, onChange: async()=>{
      const f = fileInp.files[0]; if(!f) return;
      try {
        const json = JSON.parse(await f.text());
        const n = Object.values(json.data||{}).reduce((a,b)=>a+(b?.length||0),0);
        const ok = await UI.confirm(`${n}件のデータを取り込みます(同じIDは上書き、他は追加)。実行しますか?`, {ok:'取り込む', danger:false});
        if (!ok) return;
        Store.importAll(json, {merge:true});
        toast('取り込みました'); App.route();
      } catch(e){ toast('取り込みに失敗: '+e.message, {error:true}); }
      fileInp.value='';
    }});

    const counts = Store.COLS.map(c=>`${({customers:'顧客',events:'予定',routes:'ルート',hotels:'ホテル',cars:'レンタカー',reports:'日報',groups:'団体表'})[c]}: ${Store.list(c).length}`).join(' / ');
    root.append(
      h('div',{class:'page-head'}, h('h1',null,'⚙️ 設定')),
      h('div',{class:'card'}, h('h2',null,'基本設定'), form, h('div',{class:'row mt'}, saveBtn)),
      h('div',{class:'card'}, h('h2',null,'バックアップ'),
        h('p',{class:'small muted'},'データはこのブラウザ内に保存されています。別の端末で使う場合や念のための保存には、JSONを書き出して保管してください(添付ファイルは含まれません)。'),
        h('p',{class:'small muted'}, counts),
        h('div',{class:'row'},
          h('button',{class:'btn', onClick:()=>{ UI.download(`sales-backup-${UI.today()}.json`, JSON.stringify(Store.exportAll(), null, 2)); toast('書き出しました'); }}, '⬇️ JSONを書き出す'),
          h('button',{class:'btn', onClick:()=>fileInp.click()}, '⬆️ JSONを取り込む'), fileInp,
          h('button',{class:'btn', onClick: async()=>{ if(await UI.confirm('動作確認用のサンプル(顧客5件・予定5件・ホテル1件・団体表1件)を追加します。', {ok:'追加する', danger:false})){ seedDemo(); toast('サンプルを追加しました'); App.route(); } }}, '🧪 サンプルデータを入れる'),
          h('button',{class:'btn danger', onClick: async()=>{ if(await UI.confirm('すべてのデータ(添付以外)を削除します。元に戻せません。')){ Store.clearAll(); toast('削除しました'); App.route(); } }}, '全データ削除')
        )
      ),
      h('div',{class:'card'}, h('h2',null,'このサイトについて'),
        h('ul',{class:'small muted', style:{margin:0,paddingLeft:'1.2em'}},
          h('li',null,'地図: OpenStreetMap / Leaflet、住所検索: Nominatim、経路: OSRM(いずれも無料の公開サービスのため、混雑時は取得に失敗することがあります)'),
          h('li',null,'ホテル・レンタカーの実際の予約は各社サイトで行います。本サイトは検索条件付きでサイトを開き、予約結果を記録します。'),
          h('li',null,'名刺OCRは Tesseract.js を使用。精度には限りがあるため、読み取り後に必ず内容を確認してください。')
        ))
    );
  }
});
})();
