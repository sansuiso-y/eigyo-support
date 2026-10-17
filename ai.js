/*
 * AI 機能(Gemini API)— 営業計画ページ用
 *   POST /api/extract  … 写真・PDF の訪問先リストを表(JSON)に読み取る
 *   POST /api/assist   … 「どこをいつ回りたいか」の日本語の注文を、行ごとの希望日・時間帯に変換する
 *   POST /api/lookup   … 会社名から所在地を Google 検索付きで調べる(要確認として扱う)
 *   POST /api/cards    … 名刺の写真(1枚に複数枚写っていてもよい)を読み取り、顧客の項目にする
 *   POST /api/hotels   … 各日の訪問内容から、泊まるのにおすすめのホテルを Google 検索付きで提案する
 * 環境変数 GEMINI_API_KEY が必要(他の社内アプリと共用)。未設定なら 503 を返す。
 */
'use strict';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash,gemini-2.5-flash').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_FILE = 25 * 1024 * 1024;

/* 画像パート。名刺や名簿は細かい文字が多いので最高解像度(ultra_high、画像あたり約2,200トークン ≒ 通常の2倍)で渡す。
   mediaResolution は Gemini 3 以降のパートごとの指定で、2.x 系には付けない(gemini() 側で外す) */
function imagePart(mimeType, buffer){ const p = { inlineData:{ mimeType, data: buffer.toString('base64') } }; if (mimeType.startsWith('image/')) p.mediaResolution = { level:'MEDIA_RESOLUTION_ULTRA_HIGH' }; return p; }

async function gemini({ parts, system, schema, tools }){
  const key = process.env.GEMINI_API_KEY;
  if (!key){ const e = new Error('AI機能はクラウド版でのみ使えます(GEMINI_API_KEY 未設定)'); e.status = 503; throw e; }
  let lastErr = null;
  for (const model of MODELS) for (let attempt = 0; attempt < 2; attempt++){ // 応答が途中で切れた/解釈できないときは同じモデルでもう1回、だめなら次のモデルへ
    const modelParts = /^gemini-[12]\./.test(model) ? parts.map(p => { const { mediaResolution, ...rest } = p; return rest; }) : parts;
    const body = { contents:[{ role:'user', parts: modelParts }], generationConfig:{ maxOutputTokens: 16000, temperature: 0.1, responseMimeType:'application/json', ...(schema ? { responseSchema: schema } : {}) } };
    if (system) body.systemInstruction = { parts:[{ text: system }] };
    if (tools){ body.tools = tools; delete body.generationConfig.responseMimeType; delete body.generationConfig.responseSchema; } // 検索ツール併用時はJSONモード不可
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 90000);
    let res;
    try { res = await fetch(`${BASE}/models/${model}:generateContent`, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctl.signal }); }
    catch(err){ clearTimeout(timer); lastErr = new Error(err.name==='AbortError' ? 'AIの応答が時間内に返りませんでした' : 'AIに接続できませんでした'); lastErr.status = 504; break; } // 次のモデルへ(同じモデルには再送しない)
    clearTimeout(timer);
    if (res.status === 404 || res.status >= 500){ lastErr = new Error(res.status===404 ? `モデル ${model} が見つかりません` : `AIが混み合っています (${res.status})`); lastErr.status = 502; break; } // 次のモデルへ
    if (!res.ok){
      let detail=''; try { detail = (await res.json()).error?.message || ''; } catch(e){}
      const e = new Error(res.status===429 ? 'AIの利用上限に達しました。少し待ってからお試しください' : `AIエラー (${res.status}) ${detail}`.trim()); e.status = res.status===429?429:502; throw e;
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
    const finish = data.candidates?.[0]?.finishReason || '';
    if (!text && finish !== 'MAX_TOKENS'){ const e = new Error('AIの応答が空でした (' + (finish || data.promptFeedback?.blockReason || '不明') + ')'); e.status = 502; throw e; }
    const parsed = finish === 'MAX_TOKENS' ? null : parseJson(text); // 思考だけで上限に達して本文が空のときも、ここで取り直しに回す // 途中で切れた応答は(たまたま解釈できても)使わない: 同じ内容を繰り返す異常出力のことがある
    if (parsed) return parsed;
    lastErr = new Error(finish === 'MAX_TOKENS' ? '資料が長すぎてAIの応答が途中で切れました。ページを分けて取り込んでください' : 'AIの応答を解釈できませんでした'); lastErr.status = 502;
    console.error('[ai]', model, 'attempt', attempt+1, finish || '', 'len', text.length, '→ retry');
  }
  throw lastErr || new Error('AIを呼び出せませんでした');
}

