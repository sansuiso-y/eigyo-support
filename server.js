#!/usr/bin/env node
/*
 * 営業サポート 同期サーバー(依存パッケージなし)
 *
 *   node server.js            → http://localhost:8765
 *   node server.js 9000       → ポートを変える
 *   PORT=9000 node server.js  → 同上
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

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DATA_JSON = path.join(DATA_DIR, 'data.json');
const FILES_JSON = path.join(DATA_DIR, 'files.json');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const MAX_BODY = 200 * 1024 * 1024; // 200MB(添付の上限)
const COLS = ['customers','events','routes','hotels','cars','reports','groups'];

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
function writeJsonAtomic(file, obj){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

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

/* ---------- API ---------- */
async function api(req, res, url){
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'data', ...]
  const kind = parts[1], sub = parts[2];

  if (kind === 'status' && req.method === 'GET'){
    return send(res, 200, { app:'sales-support', version:1, updatedAt: data ? data.updatedAt : null, files: Object.keys(filesMeta).length });
  }

  if (kind === 'data'){
    if (req.method === 'GET' && !sub){
      if (!data) return send(res, 200, Object.assign(emptyData(), { empty:true }));
      return send(res, 200, Object.assign({}, data, { empty:false }));
    }
    if (req.method === 'PUT' && !sub){
      let json; try { json = JSON.parse((await readBody(req)).toString('utf8')); } catch(e){ return send(res, 400, {error:'invalid json'}); }
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
      if (hasBody){ fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file); }
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
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const abs = path.normalize(path.join(ROOT, p));
  if (!abs.startsWith(ROOT + path.sep) || abs.startsWith(DATA_DIR) || abs === path.join(ROOT, 'server.js')) return send(res, 403, 'forbidden');
  fs.stat(abs, (err, st)=>{
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control':'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res)=>{
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')){
    api(req, res, url).catch(e=>{ console.error(e); try { send(res, 500, {error: String(e && e.message || e)}); } catch(_){} });
  } else serveStatic(req, res, url);
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
  console.log('');
});
