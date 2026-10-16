#!/usr/bin/env node
/*
 * 営業サポート 同期サーバー(依存パッケージなし)
 *
 *   node server.js            → http://localhost:8765
 *   node server.js 9000       → ポートを変える
 *   PORT=9000 node server.js  → 同上
 *
 * 環境変数:
 *   DATA_DIR      … 保存先ディレクトリ(未指定なら ./data)。Cloud Run では GCS バケットを /data にマウントして指定
 *   AUTH_REQUIRED=1 … 名前+パスワードのログインを必須にする(auth.js。未設定ならローカル利用向けに認証なし)
 *   TRUST_PROXY=1 … リバースプロキシ(Cloud Run)配下: Secure クッキー、X-Forwarded-For を信頼
 *
 * 役割:
 *   - index.html / css / js をそのまま配信する
 *   - /api/data   … 構造化データ(JSON全体)の GET / PUT、/api/data/<collection> の PUT
 *   - /api/files  … 添付ファイル(名刺画像など)の GET / PUT / DELETE
 *   - 保存先はこのフォルダ内の data/(data.json, files.json, files/<id>)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AI = require('./ai');            // 写真/PDFの読み取り・AI注文(GEMINI_API_KEY 設定時のみ)

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const DATA_JSON = path.join(DATA_DIR, 'data.json');
const FILES_JSON = path.join(DATA_DIR, 'files.json');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const MAX_BODY = 200 * 1024 * 1024; // 200MB(添付の上限)
const COLS = ['customers','events','routes','hotels','cars','reports','groups'];
const Auth = require('./auth');        // 名前+パスワード認証(AUTH_REQUIRED=1 のとき有効)
const AUTH = Auth.enabled;
const BUILD = Date.now().toString(36); // 起動(デプロイ)ごとに変わる版番号
Auth.init(DATA_DIR);

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.webp':'image/webp', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
  '.md':'text/plain; charset=utf-8', '.pdf':'application/pdf', '.woff':'font/woff', '.woff2':'font/woff2'
};

/* ---------- 保存(同期的・アトミック) ---------- */
fs.mkdirSync(FILES_DIR, { recursive: true });

function readJson(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){ return fallback; }
}
function writeAtomic(file, data){
  // tmp → rename でアトミックに。gcsfuse 等で rename に失敗したら直接書く
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch(e){}
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch(e){ try { fs.unlinkSync(tmp); } catch(_){} fs.writeFileSync(file, data); }
}
function writeJsonAtomic(file, obj){ writeAtomic(file, JSON.stringify(obj, null, 1)); }

let data = readJson(DATA_JSON, null);           // { version, settings, data:{col:[...]}, updatedAt }
let filesMeta = readJson(FILES_JSON, {});       // { id: {id,name,type,size,linkedKind,linkedId,createdAt,updatedAt} }

function emptyData(){ const d = {}; COLS.forEach(c=>d[c]=[]); return { version:1, settings:{}, data:d, updatedAt:null }; }
function normalizeData(json){
  const out = emptyData();
  if (json && typeof json === 'object'){
    if (json.settings && typeof json.settings === 'object') out.settings = json.settings;
    const src = (json.data && typeof json.data === 'object') ? json.data : {};
    COLS.forEach(c=>{ out.data[c] = Array.isArray(src[c]) ? src[c] : []; });
  }
  return out;
}
function saveData(){
  data.updatedAt = new Date().toISOString();
  writeJsonAtomic(DATA_JSON, data);
}
function saveFilesMeta(){ writeJsonAtomic(FILES_JSON, filesMeta); }

