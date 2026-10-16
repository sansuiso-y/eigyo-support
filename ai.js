/*
 * AI 機能(Gemini API)— 営業計画ページ用
 *   POST /api/extract  … 写真・PDF の訪問先リストを表(JSON)に読み取る
 *   POST /api/assist   … 「どこをいつ回りたいか」の日本語の注文を、行ごとの希望日・時間帯に変換する
 *   POST /api/lookup   … 会社名から所在地を Google 検索付きで調べる(要確認として扱う)
 *   POST /api/cards    … 名刺の写真(1枚に複数枚写っていてもよい)を読み取り、顧客の項目にする
 * 環境変数 GEMINI_API_KEY が必要(他の社内アプリと共用)。未設定なら 503 を返す。
 */
'use strict';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash,gemini-2.5-flash').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_FILE = 25 * 1024 * 1024;

async function gemini({ parts, system, schema, tools }){
  const key = process.env.GEMINI_API_KEY;
  if (!key){ const e = new Error('AI機能はクラウド版でのみ使えます(GEMINI_API_KEY 未設定)'); e.status = 503; throw e; }
  let lastErr = null;
  for (const model of MODELS){
    const body = { contents:[{ role:'user', parts }], generationConfig:{ maxOutputTokens: 16000, temperature: 0.1, responseMimeType:'application/json', ...(schema ? { responseSchema: schema } : {}) } };
    if (system) body.systemInstruction = { parts:[{ text: system }] };
    if (tools){ body.tools = tools; delete body.generationConfig.responseMimeType; delete body.generationConfig.responseSchema; } // 検索ツール併用時はJSONモード不可
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 90000);
    let res;
    try { res = await fetch(`${BASE}/models/${model}:generateContent`, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctl.signal }); }
    catch(err){ clearTimeout(timer); lastErr = new Error(err.name==='AbortError' ? 'AIの応答が時間内に返りませんでした' : 'AIに接続できませんでした'); lastErr.status = 504; continue; }
    clearTimeout(timer);
    if (res.status === 404 || res.status >= 500){ lastErr = new Error(res.status===404 ? `モデル ${model} が見つかりません` : `AIが混み合っています (${res.status})`); lastErr.status = 502; continue; } // 次のモデルへ
    if (!res.ok){
      let detail=''; try { detail = (await res.json()).error?.message || ''; } catch(e){}
      const e = new Error(res.status===429 ? 'AIの利用上限に達しました。少し待ってからお試しください' : `AIエラー (${res.status}) ${detail}`.trim()); e.status = res.status===429?429:502; throw e;
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
    const finish = data.candidates?.[0]?.finishReason || '';
    if (!text){ const e = new Error('AIの応答が空でした (' + (finish || data.promptFeedback?.blockReason || '不明') + ')'); e.status = 502; throw e; }
    const parsed = parseJson(text);
    if (parsed) return parsed;
    const e = new Error(finish === 'MAX_TOKENS' ? '資料が長すぎてAIの応答が途中で切れました。ページを分けて取り込んでください' : 'AIの応答を解釈できませんでした'); e.status = 502; throw e;
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
  note:{type:'STRING'} }, required:['rows'] };

