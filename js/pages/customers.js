/* 顧客・名刺管理(一覧/検索/タグ、名刺画像、OCR、訪問履歴、CSV) */
(function(){
  const tagsOf = c => Array.isArray(c?.tags) ? c.tags : (typeof c?.tags==='string' ? c.tags.split(/[,、]/).map(x=>x.trim()).filter(Boolean) : []);
  const TESSERACT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';
  const OCR_STATUS = { 'loading tesseract core':'OCRエンジン読込中', 'initializing tesseract':'OCR初期化中', 'loading language traineddata':'言語データ読込中', 'loaded language traineddata':'言語データ読込完了', 'initializing api':'準備中', 'recognizing text':'文字認識中' };
  const STATUS_LABEL = { planned:'予定', done:'完了', cancelled:'中止' };
  const FIELD_LABEL = { company:'会社名', department:'部署', name:'氏名', title:'役職', phone:'電話', mobile:'携帯', email:'メール', zip:'郵便番号', address:'住所' };
  const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
  const PREF_RE = new RegExp('(' + PREFS.join('|') + ')');
  const COMPANY_RE = /株式会社|有限会社|合同会社|合資会社|\(株\)|\(有\)|Co\.,?\s*Ltd|Inc\b|Corp\b|Corporation|K\.K\.|LLC|Ltd\b/i;
  const COMPANY_LOOSE_RE = /旅行|観光|トラベル|ツーリスト|ツアー|ホテル|旅館|商事|銀行|協会|組合|学園|大学|病院|商会|運輸|交通|バス/;
  const TITLE_WORDS = '部長|課長|係長|主任|担当|マネージャー|マネジャー|取締役|社長|代表|役員|専務|常務|所長|店長|支店長|支社長|室長|センター長|リーダー|チーフ|主査|主事|参事|顧問|相談役|会長|理事|局長|次長|Manager|Director|President|CEO|Chief|Officer|Executive';
  const TITLE_RE = new RegExp(TITLE_WORDS, 'i');
  /* 「部長鈴木一郎」のように役職と氏名が連結した行を分ける */
  const TITLE_NAME_RE = new RegExp('^(.*?(?:' + TITLE_WORDS + '))[ 　]*([\\u4e00-\\u9faf々〆ヶ]{1,4}[ 　]?[\\u4e00-\\u9faf\\u3040-\\u309f々〆ヶ]{1,4})$');
  const DEPT_RE = /(部|課|室|グループ|センター|事業部|支店|支社|営業所|本部|チーム|Division|Department|Dept|Group|Team|Section)$/i;
  const NAME_RE = /^[一-龯々〆ヶ]{1,4}[ 　]?[一-龯぀-ゟ々〆ヶ]{1,4}$/;
  const PHONE_RE = /0\d{1,4}[- ]\d{1,4}[- ]\d{3,4}/g;

  /* ---------- OCR: 読み込み ---------- */
  let tessPromise = null;
  function loadTesseract(){
    if (window.Tesseract) return Promise.resolve();
    if (tessPromise) return tessPromise;
    tessPromise = new Promise((res, rej)=>{
      const s = document.createElement('script');
      s.src = TESSERACT_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = ()=> window.Tesseract ? res() : rej(new Error('Tesseract.js の初期化に失敗しました'));
      s.onerror = ()=>{ tessPromise = null; s.remove(); rej(new Error('Tesseract.js を読み込めませんでした(オフラインまたはCDN障害)')); };
      document.head.appendChild(s);
    });
    return tessPromise;
  }

  /* ---------- OCR: 名刺テキストのヒューリスティック解析 ---------- */
  function normalizeOcr(text){
    return String(text||'')
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch=>String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[＠]/g, '@').replace(/[．]/g, '.').replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/(\d)\s*[－−‐―ー–-]\s*(?=\d)/g, '$1-');
  }
  function parseCard(raw){
    const text = normalizeOcr(raw);
    const lines = text.split(/\r?\n/)
      .map(s=>s.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const out = {};
    const hasPhoneLike = l => /\d{2,4}-\d{2,4}-\d{3,4}/.test(l);

    const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
    if (email) out.email = email[0];

    const zip = text.match(/〒\s*(\d{3})\s*-?\s*(\d{4})(?!\d)/) || text.match(/(?:^|[^\d-])(\d{3})-(\d{4})(?![\d-])/m);
    if (zip) out.zip = `${zip[1]}-${zip[2]}`;

    for (const line of lines){
      PHONE_RE.lastIndex = 0; let m;
      while ((m = PHONE_RE.exec(line))){
        const before = line.slice(0, m.index).toUpperCase();
        const lastFax = Math.max(before.lastIndexOf('FAX'), before.lastIndexOf('ファックス'));
        const lastTel = Math.max(before.lastIndexOf('TEL'), before.lastIndexOf('電話'), before.lastIndexOf('携帯'), before.lastIndexOf('MOBILE'), before.lastIndexOf('直通'), before.lastIndexOf('PHONE'));
        if (lastFax >= 0 && lastFax > lastTel) continue;
        const num = m[0].replace(/ /g, '-');
        if (out.zip && num.endsWith(out.zip) && num.length <= 9) continue;
        if (/^0[789]0-/.test(num)){ if (!out.mobile) out.mobile = num; }
        else if (!out.phone) out.phone = num;
      }
    }

    let addrIdx = -1;
    for (let i=0; i<lines.length; i++){
      const idx = lines[i].search(PREF_RE);
      if (idx >= 0 && idx <= 12 && !/@/.test(lines[i])){
        let a = lines[i].slice(idx).replace(/\s*(TEL|Tel|FAX|Fax|電話|E-?mail|携帯|Mobile).*$/i, '').trim();
        if (a.length >= 4){ out.address = a; addrIdx = i; break; }
      }
    }
    if (addrIdx < 0 && out.zip){
      const zi = lines.findIndex(l=>l.includes(out.zip) && !hasPhoneLike(l.replace(out.zip,'')));
      if (zi >= 0){
        const rest = lines[zi].replace(/.*?〒?\s*\d{3}-\d{4}\s*/, '').trim();
        if (rest.length >= 4 && !/@|TEL|FAX/i.test(rest)){ out.address = rest; addrIdx = zi; }
        else if (lines[zi+1] && lines[zi+1].length >= 4 && !/@|TEL|FAX|http/i.test(lines[zi+1]) && !hasPhoneLike(lines[zi+1])){ out.address = lines[zi+1]; addrIdx = zi+1; }
      }
    }
    if (addrIdx >= 0){
      const nx = lines[addrIdx+1];
      if (nx && nx.length <= 25 && /(ビル|タワー|階|F$|号室|館|BLDG|Bldg)/i.test(nx) && !/@|TEL|FAX|http/i.test(nx) && !hasPhoneLike(nx)) out.address += ' ' + nx;
    }

    const isNoise = l => /@|http|www\.|TEL|FAX|〒/i.test(l) || hasPhoneLike(l) || l.search(PREF_RE) >= 0;
    let companyIdx = lines.findIndex(l=>COMPANY_RE.test(l) && !/@|http/i.test(l));
    if (companyIdx < 0) companyIdx = lines.findIndex(l=>COMPANY_LOOSE_RE.test(l) && !isNoise(l) && !DEPT_RE.test(l) && !TITLE_RE.test(l) && l.length <= 30);
    if (companyIdx >= 0) out.company = lines[companyIdx].replace(/\s*(TEL|FAX|〒).*$/i, '').trim();

    let nameFromTitle = '';
    const takeTitle = (t)=>{
      const tn = t.match(TITLE_NAME_RE);
      if (tn && !TITLE_RE.test(tn[2]) && !DEPT_RE.test(tn[2])){ if (!nameFromTitle) nameFromTitle = tn[2]; t = tn[1]; }
      if (!out.title && t.length <= 16) out.title = t;
    };
    for (let i=0; i<lines.length; i++){
      const l = lines[i];
      if (i === companyIdx || i === addrIdx || isNoise(l) || /\d/.test(l) || l.length > 24) continue;
      if (TITLE_RE.test(l)){
        const m = l.match(/^(.*?(?:部|課|室|グループ|センター|事業部|支店|支社|営業所|本部|チーム))[ 　]*(.+)$/);
        if (m && TITLE_RE.test(m[2])){ if (!out.department) out.department = m[1]; takeTitle(m[2]); }
        else takeTitle(l);
      } else if (!out.department && DEPT_RE.test(l) && l.length <= 20) out.department = l;
    }

    const nameCands = [];
    for (let i=0; i<lines.length; i++){
      const l = lines[i];
      if (i === companyIdx || i === addrIdx || isNoise(l)) continue;
      if (!NAME_RE.test(l)) continue;
      if (TITLE_RE.test(l) || DEPT_RE.test(l) || COMPANY_RE.test(l) || COMPANY_LOOSE_RE.test(l)) continue;
      if (/^.{2,}[市区町村都道府県]$/.test(l.replace(/[ 　]/g,''))) continue;
      if (l === out.title || l === out.department) continue;
      nameCands.push(i);
    }
    if (nameFromTitle) out.name = nameFromTitle.replace(/[ 　]+/g, ' ');
    else if (nameCands.length){
      const after = companyIdx >= 0 ? nameCands.find(i=>i>companyIdx) : undefined;
      const idx = after !== undefined ? after : nameCands[0];
      out.name = lines[idx].replace(/[ 　]+/g, ' ');
    }
    return out;
  }

  /* ---------- CSV ---------- */
  function toCsv(rows){
    const cols = [['company','会社名'],['department','部署'],['name','氏名'],['title','役職'],['phone','電話'],['mobile','携帯'],['email','メール'],['zip','郵便番号'],['address','住所'],['tags','タグ'],['memo','メモ'],['createdAt','登録日時'],['updatedAt','更新日時']];
    const esc = v => { let s = v == null ? '' : Array.isArray(v) ? v.join('、') : String(v); if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; };
    const lines = [cols.map(c=>c[1]).join(',')].concat(rows.map(r=>cols.map(c=>esc(r[c[0]])).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const telHref = s => String(s||'').replace(/[^\d+]/g, '');
  const sortCustomers = arr => arr.sort((a,b)=> (a.company||'').localeCompare(b.company||'', 'ja') || (a.name||'').localeCompare(b.name||'', 'ja'));

  App.register('customers', {
    title:'顧客・名刺', icon:'👤', tab:true, short:'名刺',
    _parseCard: parseCard, _toCsv: toCsv,
    render(root, {params}){
      const { h, toast, field, input, textarea } = UI;
      let activeTag = '';
      let openedFromParam = false;
      const search = h('input',{type:'search', placeholder:'会社名・氏名・タグ・住所で検索'});
      const chips = h('div',{class:'chip-row'});
      const list = h('div',{class:'list'});
      const countEl = h('span',{class:'small muted'});

      /* ---------- 一覧 ---------- */
      function matches(c, q){
        if (!q) return true;
        const hay = [c.company, c.name, c.department, c.title, c.address, c.phone, c.mobile, c.email, tagsOf(c).join(' ')].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      }
      function thumb(c){
        const ph = ()=>h('div',{class:'thumb ph', 'aria-hidden':'true'}, '👤');
        if (!c.cardImageId) return ph();
        const img = h('img',{class:'thumb', alt:'名刺'});
        Files.url(c.cardImageId).then(u=>{ if (u) img.src = u; else img.replaceWith(ph()); }).catch(()=>img.replaceWith(ph()));
        return img;
      }
      function row(c){
        return h('div',{class:'item', role:'button', tabindex:'0', onClick:()=>openDetail(c.id),
          onKeydown:(e)=>{ if(e.key==='Enter'){ openDetail(c.id); } }},
          thumb(c),
          h('div',{class:'main'},
            h('div',{class:'title'}, c.company || '(会社名なし)', c.department ? h('span',{class:'small muted'}, ' ', c.department) : null),
            h('div',{class:'sub'}, [c.name, c.title].filter(Boolean).join('　') || '—'),
            (c.phone || c.mobile) ? h('div',{class:'sub'}, '📞 ', [c.phone, c.mobile].filter(Boolean).join(' / ')) : null,
            tagsOf(c).length ? h('div',{style:{marginTop:'4px'}}, tagsOf(c).map(t=>h('span',{class:'tag'}, t))) : null
          ),
          h('div',{class:'side'}, '›')
        );
      }
      function refresh(){
        const all = sortCustomers(Store.list('customers'));
        const tags = [...new Set(all.flatMap(c=>tagsOf(c)))].sort((a,b)=>a.localeCompare(b,'ja'));
        if (activeTag && !tags.includes(activeTag)) activeTag = '';
        UI.clear(chips);
        if (tags.length){
          chips.appendChild(h('button',{class:'chip'+(activeTag===''?' active':''), onClick:()=>{ activeTag=''; refresh(); }}, 'すべて'));
          tags.forEach(t=>chips.appendChild(h('button',{class:'chip'+(activeTag===t?' active':''), onClick:()=>{ activeTag = activeTag===t ? '' : t; refresh(); }}, t)));
        }
        const q = search.value.trim().toLowerCase();
        const rows = all.filter(c=> matches(c, q) && (!activeTag || tagsOf(c).includes(activeTag)));
        countEl.textContent = `${rows.length} / ${all.length}件(会社名順)`;
        UI.clear(list);
        if (!all.length){ list.appendChild(UI.empty('顧客がまだありません。「＋ 新規」から名刺を登録してください。')); return; }
        if (!rows.length){ list.appendChild(UI.empty('該当する顧客がありません')); return; }
        rows.forEach(c=>list.appendChild(row(c)));
      }

      /* ---------- 削除 ---------- */
      async function removeCustomer(c){
        try {
          const fs = await Files.list('customer', c.id);
          for (const f of fs) await Files.remove(f.id);
          if (c.cardImageId) await Files.remove(c.cardImageId);
        } catch(e){ console.warn(e); }
        Store.remove('customers', c.id);
      }

      /* ---------- 詳細 ---------- */
      function openDetail(id){
        const c = Store.get('customers', id);
        if (!c){ toast('顧客が見つかりません', {error:true}); return; }
        let m = null;
        const body = h('div');
        if (c.cardImageId){
          const img = h('img',{class:'card-img mb', alt:'名刺画像', style:{display:'none'}});
          Files.url(c.cardImageId).then(u=>{ if (u){ img.src = u; img.style.display = ''; } }).catch(()=>{});
          body.appendChild(img);
        }
        const kv = h('dl',{class:'kv'});
        const add = (k, v)=>{ if (v === null || v === undefined || v === '') return; kv.append(h('dt',null,k), h('dd',null,v)); };
        add('会社名', c.company); add('部署', c.department); add('氏名', c.name); add('役職', c.title);
        add('電話', c.phone ? h('a',{href:'tel:'+telHref(c.phone)}, c.phone) : '');
        add('携帯', c.mobile ? h('a',{href:'tel:'+telHref(c.mobile)}, c.mobile) : '');
        add('メール', c.email ? h('a',{href:'mailto:'+c.email}, c.email) : '');
        add('郵便番号', c.zip);
        add('住所', c.address ? h('a',{href:Geo.gmapsUrl([c.address]), target:'_blank', rel:'noopener'}, c.address, ' ↗') : '');
        add('座標', (c.lat != null && c.lng != null) ? `${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}` : '');
        add('タグ', tagsOf(c).length ? h('div',null, tagsOf(c).map(t=>h('span',{class:'tag'}, t))) : '');
        add('登録', UI.fmtDateTime(c.createdAt)); add('更新', UI.fmtDateTime(c.updatedAt));
        body.appendChild(kv);
        if (c.memo) body.append(h('h3',{class:'mt'}, 'メモ'), h('pre',{class:'plain'}, c.memo));

        const evs = Store.where('events', e=>e.customerId===id).sort((a,b)=> ((b.date||'')+(b.start||'')).localeCompare((a.date||'')+(a.start||'')));
        body.appendChild(h('h3',{class:'mt'}, `訪問履歴 (${evs.length})`));
        if (!evs.length) body.appendChild(h('div',{class:'small muted'}, '予定・訪問はまだありません'));
        else {
          body.appendChild(h('div',{class:'list'}, evs.slice(0,30).map(e=>h('a',{class:'file-row', href:`#/schedule?view=day&date=${e.date}`, style:{color:'inherit'}, onClick:()=>{ if (m) m.close(); }},
            h('span',{class:'nowrap small muted'}, UI.fmtDate(e.date,{year:true}), e.start ? ' '+e.start : ''),
            h('span',{class:'nm'}, e.title || '(無題)'),
            UI.badge(App.Shared.eventTypeLabel(e.type), e.type||'other'),
            e.status && e.status !== 'planned' ? UI.badge(STATUS_LABEL[e.status]||e.status, e.status) : null
          ))));
          if (evs.length > 30) body.appendChild(h('div',{class:'small muted mt'}, `他 ${evs.length-30}件`));
        }
        body.append(h('h3',{class:'mt'}, '添付'), App.Shared.attachments('customer', id));

        m = UI.modal({ title: App.Shared.customerLabel(c) || '顧客', body,
          onClose:()=>{ if (openedFromParam){ openedFromParam = false; try { history.replaceState(null, '', '#/customers'); } catch(e){} } },
          actions:[
            {label:'削除', cls:'danger', left:true, onClick: async()=>{
              if (!await UI.confirm(`「${App.Shared.customerLabel(c)}」を削除しますか?(名刺画像・添付も削除されます)`)) return false;
              await removeCustomer(c); toast('削除しました');
            }},
            {label:'閉じる', onClick:()=>{}},
            {label:'編集', cls:'primary', onClick:()=>{ setTimeout(()=>openEdit(c, {onSaved:(s)=>openDetail(s.id)}), 0); }}
          ]});
      }

      /* ---------- 名刺の一括取り込み(AI読み取り) ---------- */
      async function shrinkImage(file){
        if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.2*1024*1024) return file;
        try {
          const bmp = await createImageBitmap(file);
          const max = 2000, sc = Math.min(1, max/Math.max(bmp.width,bmp.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width*sc); cv.height = Math.round(bmp.height*sc);
          cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
          const blob = await new Promise(r=>cv.toBlob(r,'image/jpeg',0.88));
          return new File([blob], (file.name||'card').replace(/\.\w+$/,'')+'.jpg', {type:'image/jpeg'});
        } catch(e){ return file; }
      }
      function findDup(c){
        const n = x => String(x||'').replace(/\s+/g,'').toLowerCase();
        return Store.list('customers').find(x => (c.email && x.email && n(x.email)===n(c.email)) || (n(x.company)===n(c.company) && n(x.name)===n(c.name) && (c.company||c.name))) || null;
      }
      function openBulkImport(){
        const items = []; // {key, file, url, card:{...}, checked, dup, status, error}
        const list = h('div',{class:'list'});
        const summary = h('div',{class:'small muted'});
        const fileInp = h('input',{type:'file', accept:'image/*', multiple:true, style:{display:'none'}, onChange:()=>addFiles(fileInp.files)});
        const camInp = h('input',{type:'file', accept:'image/*', capture:'environment', style:{display:'none'}, onChange:()=>addFiles(camInp.files)});
        let running = false;
        const FIELDS = [['company','会社名'],['department','部署'],['name','氏名'],['title','役職'],['phone','電話'],['mobile','携帯'],['email','メール'],['zip','郵便番号'],['address','住所'],['memo','メモ']];
        function render(){
          UI.clear(list);
          const done = items.filter(i=>i.status==='done').length, errs = items.filter(i=>i.status==='error').length;
          summary.textContent = items.length ? `${items.length}枚: 読み取り済 ${done} / 失敗 ${errs} / 処理中 ${items.length-done-errs}。内容を確認・修正して「選択を登録」を押してください。` : '';
          if (!items.length){ list.appendChild(UI.empty('名刺の写真を選ぶと、AIが1枚ずつ読み取ってここに並びます。スマホでは「撮影」で続けて撮れます。')); return; }
          for (const it of items){
            const c = it.card || {};
            const fields = h('div',{class:'form', style:{gap:'6px'}});
            if (it.status==='done'){
              const grid = h('div',{class:'f-row c3'});
              FIELDS.forEach(([k,label])=>{ grid.appendChild(h('div',{class:'f'}, h('label',null,label), h('input',{type:'text', value:c[k]||'', onChange:(e)=>{ c[k]=e.target.value; it.dup = findDup(c); dupEl.replaceChildren(dupText(it)); }}))); });
              fields.appendChild(grid);
            }
            const dupEl = h('div',{class:'small'});
            function dupText(it){ return it.dup ? h('span',{class:'text-warn'}, `⚠ 同じ名刺が登録済み(${S.customerLabel(it.dup)})。登録すると上書き更新します`) : h('span',{class:'muted'}, '新規登録'); }
            dupEl.appendChild(dupText(it));
            list.appendChild(h('div',{class:'card compact', style:{marginBottom:'8px'}},
              h('div',{class:'row', style:{alignItems:'flex-start'}},
                h('input',{type:'checkbox', checked: it.checked && it.status==='done', disabled: it.status!=='done', onChange:(e)=>{ it.checked=e.target.checked; }}),
                h('img',{src:it.url, class:'thumb', style:{width:'120px', height:'76px', objectFit:'cover', cursor:'zoom-in'}, onClick:()=>window.open(it.url,'_blank')}),
                h('div',{style:{flex:1, minWidth:0}},
                  h('div',{class:'row'}, h('b',null, c.company || c.name || it.file.name), c.name && c.company ? h('span',{class:'muted'}, c.name) : null,
                    it.status==='pending' ? h('span',{class:'badge planned'}, '待機中') : it.status==='running' ? h('span',{class:'badge draft'}, 'AI読み取り中…') : it.status==='error' ? h('span',{class:'badge cancelled', style:{textDecoration:'none'}}, '失敗') : h('span',{class:'badge done'}, '読み取り済'),
                    h('span',{style:{flex:1}}),
                    it.status==='error' ? h('button',{class:'btn sm', onClick:()=>{ it.status='pending'; render(); runQueue(); }}, '再試行') : null,
                    h('button',{class:'btn sm', onClick:()=>{ items.splice(items.indexOf(it),1); URL.revokeObjectURL(it.url); render(); }}, '✕')),
                  it.error ? h('div',{class:'small text-danger'}, it.error) : null,
                  it.note ? h('div',{class:'small muted'}, 'AIメモ: '+it.note) : null,
                  it.status==='done' ? dupEl : null)),
              fields));
          }
        }
        async function addFiles(files){
          for (const f of Array.from(files||[])){
            if (!f.type.startsWith('image/') && !/\.(heic|heif)$/i.test(f.name)) { toast(`${f.name}: 画像ではありません`, {error:true}); continue; }
            items.push({ key: UI.uid(), file: f, url: URL.createObjectURL(f), card: null, checked: true, dup: null, status: 'pending', error: '' });
          }
          fileInp.value=''; camInp.value='';
          render(); runQueue();
        }
        async function runQueue(){
          if (running) return; running = true;
          try {
            for (const it of items){
              if (it.status !== 'pending') continue;
              it.status = 'running'; render();
              try {
                const f = await shrinkImage(it.file);
                const read = async()=>{
                  const res = await fetch('api/cards', { method:'POST', headers:{ 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name||'') }, body: f });
                  let j=null; try { j = await res.json(); } catch(e){}
                  if (!res.ok) throw new Error((j&&j.error) || `読み取りに失敗 (${res.status})`);
                  return j;
                };
                let j = await read();
                // 氏名も電話もメールも取れていない場合は一度だけ読み直す(AIの揺れ対策)
                if (!(j.cards||[]).length || !((j.cards[0].name) || (j.cards[0].phone) || (j.cards[0].email))) { try { const j2 = await read(); if ((j2.cards||[]).length) j = j2; } catch(e){} }
                const cs = j.cards || [];
                if (!cs.length) throw new Error('名刺を認識できませんでした(写真を確認してください)');
                it.card = cs[0]; it.note = j.note || ''; it.status = 'done'; it.dup = findDup(it.card);
                // 1枚の写真に複数の名刺が写っていた場合は、同じ画像で項目を追加
                cs.slice(1).forEach(c=>{ const extra = { key: UI.uid(), file: it.file, url: it.url, card: c, checked: true, dup: findDup(c), status:'done', error:'', note:'', shared:true }; items.splice(items.indexOf(it)+1, 0, extra); });
              } catch(e){ it.status = 'error'; it.error = e.message; }
              render();
            }
          } finally { running = false; }
        }
        async function registerAll(close){
          const targets = items.filter(i=>i.checked && i.status==='done');
          if (!targets.length){ toast('登録する名刺を選択してください', {error:true}); return false; }
          let created=0, updated=0, failed=0;
          const toGeocode = [];
          for (const it of targets){
            try {
              const c = it.card;
              const dup = findDup(c);
              const base = dup ? Object.assign({}, dup) : { tags:[], memo:'', lat:null, lng:null, cardImageId:null };
              FIELDS.forEach(([k])=>{ if (c[k]) base[k] = c[k]; });
              const extras = [c.nameKana && `ふりがな: ${c.nameKana}`, c.fax && `FAX: ${c.fax}`, c.website && `Web: ${c.website}`].filter(Boolean).join(' / ');
              if (extras && !(base.memo||'').includes(extras)) base.memo = [base.memo, extras].filter(Boolean).join('\n');
              if (c.address && c.address !== (dup && dup.address)){ base.lat = null; base.lng = null; }
              const saved = Store.save('customers', base);
              try {
                const f = await shrinkImage(it.file);
                const rec = await Files.put(f, 'customer', saved.id, {name:'名刺.jpg'});
                if (saved.cardImageId && saved.cardImageId !== rec.id){ try { await Files.remove(saved.cardImageId); } catch(e){} }
                saved.cardImageId = rec.id; Store.save('customers', saved);
              } catch(e){ console.warn('card image save failed', e); }
              if (saved.address && (saved.lat == null || saved.lng == null)) toGeocode.push(saved.id);
              dup ? updated++ : created++;
            } catch(e){ console.error(e); failed++; }
          }
          toast(`名刺を登録: 新規 ${created} / 更新 ${updated}${failed?` / 失敗 ${failed}`:''}`, {ms:5000});
          close();
          if (toGeocode.length){
            // 住所の座標取得は裏で順に行う(1件1秒ほど)
            (async()=>{ let n=0; for (const id of toGeocode){ const c = Store.get('customers', id); if (!c || !c.address) continue; try { const g = await Geo.geocode(c.address); if (g){ c.lat=g.lat; c.lng=g.lng; Store.save('customers', c); n++; } } catch(e){} } if (n) toast(`${n}件の住所の座標を取得しました`); })();
          }
          return true;
        }
        const m = UI.modal({ title:'名刺をまとめて取り込む', wide:true,
          body: h('div',null,
            h('div',{class:'row'}, h('button',{class:'btn', onClick:()=>camInp.click()}, '📷 撮影して追加'), h('button',{class:'btn', onClick:()=>fileInp.click()}, '🖼️ 写真を選ぶ(複数可)'), fileInp, camInp),
            h('p',{class:'small muted mt'}, '1枚の写真に1枚の名刺が基本ですが、机に並べて撮った写真(数枚まで)も読み取れます。読み取りはクラウド版のみ。登録後も顧客の編集画面で直せます。'),
            summary, h('div',{class:'mt'}, list)),
          actions:[ {label:'閉じる', onClick:()=>{}}, {label:'選択を登録', cls:'primary', onClick: async(e, close)=>{ const ok = await registerAll(close); return ok ? false : false; }} ],
          onClose:()=>{ items.forEach(i=>{ if (!i.shared) URL.revokeObjectURL(i.url); }); refresh(); }
        });
        render();
      }

      /* ---------- 編集 / 新規 ---------- */
      function openEdit(c, {onSaved}={}){
        const isNew = !c || !c.id;
        const data = Object.assign({ company:'', department:'', name:'', title:'', phone:'', mobile:'', email:'', zip:'', address:'', lat:null, lng:null, tags:[], memo:'', cardImageId:null }, c||{});
        let pendingFile = null, removeImage = false, previewUrl = null;

        const preview = h('img',{class:'card-img', alt:'名刺', style:{display:'none'}});
        if (data.cardImageId) Files.url(data.cardImageId).then(u=>{ if (u){ preview.src = u; preview.style.display = ''; } }).catch(()=>{});
        const onPick = (inp)=>()=>{
          const f = inp.files && inp.files[0]; if (!f) return;
          if (!f.type.startsWith('image/')){ toast('画像ファイルを選択してください', {error:true}); inp.value=''; return; }
          pendingFile = f; removeImage = false;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(f); preview.src = previewUrl; preview.style.display = '';
          ocrBtn.disabled = false; delImgBtn.style.display = '';
          inp.value = '';
        };
        const camInp = h('input',{type:'file', accept:'image/*', capture:'environment', style:{display:'none'}});
        const fileInp = h('input',{type:'file', accept:'image/*', style:{display:'none'}});
        camInp.addEventListener('change', onPick(camInp));
        fileInp.addEventListener('change', onPick(fileInp));

        const ocrStatus = h('div',{class:'small muted'});
        const ocrBar = h('i');
        const ocrProg = h('div',{class:'ocr-progress', style:{display:'none'}}, ocrBar);
        const rawText = h('pre',{class:'plain', style:{maxHeight:'220px', overflow:'auto', fontSize:'.85rem'}});
        const rawWrap = h('details',{style:{display:'none'}},
          h('summary',{class:'small'}, 'OCRの生テキスト(手動コピー用)'),
          rawText,
          h('div',{class:'row mt'}, h('button',{class:'btn sm', onClick:()=>UI.copy(rawText.textContent)}, 'テキストをコピー')));
        const ocrBtn = h('button',{class:'btn sm', disabled: !data.cardImageId, onClick: runOcr}, '🔎 画像から読み取る(OCR)');
        const delImgBtn = h('button',{class:'btn sm danger', style:{display: data.cardImageId ? '' : 'none'}, onClick:()=>{
          removeImage = true; pendingFile = null; preview.style.display = 'none'; preview.removeAttribute('src');
          ocrBtn.disabled = true; delImgBtn.style.display = 'none';
        }}, '画像を削除');

        async function runOcr(){
          let src = pendingFile;
          if (!src && data.cardImageId && !removeImage){ try { const rec = await Files.get(data.cardImageId); src = rec && rec.blob; } catch(e){} }
          if (!src){ toast('先に名刺画像を撮影または選択してください', {error:true}); return; }
          ocrBtn.disabled = true; ocrProg.style.display = ''; ocrBar.style.width = '0%';
          try {
            ocrStatus.textContent = 'OCRエンジンを読み込み中…(初回は数十秒かかります)';
            await loadTesseract();
            const res = await window.Tesseract.recognize(src, 'jpn+eng', { logger: (msg)=>{
              const p = Math.round((msg.progress||0)*100);
              ocrStatus.textContent = `${OCR_STATUS[msg.status] || msg.status || '処理中'} ${p}%`;
              ocrBar.style.width = (msg.status === 'recognizing text' ? p : Math.min(p, 15)) + '%';
            }});
            const text = (res && res.data && res.data.text) || '';
            rawText.textContent = text; rawWrap.style.display = '';
            const parsed = parseCard(text);
            const filled = [];
            for (const [k, v] of Object.entries(parsed)){
              const el = form.querySelector(`[name="${k}"]`);
              if (el && v && !el.value.trim()){ el.value = v; filled.push(FIELD_LABEL[k]||k); }
            }
            ocrBar.style.width = '100%';
            ocrStatus.textContent = filled.length
              ? `読み取り完了: ${filled.join('・')} を入力しました。OCRの精度には限りがあるため、内容を必ず確認・修正してください。`
              : '読み取りは完了しましたが、空欄に自動入力できる項目がありませんでした。下の生テキストから手動でコピーしてください。';
          } catch(e){
            console.error(e);
            toast('OCRに失敗しました: ' + (e && e.message || e), {error:true});
            ocrStatus.textContent = 'OCRに失敗しました。通信環境を確認して再度お試しください。';
          } finally { ocrBtn.disabled = false; setTimeout(()=>{ ocrProg.style.display = 'none'; }, 800); }
        }

        const form = h('div',{class:'form'},
          h('div',{class:'f'}, h('label',null,'名刺画像'),
            preview,
            h('div',{class:'row'},
              h('button',{class:'btn sm', onClick:()=>camInp.click()}, '📷 撮影'),
              h('button',{class:'btn sm', onClick:()=>fileInp.click()}, '🖼️ 画像を選択'),
              ocrBtn, delImgBtn, camInp, fileInp),
            ocrProg, ocrStatus, rawWrap,
            h('div',{class:'small muted'}, 'OCRは端末内で処理されます(画像は外部に送信されません)。精度には限りがあります。')
          ),
          h('div',{class:'f-row'},
            field('会社名', input({name:'company', value:data.company, placeholder:'例: 株式会社○○トラベル'})),
            field('部署', input({name:'department', value:data.department, placeholder:'例: 団体営業部'}))),
          h('div',{class:'f-row'},
            field('氏名', input({name:'name', value:data.name, placeholder:'例: 山田 太郎'})),
            field('役職', input({name:'title', value:data.title, placeholder:'例: 課長'}))),
          h('div',{class:'f-row'},
            field('電話', input({type:'tel', name:'phone', value:data.phone, placeholder:'03-1234-5678'})),
            field('携帯', input({type:'tel', name:'mobile', value:data.mobile, placeholder:'090-1234-5678'}))),
          field('メール', input({type:'email', name:'email', value:data.email, placeholder:'name@example.co.jp'})),
          h('div',{class:'f-row'},
            field('郵便番号', input({name:'zip', value:data.zip, placeholder:'123-4567'})),
            field('タグ(カンマ区切り)', input({name:'tags', value:tagsOf(data).join(', '), placeholder:'旅行会社, 関西, 重要'}))),
          field('住所', input({name:'address', value:data.address, placeholder:'都道府県から入力'}), {hint:'保存時に座標を自動取得します(ルート作成で使用)'}),
          field('メモ', textarea({name:'memo', value:data.memo, rows:3}))
        );

        async function save(){
          const v = UI.readForm(form);
          Object.keys(v).forEach(k=>{ if (typeof v[k] === 'string') v[k] = v[k].trim(); });
          if (!v.company && !v.name){ toast('会社名または氏名を入力してください', {error:true}); return null; }
          const tags = v.tags.split(/[,、]/).map(s=>s.trim()).filter(Boolean);
          const out = Object.assign({}, data, v, {tags});
          if (!out.address){ out.lat = null; out.lng = null; }
          else if (out.lat == null || out.lng == null || out.address !== data.address){
            out.lat = null; out.lng = null;
            try {
              const g = await Geo.geocode(out.address);
              if (g){ out.lat = g.lat; out.lng = g.lng; } else toast('住所の座標が見つかりませんでした(顧客は保存します)');
            } catch(e){ console.warn('geocode failed', e); }
          }
          const saved = Store.save('customers', out);
          try {
            if (removeImage && saved.cardImageId){ await Files.remove(saved.cardImageId); saved.cardImageId = null; Store.save('customers', saved); }
            if (pendingFile){
              const old = saved.cardImageId;
              const ext = pendingFile.type === 'image/png' ? 'png' : pendingFile.type === 'image/webp' ? 'webp' : pendingFile.type === 'image/heic' ? 'heic' : 'jpg';
              const rec = await Files.put(pendingFile, 'customer', saved.id, {name:'名刺.'+ext});
              saved.cardImageId = rec.id; Store.save('customers', saved);
              if (old && old !== rec.id) await Files.remove(old);
            }
          } catch(e){ console.error(e); toast('名刺画像の保存に失敗しました: ' + (e.message||e), {error:true}); }
          return saved;
        }

        UI.modal({ title: isNew ? '顧客を新規登録' : '顧客を編集', body: form,
          onClose:()=>{ if (previewUrl) URL.revokeObjectURL(previewUrl); },
          actions:[
            {label:'キャンセル', onClick:()=>{}},
            {label:'保存', cls:'primary', onClick: async()=>{ const s = await save(); if (!s) return false; toast('保存しました'); if (onSaved) setTimeout(()=>onSaved(s), 0); }}
          ]});
      }

      /* ---------- CSV ---------- */
      function exportCsv(){
        const rows = sortCustomers(Store.list('customers'));
        if (!rows.length){ toast('書き出す顧客がありません', {error:true}); return; }
        UI.download(`customers-${UI.today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
        toast(`${rows.length}件をCSVに書き出しました`);
      }

      /* ---------- ページ ---------- */
      search.addEventListener('input', UI.debounce(refresh, 200));
      root.append(
        h('div',{class:'page-head'}, h('h1',null,'👤 顧客・名刺'), h('div',{class:'spacer'}),
          h('button',{class:'btn', onClick:openBulkImport}, '📇 名刺をまとめて取り込む'),
          h('a',{class:'btn', href:'#/plan'}, '🧭 リストから取り込む'),
          h('button',{class:'btn', onClick:exportCsv}, '⬇️ CSV書き出し'),
          h('button',{class:'btn primary', onClick:()=>openEdit(null, {onSaved:(s)=>openDetail(s.id)})}, '＋ 新規')),
        h('div',{class:'card compact'},
          h('div',{class:'search'}, search),
          h('div',{class:'mt'}, chips),
          h('div',{class:'mt right'}, countEl)),
        list
      );
      refresh();
      if (params.id){ openedFromParam = true; openDetail(params.id); }
      else if (params.new){ openEdit(null, {onSaved:(s)=>openDetail(s.id)}); }
      const offs = [Store.on('customers', refresh)];
      return { destroy(){ offs.forEach(f=>f()); } };
    }
  });
})();