/* ---------- HTTP ユーティリティ ---------- */
function send(res, status, body, headers={}){
  const h = Object.assign({ 'Cache-Control':'no-store' }, headers);
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)){
    body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (body === null || body === undefined) body = '';
  h['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, h);
  res.end(body);
}
function readBody(req, limit=MAX_BODY){
  return new Promise((resolve, reject)=>{
    const chunks = []; let size = 0;
    req.on('data', c=>{ size += c.length; if (size > limit){ reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function redirect(res, to){ res.writeHead(302, { 'Location': to, 'Cache-Control':'no-store' }); res.end(); }

/* ---------- API ---------- */
async function api(req, res, url){
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'data', ...]
  const kind = parts[1], sub = parts[2];

  if (kind === 'status' && req.method === 'GET'){
    return send(res, 200, { app:'sales-support', version:1, ai: !!process.env.GEMINI_API_KEY, auth: AUTH, user: AUTH ? Auth.publicUser(req.user) : null, updatedAt: data ? data.updatedAt : null, files: Object.keys(filesMeta).length });
  }

  if (kind === 'data'){
    if (req.method === 'GET' && !sub){
      if (!data) return send(res, 200, Object.assign(emptyData(), { empty:true }));
      return send(res, 200, Object.assign({}, data, { empty:false }));
    }
    if (req.method === 'PUT' && !sub){
      let json; try { json = JSON.parse((await readBody(req)).toString('utf8')); } catch(e){ return send(res, 400, {error:'invalid json'}); }
      if (!json || typeof json !== 'object' || Array.isArray(json) || !json.data || typeof json.data !== 'object') return send(res, 400, {error:'body must be {settings, data}'});
      data = normalizeData(json);
      saveData();
      return send(res, 200, { ok:true, updatedAt: data.updatedAt });
    }
    if (req.method === 'PUT' && sub && (COLS.includes(sub) || sub === 'settings')){
      let json; try { json = JSON.parse((await readBody(req)).toString('utf8')); } catch(e){ return send(res, 400, {error:'invalid json'}); }
      if (!data) data = emptyData();
      if (sub === 'settings'){ if (!json || typeof json !== 'object' || Array.isArray(json)) return send(res, 400, {error:'settings must be object'}); data.settings = json; }
      else { if (!Array.isArray(json)) return send(res, 400, {error:'collection must be array'}); data.data[sub] = json; }
      saveData();
      return send(res, 200, { ok:true, updatedAt: data.updatedAt });
    }
    if (req.method === 'PATCH' && sub && COLS.includes(sub)){
      // レコード単位の更新: {upsert:[{id,...}], delete:[id]}。同じ id は後に届いた方が勝つ
      let json; try { json = JSON.parse((await readBody(req)).toString('utf8')); } catch(e){ return send(res, 400, {error:'invalid json'}); }
      if (!json || typeof json !== 'object' || Array.isArray(json)) return send(res, 400, {error:'body must be {upsert, delete}'});
      const upsert = Array.isArray(json.upsert) ? json.upsert : [], del = Array.isArray(json.delete) ? json.delete : [];
      if (!data) data = emptyData();
      const map = new Map(data.data[sub].filter(x=>x && x.id).map(x=>[x.id, x]));
      let n = 0;
      upsert.forEach(x=>{ if (x && typeof x === 'object' && typeof x.id === 'string'){ map.set(x.id, x); n++; } });
      del.forEach(id=>{ if (typeof id === 'string' && map.delete(id)) n++; });
      data.data[sub] = Array.from(map.values());
      saveData();
      return send(res, 200, { ok:true, applied:n, updatedAt: data.updatedAt });
    }
    return send(res, 405, {error:'method not allowed'});
  }

  if (kind === 'files'){
    if (req.method === 'GET' && !sub) return send(res, 200, Object.values(filesMeta));
    if (sub && !ID_RE.test(sub)) return send(res, 400, {error:'bad id'});
    const file = sub ? path.join(FILES_DIR, sub) : null;
    if (req.method === 'GET' && sub){
      const meta = filesMeta[sub];
      if (!meta || !fs.existsSync(file)) return send(res, 404, {error:'not found'});
      const buf = fs.readFileSync(file);
      return send(res, 200, buf, { 'Content-Type': meta.type || 'application/octet-stream', 'X-File-Meta': encodeURIComponent(JSON.stringify(meta)) });
    }
    if (req.method === 'PUT' && sub){
      let meta = {};
      try { meta = JSON.parse(decodeURIComponent(req.headers['x-file-meta'] || '{}')); } catch(e){ return send(res, 400, {error:'bad meta'}); }
      let buf; try { buf = await readBody(req); } catch(e){ return send(res, 413, {error:'too large'}); }
      const prev = filesMeta[sub] || {};
      const hasBody = buf.length > 0 || !fs.existsSync(file);
      if (hasBody) writeAtomic(file, buf);
      const size = fs.statSync(file).size;
      filesMeta[sub] = Object.assign({}, prev, meta, { id: sub, size, type: meta.type || prev.type || req.headers['content-type'] || 'application/octet-stream',
        createdAt: meta.createdAt || prev.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
      delete filesMeta[sub].blob;
      saveFilesMeta();
      return send(res, 200, { ok:true, meta: filesMeta[sub] });
    }
    if (req.method === 'DELETE' && sub){
      delete filesMeta[sub];
      try { fs.unlinkSync(file); } catch(e){}
      saveFilesMeta();
      return send(res, 200, { ok:true });
    }
    return send(res, 405, {error:'method not allowed'});
  }
  return send(res, 404, {error:'not found'});
}

/* ---------- 静的ファイル ---------- */
function serveStatic(req, res, url){
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  let p; try { p = decodeURIComponent(url.pathname); } catch(e){ return send(res, 400, 'bad request'); }
  if (p === '/' || p === '') p = '/index.html';
  if (p.includes('\0')) return send(res, 400, 'bad request');
  const abs = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, 'forbidden');
  // 配信するのは画面に必要なファイルだけ(data/・.git/・server.js・Dockerfile などは大文字小文字を問わず拒否)
  const segs = rel.split(path.sep);
  const top = segs[0].toLowerCase();
  const allowedTop = segs.length === 1 ? ['index.html','readme.md','design.md'] : ['css','js'];
  if (!allowedTop.includes(top) || segs.some(sg=>sg.startsWith('.'))) return send(res, 403, 'forbidden');
  if (segs.length > 1 && !/\.(css|js|json|png|jpg|jpeg|gif|svg|webp|ico|woff2?|txt)$/i.test(segs[segs.length-1])) return send(res, 403, 'forbidden');
  fs.stat(abs, (err, st)=>{
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    if (p === '/index.html'){
      // デプロイごとに変わる版番号を JS/CSS の URL に付け、古いファイルがブラウザに残らないようにする
      let html; try { html = fs.readFileSync(abs, 'utf8'); } catch(e){ return send(res, 500, 'read error'); }
      html = html.replace(/(src|href)="(js\/[^"]+\.js|css\/[^"]+\.css)"/g, (m, attr, file)=>`${attr}="${file}?v=${BUILD}"`);
      const buf = Buffer.from(html);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control':'no-cache' });
      return req.method === 'HEAD' ? res.end() : res.end(buf);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control':'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res)=>{
  (async()=>{
    let url; try { url = new URL(req.url, 'http://localhost'); } catch(e){ return send(res, 400, 'bad request'); }
    if (AUTH){
      if (await Auth.handleRoutes(req, res, url, { readBody, send, redirect })) return;
      const user = Auth.authenticate(req);
      if (!user){
        if (url.pathname.startsWith('/api/')) return send(res, 401, { error:'unauthorized', login:'/login' });
        if (url.pathname === '/css/app.css') return serveStatic(req, res, url); // ログイン画面用
        return redirect(res, Auth.usersCount() ? '/login' : '/setup');
      }
      req.user = user;
    } else req.user = Auth.authenticate(req);
    if (url.pathname.startsWith('/api/')){
      if (await Auth.handleApi(req, res, url, { readBody, send })) return;
      if (await AI.handle(req, res, url, { readBody, send })) return;
      return api(req, res, url);
    }
    return serveStatic(req, res, url);
  })().catch(e=>{ console.error(e); try { send(res, 500, {error: String(e && e.message || e)}); } catch(_){} });
});

server.on('error', (e)=>{
  if (e.code === 'EADDRINUSE'){
    console.error(`\nポート ${PORT} はすでに使われています。別のポートで起動してください: node server.js ${PORT+1}\n`);
  } else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', ()=>{
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list){ if (i.family === 'IPv4' && !i.internal) ips.push(i.address); }
  console.log('');
  console.log('営業サポート サーバーを起動しました。止めるときは Ctrl+C');
  console.log(`  このMacで開く:          http://localhost:${PORT}`);
  ips.forEach(ip=> console.log(`  同じWi-Fiのスマホから:  http://${ip}:${PORT}`));
  console.log(`  データの保存先:          ${DATA_DIR}`);
  console.log(`  ログイン:                ${AUTH ? '必須(名前+パスワード、AUTH_REQUIRED=1)' : 'なし(AUTH_REQUIRED 未設定)'}`);
  console.log('');
});