async function extract(buffer, mime, fileName){
  if (!buffer || !buffer.length){ const e = new Error('ファイルが空です'); e.status=400; throw e; }
  if (buffer.length > MAX_FILE){ const e = new Error('ファイルが大きすぎます(25MBまで)'); e.status=413; throw e; }
  let mimeType = (mime||'').split(';')[0].trim().toLowerCase();
  const ext = (fileName||'').split('.').pop().toLowerCase();
  if (!mimeType || mimeType==='application/octet-stream'){ mimeType = ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',pdf:'application/pdf',gif:'image/gif'})[ext] || 'image/jpeg'; }
  const system = `あなたは営業アシスタントです。渡された画像やPDFに含まれる「会社・団体・人物の一覧」を読み取り、営業訪問先リストとしてJSONにします。
ルール:
- 1人(または1社)につき1行。company(会社名・団体名)、name(氏名。原文の表記をそのまま。ローマ字併記があれば「原文 (ローマ字)」)、title(役職)、category(区分: 旅行会社 / 法人 / 自治体・関係機関 / メディア / 団体 / その他 のいずれか。表に区分があればそれに従う)、phone(電話番号)、address(住所。書いてあるものだけ。推測しない)、memo(備考欄などの補足)。
- パスポート番号・生年月日・性別・部屋番号・個人のメールアドレスは読み取らず、どの項目にも入れない。
- 同じ会社の人が複数いても、それぞれ1行にする。
- 読み取れない項目は空文字にする。表以外の説明文は rows に含めない。note に、読み取りで気になった点(かすれ・不明瞭など)を日本語で短く書く(なければ空)。`;
  const parts = [ { inlineData:{ mimeType, data: buffer.toString('base64') } }, { text:'この資料の一覧を読み取って、rows の配列にしてください。' } ];
  const out = await gemini({ parts, system, schema: ROW_SCHEMA });
  const rows = (Array.isArray(out.rows) ? out.rows : []).map(r=>({
    company: str(r.company), name: str(r.name), title: str(r.title), category: str(r.category), phone: str(r.phone), address: str(r.address), memo: str(r.memo)
  })).filter(r=>r.company || r.name);
  return { rows, note: str(out.note) };
}


const CARD_SCHEMA = { type:'OBJECT', properties:{ cards:{ type:'ARRAY', items:{ type:'OBJECT', properties:{
  company:{type:'STRING'}, department:{type:'STRING'}, name:{type:'STRING'}, nameKana:{type:'STRING'}, title:{type:'STRING'}, phone:{type:'STRING'}, mobile:{type:'STRING'}, fax:{type:'STRING'},
  email:{type:'STRING'}, zip:{type:'STRING'}, address:{type:'STRING'}, website:{type:'STRING'}, memo:{type:'STRING'},
  box_2d:{ type:'ARRAY', items:{type:'INTEGER'}, description:'名刺の位置 [ymin, xmin, ymax, xmax](画像全体を0〜1000とした正規化座標)' } } } }, note:{type:'STRING'} }, required:['cards'] };

/* 名刺画像 → 顧客の項目。1枚の写真に複数の名刺が写っていれば複数返す */
async function cards(buffer, mime, fileName){
  if (!buffer || !buffer.length){ const e = new Error('ファイルが空です'); e.status=400; throw e; }
  if (buffer.length > MAX_FILE){ const e = new Error('ファイルが大きすぎます(25MBまで)'); e.status=413; throw e; }
  let mimeType = (mime||'').split(';')[0].trim().toLowerCase();
  const ext = (fileName||'').split('.').pop().toLowerCase();
  if (!mimeType || mimeType==='application/octet-stream'){ mimeType = ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',pdf:'application/pdf',gif:'image/gif'})[ext] || 'image/jpeg'; }
  const system = `あなたは営業アシスタントです。名刺の写真を読み取り、顧客台帳の項目としてJSONにします。
ルール:
- 写真に写っている名刺1枚につき cards の1要素。複数枚写っていれば複数。名刺が写っていなければ cards は空。
- company(会社名。「株式会社」などの法人格は名刺の表記どおり)、department(部署)、name(氏名。名刺の表記どおり。姓と名の間は半角スペース1つ)、nameKana(ふりがな/ローマ字があれば)、title(役職)、phone(代表/直通の固定電話)、mobile(携帯)、fax、email、zip(郵便番号 123-4567 形式)、address(住所。郵便番号は含めない。ビル名・階まで)、website、memo(名刺にあるその他の情報: 支店名・資格・SNS など短く)。
- 読めない項目は空文字。推測で埋めない。裏面(英語面)しか無い場合は英語表記のまま入れる。
- 電話番号は 03-1234-5678 / 090-1234-5678 のようにハイフン区切りに整える。
- box_2d: その名刺が写っている範囲を [ymin, xmin, ymax, xmax] の4整数で返す(画像の上端=0・下端=1000、左端=0・右端=1000 の正規化座標)。名刺の四隅がぴったり収まる範囲。
- note: 読み取りで気になった点(ピンぼけ・切れている など)を日本語で短く(なければ空)。`;
  const parts = [ { inlineData:{ mimeType, data: buffer.toString('base64') } }, { text:'この写真の名刺を読み取って cards にしてください。各名刺の box_2d も必ず返してください。' } ];
  const out = await gemini({ parts, system, schema: CARD_SCHEMA });
  const list = (Array.isArray(out.cards) ? out.cards : []).map(c=>({
    company:str(c.company), department:str(c.department), name:str(c.name), nameKana:str(c.nameKana), title:str(c.title), phone:str(c.phone), mobile:str(c.mobile), fax:str(c.fax),
    email:str(c.email), zip:str(c.zip), address:str(c.address), website:str(c.website), memo:str(c.memo),
    box: Array.isArray(c.box_2d) && c.box_2d.length === 4 && c.box_2d.every(n=>Number.isFinite(Number(n))) ? c.box_2d.map(n=>Math.max(0, Math.min(1000, Math.round(Number(n))))) : null
  })).filter(c=>c.company || c.name);
  return { cards: list, note: str(out.note) };
}

const ASSIST_SCHEMA = { type:'OBJECT', properties:{
  updates:{ type:'ARRAY', items:{ type:'OBJECT', properties:{ key:{type:'STRING'}, date:{type:'STRING'}, timeFrom:{type:'STRING'}, timeTo:{type:'STRING'}, checked:{type:'BOOLEAN'}, stayMin:{type:'INTEGER'}, reason:{type:'STRING'} }, required:['key'] } },
  days:{type:'INTEGER'}, startDate:{type:'STRING'}, message:{type:'STRING'} }, required:['updates','message'] };

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
- 期間の変更指示(「4日間にして」「10/20から」)があれば days / startDate を返す。
- message: 何をどう反映したかを日本語で1〜2文。対応づけできなかった名前があればここに書く。`;
  const list = rows.map(r=>`key=${str(r.key)} | 会社=${str(r.company)} | 氏名=${str(r.name)} | 区分=${str(r.category)} | 住所=${str(r.address)} | 選択=${r.checked?'有':'無'} | 希望日=${str(r.date)} | 時間=${str(r.timeFrom)}〜${str(r.timeTo)}`).join('\n');
  const out = await gemini({ parts:[{ text:`【訪問先リスト】\n${list}\n\n【注文】\n${instruction}` }], system, schema: ASSIST_SCHEMA });
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
  return res;
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
  if (parts[0] !== 'api' || !['extract','assist','lookup','cards'].includes(parts[1])) return false;
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
      send(res, 200, parts[1] === 'assist' ? await assist(json) : await lookup(json));
    }
  } catch(e){ console.error('[ai]', e.message); send(res, e.status || 500, { error: e.message || 'AI処理に失敗しました' }); }
  return true;
}
module.exports = { handle, extract, assist, lookup, cards };