/* 応答テキストからJSONを取り出す(コードブロック記号や前置きがあっても、最初の { から括弧の対応が取れる所まで) */
function parseJson(text){
  const t = String(text||'').replace(/```(?:json)?/gi,'').trim();
  try { return JSON.parse(t); } catch(e){}
  const start = t.indexOf('{'); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i=start;i<t.length;i++){
    const c = t[i];
    if (inStr){ if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}'){ depth--; if (depth === 0){ try { return JSON.parse(t.slice(start, i+1)); } catch(e){ return null; } } }
  }
  return null;
}

const ROW_SCHEMA = { type:'OBJECT', properties:{ rows:{ type:'ARRAY', items:{ type:'OBJECT', properties:{
  company:{type:'STRING'}, name:{type:'STRING'}, title:{type:'STRING'}, category:{type:'STRING'}, phone:{type:'STRING'}, address:{type:'STRING'}, memo:{type:'STRING'} } } },
  total:{type:'INTEGER', description:'資料に載っている人(行)の総数'}, note:{type:'STRING'} }, required:['rows','total'] };

/* AIが途中で読むのをやめて一部しか返さないことがある → 自己申告の総数(total)と件数を比べ、足りなければ最大3回まで取り直して一番多いものを使う。
   取り直しは開始から90秒以内に始められるときだけ(Cloud Run の 300 秒上限を超えないように)。2回目以降で失敗しても、それまでの結果は返す */
async function readAll(call, key, label){
  const t0 = Date.now(); let best = null, total = 0;
  for (let i = 0; i < 3; i++){
    let out;
    try { out = await call(); }
    catch(e){ if (best){ console.error(`[ai] ${label}: retry failed, keeping`, best[key].length, ':', e.message); break; } throw e; }
    total = Math.max(total, out.total);
    if (!best || out[key].length > best[key].length) best = out;
    if (best[key].length >= total) break;
    if (i === 2 || Date.now() - t0 > 90000){ console.error(`[ai] ${label}:`, out[key].length, '< total', total, '→ giving up'); break; }
    console.error(`[ai] ${label}:`, out[key].length, '< total', total, '→ retry', i+1, `(${Math.round((Date.now()-t0)/1000)}s)`);
  }
  best.total = total;
  return best;
}

async function extract(buffer, mime, fileName){
  if (!buffer || !buffer.length){ const e = new Error('ファイルが空です'); e.status=400; throw e; }
  if (buffer.length > MAX_FILE){ const e = new Error('ファイルが大きすぎます(25MBまで)'); e.status=413; throw e; }
  let mimeType = (mime||'').split(';')[0].trim().toLowerCase();
  const ext = (fileName||'').split('.').pop().toLowerCase();
  if (!mimeType || mimeType==='application/octet-stream'){ mimeType = ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',pdf:'application/pdf',gif:'image/gif'})[ext] || 'image/jpeg'; }
  const system = `あなたは営業アシスタントです。渡された画像やPDFに含まれる「会社・団体・人物の一覧」を読み取り、営業訪問先リストとしてJSONにします。
ルール:
- 1人(または1社)につき1行。資料に載っている人は全員、省略せずに rows に入れる(20人なら20行)。total には資料に載っている人(行)の総数を入れる。
- company(会社名・団体名。原文の表記をそのまま。韓国語・英語などを日本語に翻訳しない)、name(氏名。原文の表記をそのまま。ローマ字併記があれば「原文 (ローマ字)」)、title(役職)、category(区分: 旅行会社 / 法人 / 自治体・関係機関 / メディア / 団体 / その他 のいずれか。表に区分があればそれに従う)、phone(電話番号)、address(住所。書いてあるものだけ。推測しない)、memo(備考欄などの補足)。
- パスポート番号・生年月日・性別・部屋番号・個人のメールアドレスは読み取らず、どの項目にも入れない。
- 同じ会社の人が複数いても、それぞれ1行にする。
- 読み取れない項目は空文字にする。表以外の説明文は rows に含めない。note に、読み取りで気になった点(かすれ・不明瞭など)を日本語で短く書く(なければ空)。`;
  const parts = [ imagePart(mimeType, buffer), { text:'この資料の一覧を読み取って、全員を rows の配列にしてください。' } ];
  const clean = out => ({ rows: (Array.isArray(out.rows) ? out.rows : []).filter(r=>r && typeof r === 'object').map(r=>({
      company: str(r.company).slice(0,200), name: str(r.name).slice(0,200), title: str(r.title).slice(0,200), category: str(r.category).slice(0,50), phone: str(r.phone).slice(0,60), address: str(r.address).slice(0,300), memo: str(r.memo).slice(0,500)
    })).filter(r=>r.company || r.name), total: Math.min(1000, Math.max(0, Math.floor(Number(out.total)) || 0)), note: str(out.note) });
  const best = await readAll(async()=>clean(await gemini({ parts, system, schema: ROW_SCHEMA })), 'rows', 'extract');
  const short = best.total > best.rows.length;
  return { rows: best.rows, total: best.total, note: short ? `資料には約${best.total}件ありますが${best.rows.length}件しか読み取れませんでした。写真を撮り直すか、ページを分けて取り込んでください。` + (best.note ? ' ' + best.note : '') : best.note };
}


const CARD_SCHEMA = { type:'OBJECT', properties:{ cards:{ type:'ARRAY', items:{ type:'OBJECT', properties:{
  company:{type:'STRING'}, department:{type:'STRING'}, name:{type:'STRING'}, nameKana:{type:'STRING'}, title:{type:'STRING'}, phone:{type:'STRING'}, mobile:{type:'STRING'}, fax:{type:'STRING'},
  email:{type:'STRING'}, zip:{type:'STRING'}, address:{type:'STRING'}, website:{type:'STRING'}, memo:{type:'STRING'},
  box_2d:{ type:'ARRAY', items:{type:'INTEGER'}, description:'名刺の位置 [ymin, xmin, ymax, xmax](画像全体を0〜1000とした正規化座標)' } } } },
  total:{type:'INTEGER', description:'写真に写っている名刺の枚数'}, note:{type:'STRING'} }, required:['cards','total'] };

/* 名刺画像 → 顧客の項目。1枚の写真に複数の名刺が写っていれば複数返す */
async function cards(buffer, mime, fileName){
  if (!buffer || !buffer.length){ const e = new Error('ファイルが空です'); e.status=400; throw e; }
  if (buffer.length > MAX_FILE){ const e = new Error('ファイルが大きすぎます(25MBまで)'); e.status=413; throw e; }
  let mimeType = (mime||'').split(';')[0].trim().toLowerCase();
  const ext = (fileName||'').split('.').pop().toLowerCase();
  if (!mimeType || mimeType==='application/octet-stream'){ mimeType = ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',pdf:'application/pdf',gif:'image/gif'})[ext] || 'image/jpeg'; }
  const system = `あなたは営業アシスタントです。名刺の写真を読み取り、顧客台帳の項目としてJSONにします。
ルール:
- まず写真に写っている名刺の枚数を数えて total に入れる(机に並べた数枚〜十数枚の写真もある)。名刺1枚につき cards の1要素を、total と同じ数だけ省略せずに返す。名刺が写っていなければ cards は空、total は 0。
- 写真全体を1枚の名刺として扱わない。カード1枚ごとに box_2d を付ける。
- company(会社名。「株式会社」などの法人格は名刺の表記どおり)、department(部署)、name(氏名。名刺の表記どおり。姓と名の間は半角スペース1つ)、nameKana(ふりがな/ローマ字があれば)、title(役職)、phone(代表/直通の固定電話)、mobile(携帯)、fax、email、zip(郵便番号 123-4567 形式)、address(住所。郵便番号は含めない。ビル名・階まで)、website、memo(名刺にあるその他の情報: 支店名・資格・SNS など短く)。
- 読めない項目は空文字。推測で埋めない。裏面(英語面)しか無い場合は英語表記のまま入れる。韓国語・英語の名刺は原文の表記のまま(翻訳しない)。
- zip には郵便番号だけ(数字とハイフン)。号室・ビル名は address に入れる。各項目にそれ以外の説明や注記を書かない。
- 電話番号は 03-1234-5678 / 090-1234-5678 のようにハイフン区切りに整える。
- box_2d: その名刺が写っている範囲を [ymin, xmin, ymax, xmax] の4整数で返す(画像の上端=0・下端=1000、左端=0・右端=1000 の正規化座標)。名刺の四隅がぴったり収まる範囲。
- note: 読み取りで気になった点(ピンぼけ・切れている など)を日本語で短く(なければ空)。`;
  const parts = [ imagePart(mimeType, buffer), { text:'この写真に写っている名刺をすべて読み取って cards にしてください(枚数は total に)。各名刺の box_2d も必ず返してください。' } ];
  const clean = out => ({ cards: (Array.isArray(out.cards) ? out.cards : []).filter(c=>c && typeof c === 'object').map(c=>({
      company:str(c.company).slice(0,200), department:str(c.department).slice(0,200), name:str(c.name).slice(0,100), nameKana:str(c.nameKana).slice(0,100), title:str(c.title).slice(0,100), phone:str(c.phone).slice(0,60), mobile:str(c.mobile).slice(0,60), fax:str(c.fax).slice(0,60),
      email:str(c.email).slice(0,200), zip:str(c.zip).slice(0,20), address:str(c.address).slice(0,300), website:str(c.website).slice(0,200), memo:str(c.memo).slice(0,500),
      box: Array.isArray(c.box_2d) && c.box_2d.length === 4 && c.box_2d.every(n=>Number.isFinite(Number(n))) ? c.box_2d.map(n=>Math.max(0, Math.min(1000, Math.round(Number(n))))) : null
    })).filter(c=>c.company || c.name), total: Math.min(1000, Math.max(0, Math.floor(Number(out.total)) || 0)), note: str(out.note) });
  const best = await readAll(async()=>clean(await gemini({ parts, system, schema: CARD_SCHEMA })), 'cards', 'cards');
  const short = best.total > best.cards.length;
  return { cards: best.cards, total: best.total, note: short ? `写真には${best.total}枚ありそうですが${best.cards.length}枚しか読み取れませんでした。名刺を2〜4枚ずつに分けて撮り直すと読みやすくなります。` + (best.note ? ' ' + best.note : '') : best.note };
}

const ASSIST_SCHEMA = { type:'OBJECT', properties:{
  updates:{ type:'ARRAY', items:{ type:'OBJECT', properties:{ key:{type:'STRING'}, date:{type:'STRING'}, timeFrom:{type:'STRING'}, timeTo:{type:'STRING'}, checked:{type:'BOOLEAN'}, stayMin:{type:'INTEGER'}, reason:{type:'STRING'} }, required:['key'] } },
  dayPlans:{ type:'ARRAY', items:{ type:'OBJECT', properties:{ date:{type:'STRING'}, travelOnly:{type:'BOOLEAN'}, startPlace:{type:'STRING'}, startQuery:{type:'STRING'}, endPlace:{type:'STRING'}, endQuery:{type:'STRING'}, startTime:{type:'STRING'}, memo:{type:'STRING'} }, required:['date'] } },
  days:{type:'INTEGER'}, startDate:{type:'STRING'}, maxPerDay:{type:'INTEGER'}, message:{type:'STRING'} }, required:['updates','dayPlans','message'] };

/* 注文文の「11/8は山水荘→羽田→仁川空港→청주역」のような矢印の経路を、AIに頼らず確実に読み取る。
   渡航日: 現地の最後の空港 → 終点 を現地での移動、帰国日: 出発 → 現地の最初の空港 を現地での移動とする */
const AIRPORT = /空港|공항|airport|羽田|成田|関空|仁川|金浦/i;
const JP_AIRPORT = /羽田|成田|関空|関西|中部|伊丹|福岡|新千歳|那覇|福島|仙台|東京/;
const LOCAL_QUERY = [[/仁川/, '인천국제공항'], [/金浦/, '김포국제공항'], [/清州空港|清州国際空港/, '청주국제공항'], [/釜山|金海/, '김해국제공항']];
function parseRoutes(text, startDate, homeNames){
  const y0 = /^\d{4}-\d{2}/.test(startDate) ? Number(startDate.slice(0,4)) : new Date().getFullYear();
  const m0 = /^\d{4}-\d{2}/.test(startDate) ? Number(startDate.slice(5,7)) : 1;
  const iso = (m, d) => { let y = y0; if (m < m0 - 6) y++; return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; };
  const isHome = p => (homeNames||[]).some(h => h && h.length >= 2 && (p.includes(h) || h.includes(p)));
  const DATE = /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g;
  const out = [];
  for (const piece0 of String(text||'').split(/[\n。]/)){
    const piece = piece0.replace(/\s*(?:->|⇒|=>|〜>)\s*/g, '→');
    const chainRe = /[^\s、,，→]+(?:\s*→\s*[^\s、,，→]+)+/g; let cm;
    while ((cm = chainRe.exec(piece))){
      const parts = cm[0].split(/\s*→\s*/);
      // 先頭の要素に付いた日付と助詞(「11/14に仁川空港」→「仁川空港」)を外す
      let date = null; const head = parts[0]; let dm, last = null; DATE.lastIndex = 0;
      while ((dm = DATE.exec(head))) last = dm;
      if (last){ date = iso(Number(last[1]), Number(last[2])); parts[0] = head.slice(last.index + last[0].length).replace(/^\s*(?:は|に|の|、|:|：)\s*/, ''); }
      else { const before = piece.slice(0, cm.index); let bm; DATE.lastIndex = 0; while ((dm = DATE.exec(before))) bm = dm; if (bm) date = iso(Number(bm[1]), Number(bm[2])); }
      if (!date) continue;
      parts[parts.length-1] = parts[parts.length-1].replace(/(?:まで|へ|に|で|です)+$/, '');
      const pts = parts.map(x=>x.trim()).filter(Boolean); if (pts.length < 2) continue;
      const ap = pts.map((x,i)=>AIRPORT.test(x) ? i : -1).filter(i=>i >= 0);
      let startPlace = pts[0], endPlace = pts[pts.length-1];
      if (ap.length){
        const a0 = ap[0], a1 = ap[ap.length-1], n = pts.length;
        if (isHome(pts[0]) || (!isHome(pts[n-1]) && !JP_AIRPORT.test(pts[a1]))){ startPlace = pts[a1]; endPlace = pts[n-1]; }          // 渡航日: 現地の空港から
        else if (isHome(pts[n-1]) || !JP_AIRPORT.test(pts[a0])){ startPlace = a0 > 0 ? pts[0] : ''; endPlace = pts[a0]; }           // 帰国日: 現地の空港まで
      }
      const q = name => { for (const [re, v] of LOCAL_QUERY) if (re.test(name||'')) return v; return ''; };
      out.push({ date, travelOnly: true, startPlace: startPlace === endPlace ? '' : startPlace, endPlace, startQuery: q(startPlace), endQuery: q(endPlace), memo: pts.join('→') });
    }
  }
  return out;
}

async function assist(input){
  const rows = Array.isArray(input.rows) ? input.rows.slice(0,300) : [];
  const instruction = str(input.instruction).slice(0, 4000);
  if (!instruction){ const e = new Error('注文の文章がありません'); e.status=400; throw e; }
  const startDate = str(input.startDate), days = Math.min(60, Math.max(1, Math.floor(Number(input.days))||1));
  const dates = []; if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)){ const [y,m,d] = startDate.split('-').map(Number); for (let i=0;i<days;i++){ const t = new Date(Date.UTC(y, m-1, d+i)); dates.push(`${i+1}日目=${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`); } }
  const system = `あなたは営業担当の計画アシスタントです。訪問先リスト(各行に key があります)と、担当者の日本語の注文を受け取り、各行に反映すべき内容を JSON で返します。
期間: 開始日 ${startDate||'未定'}、${days}日間。日目と日付の対応: ${dates.join(', ')||'日付未定'}。「最終日」= ${days}日目 = ${dates.length?dates[dates.length-1].split('=')[1]:'未定'}、「初日」= 1日目。業務時間 ${str(input.workStart)||'09:00'}〜${str(input.workEnd)||'18:00'}。
返し方:
- updates: 変更が必要な行だけ。key は必ずリストの key をそのまま使う。date は YYYY-MM-DD(「2日目」「最終日」は上の対応表で日付に直す。指定がなければ省略)。timeFrom/timeTo は HH:MM(「午前」=09:00〜12:00、「午後」=13:00〜17:00、「15時以降」= timeFrom 15:00、「夕方」=16:00〜18:00 を目安)。checked は「回らない/除外」なら false、「必ず回る/これだけ回る」なら該当行 true・それ以外 false。stayMin は滞在時間の指定があるときだけ(分)。
- 会社名は表記ゆれ(漢字/ハングル/ローマ字、株式会社の有無、スペース)を考慮して対応づける。区分やエリア(「清州市内」「旅行会社だけ」など)への指示は、該当する全行に反映する。
- 期間の変更指示(「4日間にして」「10/20から」)があれば days / startDate を返す。「1日3件まで」のような1日の訪問数の上限は maxPerDay。
- 移動の日程(飛行機・電車・宿泊ホテル・出発地)の指示は dayPlans に、該当する日付ごとに1要素で返す:
  - travelOnly: その日が移動だけで訪問しない日(渡航日・帰国日・都市間の移動日)なら true。
  - startPlace: その日の現地での出発地(ホテル名・駅名・空港名など、原文の表記のまま)。endPlace: その日の帰着地・宿泊先。指示にある名前だけを書き、推測で埋めない。
  - startQuery / endQuery: startPlace / endPlace を地図で検索するための現地表記(韓国なら韓国語の正式名。例: 仁川空港 → 인천국제공항、イビスアンバサダーホテル明洞 → 이비스 앰배서더 서울 명동)。日本の場所は日本語のまま。
  - 「○○に泊まる」「ホテルはそこ」のように、ある日から同じ宿に連泊する指示は、その宿に泊まる各日の endPlace に同じ名前を入れる(翌日の出発地は自動で前日の宿になるので startPlace は不要)。
  - 渡航日(例: 山水荘→羽田→仁川空港→청주역)は travelOnly=true、startPlace=現地に着く空港(例: 仁川空港)、endPlace=到着後に向かう場所や宿(例: 청주역)、memo に経路全体を「→」区切りで書く(例: 山水荘→羽田→仁川空港→청주역)。
  - 帰国日(例: 仁川空港→羽田→山水荘)は travelOnly=true、startPlace は空(前日の宿から出る)、endPlace=現地で出国する空港(例: 仁川空港)、memo に経路全体を「→」区切りで。
  - 到着日の午後から訪問する場合など、その日の活動開始時刻が分かれば startTime(HH:MM)。
  - memo: その日の補足(便名・経路・注意)を短く。
- message: 何をどう反映したかを日本語で1〜2文。対応づけできなかった名前があればここに書く。`;
  const list = rows.map(r=>`key=${str(r.key)} | 会社=${str(r.company)} | 氏名=${str(r.name)} | 区分=${str(r.category)} | 住所=${str(r.address)} | 選択=${r.checked?'有':'無'} | 希望日=${str(r.date)} | 時間=${str(r.timeFrom)}〜${str(r.timeTo)}`).join('\n');
  const wantsDays = /ホテル|宿|泊|空港|羽田|成田|仁川|金浦|移動日|帰国|渡航|到着|フライト|飛行機|チェックイン|チェックアウト/.test(instruction);   // 移動・宿の指示が含まれていそうか
  const ask = ()=>gemini({ parts:[{ text:`【訪問先リスト】\n${list}\n\n【注文】\n${instruction}${wantsDays ? '\n\n(注文に移動・宿泊・到着/出発の指示が含まれています。該当する日付ごとに dayPlans を必ず返してください)' : ''}` }], system, schema: ASSIST_SCHEMA });
  let out = await ask();
  if (wantsDays && !(Array.isArray(out.dayPlans) && out.dayPlans.length)){ console.error('[ai] assist: dayPlans empty → retry'); const out2 = await ask(); if (Array.isArray(out2.dayPlans) && out2.dayPlans.length) out = out2; }   // 空で返る揺れがあるので1回取り直す
  const keys = new Set(rows.map(r=>str(r.key)));
  const updates = (Array.isArray(out.updates)?out.updates:[]).filter(u=>u && keys.has(str(u.key))).map(u=>{
    const o = { key: str(u.key) };
    if (u.date === null) o.date = '';                                   // 明示的な解除
    else if (/^\d{4}-\d{2}-\d{2}$/.test(str(u.date))) o.date = str(u.date); // 形式が不正なら項目ごと無視
    if (u.timeFrom === null) o.timeFrom = ''; else if (hhmm(u.timeFrom)) o.timeFrom = hhmm(u.timeFrom);
    if (u.timeTo === null) o.timeTo = ''; else if (hhmm(u.timeTo)) o.timeTo = hhmm(u.timeTo);
    if (typeof u.checked === 'boolean') o.checked = u.checked;
    if (Number(u.stayMin) > 0) o.stayMin = Number(u.stayMin);
    return o;
  });
  const res = { updates, message: str(out.message) };
  if (Math.floor(Number(out.days)) > 0) res.days = Math.min(60, Math.floor(Number(out.days)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(out.startDate))) res.startDate = out.startDate;
  if (Math.floor(Number(out.maxPerDay)) > 0) res.maxPerDay = Math.min(30, Math.floor(Number(out.maxPerDay)));
  const routes = parseRoutes(instruction, startDate, Array.isArray(input.homeNames) ? input.homeNames.map(str).slice(0,5) : []);
  res.dayPlans = (Array.isArray(out.dayPlans) ? out.dayPlans : []).filter(d=>d && /^\d{4}-\d{2}-\d{2}$/.test(str(d.date))).map(d=>({
    date: str(d.date), travelOnly: typeof d.travelOnly === 'boolean' ? d.travelOnly : undefined,
    startPlace: str(d.startPlace).slice(0,120), startQuery: str(d.startQuery).slice(0,120), endPlace: str(d.endPlace).slice(0,120), endQuery: str(d.endQuery).slice(0,120), startTime: hhmm(d.startTime), memo: str(d.memo).slice(0,300) }));
  // 矢印の経路は読み取り結果を優先して補う(AIが空で返したり、出発地・空港を入れ忘れたりするため)
  for (const r of routes){
    let d = res.dayPlans.find(x=>x.date === r.date);
    if (!d){ d = { date: r.date, startPlace:'', startQuery:'', endPlace:'', endQuery:'', startTime:'', memo:'' }; res.dayPlans.push(d); }
    d.travelOnly = true; d.memo = r.memo;
    if (r.startPlace){ d.startPlace = r.startPlace; d.startQuery = r.startQuery || (d.startPlace === r.startPlace ? d.startQuery : ''); }
    if (r.endPlace){ d.endPlace = r.endPlace; d.endQuery = r.endQuery || (d.endPlace === r.endPlace ? d.endQuery : ''); }
  }
  res.dayPlans.sort((a,b)=>a.date.localeCompare(b.date));
  return res;
}

/* おすすめの宿: 各日の最終訪問先・翌日の最初の訪問先の近くで、出張者向けのホテルを Google 検索付きで提案する(結果は候補。予約はしない) */
async function hotels(input){
  const days = (Array.isArray(input.days) ? input.days : []).slice(0, 14).map(d=>({ date:str(d.date), lastArea:str(d.lastArea).slice(0,200), nextArea:str(d.nextArea).slice(0,200), lastStops:str(d.lastStops).slice(0,300), fixed:str(d.fixed).slice(0,120) })).filter(d=>d.date);
  if (!days.length){ const e = new Error('対象の日がありません'); e.status=400; throw e; }
  const prefs = str(input.prefs).slice(0, 500);
  const system = `あなたは出張手配のアシスタントです。各日の訪問内容から、その夜に泊まるのに適したホテルをWeb検索で調べ、JSONだけを出力します(前置き・説明・コードブロック記号は不要)。
出力形式: {"days":[{"date":"YYYY-MM-DD","hotels":[{"name":"ホテル名(現地表記。韓国なら韓国語名も併記)","address":"住所(現地表記)","area":"エリア(駅名など)","priceHint":"1泊の目安(分かれば)","reason":"おすすめ理由(訪問先・翌日の出発地との位置関係、駐車場、朝食など)を日本語で1〜2文"}],"note":"補足"}],"note":"全体の補足"}
ルール:
- 1日につき2〜3件。その日の最終訪問先の近く、または翌日の最初の訪問先の近くで、車で回る出張者に向くビジネスホテル〜中級ホテルを優先。駐車場の有無が分かれば reason に書く。
- 「宿が決まっている」とある日は、その宿を1件目に入れ、理由に「指定済み」と書く。
- 実在が確認できるホテルだけ。推測でホテル名を作らない。見つからなければ hotels を空にし note に理由。
- 価格は目安で、通貨を付ける(例: 約9万ウォン、約12,000円)。${prefs?`\n希望: ${prefs}`:''}`;
  const list = days.map(d=>`${d.date}: 最終訪問先の周辺=${d.lastArea||'(訪問なし)'}${d.lastStops?`(${d.lastStops})`:''} / 翌日の最初の訪問先=${d.nextArea||'(なし)'}${d.fixed?` / 宿が決まっている: ${d.fixed}`:''}`).join('\n');
  const out = await gemini({ parts:[{ text:`次の各日について、泊まるのにおすすめのホテルを調べてください。\n${list}` }], system, tools:[{ google_search:{} }] });
  const dates = new Set(days.map(d=>d.date));
  const res = (Array.isArray(out.days) ? out.days : []).filter(d=>d && dates.has(str(d.date))).map(d=>({ date: str(d.date), note: str(d.note).slice(0,300),
    hotels: (Array.isArray(d.hotels) ? d.hotels : []).filter(x=>x && typeof x === 'object').slice(0,4).map(x=>({ name:str(x.name).slice(0,120), address:str(x.address).slice(0,200), area:str(x.area).slice(0,80), priceHint:str(x.priceHint).slice(0,60), reason:str(x.reason).slice(0,300) })).filter(x=>x.name) }));
  return { days: res, note: str(out.note).slice(0,300) };
}

/* 住所検索: 会社名(+地域ヒント)から所在地を Google 検索付きで調べる。結果は必ず「要確認」として扱う */
async function lookup(input){
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, 20).map(r=>({ key:str(r.key), company:str(r.company), name:str(r.name), hint:str(r.hint) })).filter(r=>r.company || r.name);
  if (!rows.length){ const e = new Error('調べる行がありません'); e.status=400; throw e; }
  const area = str(input.area);
  const system = `あなたは営業アシスタントです。会社・団体の所在地(住所)をWeb検索で調べ、JSONだけを出力します(前置き・説明・コードブロック記号は不要)。
出力形式: {"results":[{"key":"...","address":"見つかった住所(現地表記。日本なら日本語、韓国なら韓国語の道路名住所)","confidence":"high|medium|low","source":"根拠にしたサイト名やURL","note":"補足(同名企業が複数ある、支店の住所など)"}]}
ルール: 見つからなければ address を空にして confidence を low にする。推測で住所を作らない。本社と支店がある場合は、ヒントの地域に近い方を選ぶ。`;
  const list = rows.map(r=>`key=${r.key} | 会社=${r.company}${r.name?` | 担当=${r.name}`:''}${r.hint?` | ヒント=${r.hint}`:''}`).join('\n');
  const out = await gemini({ parts:[{ text:`${area?`対象地域のヒント: ${area}\n`:''}次の会社の住所を調べてください。\n${list}` }], system, tools:[{ google_search:{} }] });
  const keys = new Set(rows.map(r=>r.key));
  const results = (Array.isArray(out.results)?out.results:[]).filter(r=>r && keys.has(str(r.key))).map(r=>({ key:str(r.key), address:str(r.address), confidence:['high','medium','low'].includes(r.confidence)?r.confidence:'low', source:str(r.source), note:str(r.note) }));
  return { results };
}
function str(v){ return v === null || v === undefined ? '' : String(v).trim(); }
function hhmm(v){ const m = /^(\d{1,2}):(\d{2})/.exec(String(v||'')); if (!m) return ''; const hh = Number(m[1]), mm = Number(m[2]); if (hh > 23 || mm > 59) return ''; return `${String(hh).padStart(2,'0')}:${m[2]}`; }

/* server.js から呼ぶ: 処理できたら true、対象外なら false */
async function handle(req, res, url, { readBody, send }){
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || !['extract','assist','lookup','cards','hotels'].includes(parts[1])) return false;
  if (req.method !== 'POST'){ send(res, 405, { error:'method not allowed' }); return true; }
  const limit = (parts[1] === 'extract' || parts[1] === 'cards') ? MAX_FILE : 2*1024*1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit){ send(res, 413, { error: parts[1]==='extract' ? 'ファイルが大きすぎます(25MBまで)' : '送信データが大きすぎます' }); req.resume(); return true; }
  try {
    if (parts[1] === 'extract' || parts[1] === 'cards'){
      const buf = await readBody(req, MAX_FILE);
      let fname = ''; try { fname = decodeURIComponent(req.headers['x-file-name'] || ''); } catch(e){ fname = ''; }
      const out = parts[1] === 'extract' ? await extract(buf, req.headers['content-type'], fname) : await cards(buf, req.headers['content-type'], fname);
      send(res, 200, out);
    } else {
      let json; try { json = JSON.parse((await readBody(req, 2*1024*1024)).toString('utf8')); } catch(e){ send(res, 400, { error:'invalid json' }); return true; }
      send(res, 200, parts[1] === 'assist' ? await assist(json) : parts[1] === 'hotels' ? await hotels(json) : await lookup(json));
    }
  } catch(e){ console.error('[ai]', e.message); send(res, e.status || 500, { error: e.message || 'AI処理に失敗しました' }); }
  return true;
}
module.exports = { handle, extract, assist, lookup, cards, hotels, parseRoutes };
