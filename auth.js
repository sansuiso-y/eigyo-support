/*
 * 認証(名前+パスワード)— 営業サポート
 *   有効化: 環境変数 AUTH_REQUIRED=1(クラウド版)。未設定なら認証なし(Mac での起動.command 向け)
 *   ユーザー: DATA_DIR/users.json に保存(パスワードは scrypt ハッシュ)
 *   初期設定: ユーザーが0人のとき GET /login が「管理者の作成」画面になる。SETUP_CODE が設定されていればその入力が必要
 *   セッション: 署名付きクッキー(鍵は SESSION_SECRET、無ければ DATA_DIR/session-secret を自動生成)
 *   API: GET /api/me, POST /api/me/password, (管理者) GET/POST /api/users, PUT/DELETE /api/users/:id
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const enabled = process.env.AUTH_REQUIRED === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SETUP_CODE = process.env.SETUP_CODE || '';
const COOKIE = 'sales_session';
const COOKIE_DAYS = 30;
const NAME_RE = /^[A-Za-z0-9._-]{2,32}$/;

let dataDir = null, usersFile = null, secret = null;
let store = { users: [] };

function init(dir){
  dataDir = dir; usersFile = path.join(dir, 'users.json');
  try { const j = JSON.parse(fs.readFileSync(usersFile, 'utf8')); if (j && Array.isArray(j.users)) store = j; } catch(e){ store = { users: [] }; }
  if (process.env.SESSION_SECRET) secret = Buffer.from(String(process.env.SESSION_SECRET));
  else {
    const f = path.join(dir, 'session-secret');
    try { secret = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); if (secret.length < 16) throw new Error('short'); }
    catch(e){ secret = crypto.randomBytes(32); try { fs.mkdirSync(dir, { recursive:true }); fs.writeFileSync(f, secret.toString('hex')); } catch(err){ console.error('session-secret を保存できませんでした:', err.message); } }
  }
}
function saveUsers(){
  const tmp = usersFile + '.tmp'; const data = JSON.stringify(store, null, 1);
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, usersFile); } catch(e){ try { fs.unlinkSync(tmp); } catch(_){} fs.writeFileSync(usersFile, data); }
}
const publicUser = u => u ? ({ id:u.id, name:u.name, displayName:u.displayName||u.name, role:u.role||'member', createdAt:u.createdAt, lastLoginAt:u.lastLoginAt||null }) : null;
function hashPassword(pw, salt){ return crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function verifyPassword(u, pw){
  if (!u || !u.salt || !u.hash) return false;
  const a = Buffer.from(hashPassword(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validPassword(pw){ return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128; }
function findByName(name){ const n = String(name||'').trim().toLowerCase(); return store.users.find(u=>u.name.toLowerCase()===n) || null; }
function createUser({ name, displayName, password, role }){
  name = String(name||'').trim();
  if (!NAME_RE.test(name)) throw httpError(400, 'ログイン名は半角英数字と . _ - で2〜32文字にしてください');
  if (findByName(name)) throw httpError(409, 'そのログイン名は既に使われています');
  if (!validPassword(password)) throw httpError(400, 'パスワードは8文字以上にしてください');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomBytes(8).toString('hex'), name, displayName: String(displayName||'').trim() || name, role: role === 'admin' ? 'admin' : 'member', salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.users.push(u); saveUsers(); return u;
}
function httpError(status, message){ const e = new Error(message); e.status = status; return e; }

/* ---------- セッションクッキー ---------- */
function sign(s){ return crypto.createHmac('sha256', secret).update(s).digest('hex'); }
function makeToken(u){ const exp = Date.now() + COOKIE_DAYS*86400000; const p = `${u.id}.${exp}`; return `${p}.${sign(p)}`; }
function cookieHeader(value, maxAge){ return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (TRUST_PROXY ? '; Secure' : ''); }
function parseCookies(req){
  const out = {};
  (req.headers.cookie || '').split(';').forEach(kv=>{ const i = kv.indexOf('='); if (i>0){ try { out[kv.slice(0,i).trim()] = decodeURIComponent(kv.slice(i+1).trim()); } catch(e){} } });
  return out;
}
function authenticate(req){
  if (!enabled) return { id:'local', name:'local', displayName:'', role:'admin', local:true };
  const tok = parseCookies(req)[COOKIE] || '';
  const parts = tok.split('.'); if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expect = sign(`${id}.${exp}`);
  const a = Buffer.from(expect), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const u = store.users.find(x=>x.id===id); return u || null;
}
function clientIp(req){
  if (TRUST_PROXY){ const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
  return req.socket.remoteAddress || '';
}
const fails = new Map(); // ip → {count, until}
function failWait(ip){ const f = fails.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until-Date.now())/1000) : 0; }
function noteFail(ip){ const n = ((fails.get(ip)||{}).count||0) + 1; fails.set(ip, { count:n, until: n >= 3 ? Date.now() + Math.min((n-2)*5, 120)*1000 : 0 }); } // 3回目から待ち時間(5秒→最大2分)

/* ---------- 画面 ---------- */
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title, body){
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} | 営業サポート</title><link rel="stylesheet" href="/css/app.css">
<style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
.login{width:100%;max-width:380px}.login h1{font-size:1.3rem;margin:0 0 4px}.login p{margin:0 0 14px}.login label{display:block;font-size:.82rem;color:var(--muted);font-weight:600;margin:10px 0 4px}
.login input{width:100%;box-sizing:border-box;font-size:1.05rem;padding:11px}.login .btn{width:100%;margin-top:16px;font-size:1.05rem;padding:12px}
.err{color:var(--danger,#d33b3b);font-weight:600;margin:10px 0 0}</style></head><body>${body}</body></html>`;
}
function loginPage(msg='', name=''){
  return page('ログイン', `<form class="card login" method="post" action="/login"><h1>営業サポート</h1><p class="small muted">名前とパスワードでログイン</p>
<label>ログイン名</label><input type="text" name="name" value="${esc(name)}" autocomplete="username" autocapitalize="off" autofocus required>
<label>パスワード</label><input type="password" name="password" autocomplete="current-password" required>
${msg ? `<div class="err">${esc(msg)}</div>` : ''}<button class="btn primary" type="submit">ログイン</button></form>`);
}
function setupPage(msg=''){
  return page('初期設定', `<form class="card login" method="post" action="/setup"><h1>はじめての設定</h1><p class="small muted">まだ利用者が登録されていません。最初の管理者を作成してください。管理者は設定画面でメンバーを追加できます。</p>
${SETUP_CODE ? '<label>初期設定コード</label><input type="password" name="code" autocomplete="off" required placeholder="管理者から受け取ったコード">' : ''}
<label>ログイン名(半角英数字)</label><input type="text" name="name" autocomplete="username" autocapitalize="off" required placeholder="例: takahashi">
<label>表示名</label><input type="text" name="displayName" required placeholder="例: 高橋 圭">
<label>パスワード(8文字以上)</label><input type="password" name="password" autocomplete="new-password" required minlength="8">
<label>パスワード(確認)</label><input type="password" name="password2" autocomplete="new-password" required minlength="8">
${msg ? `<div class="err">${esc(msg)}</div>` : ''}<button class="btn primary" type="submit">管理者を作成してはじめる</button></form>`);
}
const HTML = { 'Content-Type':'text/html; charset=utf-8' };

async function form(req, readBody){ try { return new URLSearchParams((await readBody(req, 64*1024)).toString('utf8')); } catch(e){ return new URLSearchParams(); } }

/* /login /setup /logout を処理。処理したら true、対象外なら false */
async function handleRoutes(req, res, url, { readBody, send, redirect }){
  if (!enabled) return false;
  if (url.pathname === '/login'){
    if (!store.users.length) return redirect(res, '/setup'), true;
    if (req.method === 'GET'){ if (authenticate(req)) return redirect(res, '/'), true; send(res, 200, loginPage(), HTML); return true; }
    if (req.method === 'POST'){
      const ip = clientIp(req); const wait = failWait(ip);
      if (wait) { send(res, 429, loginPage(`連続して失敗したため、${wait}秒待ってからやり直してください`), HTML); return true; }
      const f = await form(req, readBody); const name = (f.get('name')||'').trim(), pw = f.get('password')||'';
      const u = findByName(name);
      if (u && verifyPassword(u, pw)){
        fails.delete(ip); u.lastLoginAt = new Date().toISOString(); saveUsers();
        res.writeHead(303, { 'Location':'/', 'Set-Cookie': cookieHeader(makeToken(u), COOKIE_DAYS*86400), 'Cache-Control':'no-store' }); res.end(); return true;
      }
      noteFail(ip); send(res, 401, loginPage('ログイン名またはパスワードが違います', name), HTML); return true;
    }
    send(res, 405, 'method not allowed'); return true;
  }
  if (url.pathname === '/setup'){
    if (store.users.length){ redirect(res, '/login'); return true; }
    if (req.method === 'GET'){ send(res, 200, setupPage(), HTML); return true; }
    if (req.method === 'POST'){
      const ip = clientIp(req); const wait = failWait(ip);
      if (wait) { send(res, 429, setupPage(`連続して失敗したため、${wait}秒待ってからやり直してください`), HTML); return true; }
      const f = await form(req, readBody);
      if (SETUP_CODE){ const code = f.get('code')||''; const a = crypto.createHash('sha256').update(code).digest(), b = crypto.createHash('sha256').update(SETUP_CODE).digest(); if (!crypto.timingSafeEqual(a,b)){ noteFail(ip); send(res, 401, setupPage('初期設定コードが違います'), HTML); return true; } }
      if ((f.get('password')||'') !== (f.get('password2')||'')){ send(res, 400, setupPage('パスワード(確認)が一致しません'), HTML); return true; }
      try {
        if (store.users.length){ redirect(res, '/login'); return true; }
        const u = createUser({ name:f.get('name'), displayName:f.get('displayName'), password:f.get('password'), role:'admin' });
        u.lastLoginAt = new Date().toISOString(); saveUsers();
        res.writeHead(303, { 'Location':'/', 'Set-Cookie': cookieHeader(makeToken(u), COOKIE_DAYS*86400), 'Cache-Control':'no-store' }); res.end(); return true;
      } catch(e){ send(res, e.status||400, setupPage(e.message), HTML); return true; }
    }
    send(res, 405, 'method not allowed'); return true;
  }
  if (url.pathname === '/logout'){
    res.writeHead(302, { 'Location':'/login', 'Set-Cookie': cookieHeader('', 0), 'Cache-Control':'no-store' }); res.end(); return true;
  }
  return false;
}

/* /api/me, /api/users … 処理したら true */
async function handleApi(req, res, url, { readBody, send }){
  const parts = url.pathname.split('/').filter(Boolean); // ['api','me'] / ['api','users',id]
  if (parts[0] !== 'api' || !['me','users'].includes(parts[1])) return false;
  const me = req.user;
  const json = async()=>{ try { return JSON.parse((await readBody(req, 64*1024)).toString('utf8')); } catch(e){ throw httpError(400, 'invalid json'); } };
  try {
    if (parts[1] === 'me'){
      if (!parts[2] && req.method === 'GET'){ send(res, 200, { enabled, user: publicUser(me), usersCount: store.users.length }); return true; }
      if (parts[2] === 'password' && req.method === 'POST'){
        if (!enabled) throw httpError(400, 'ローカル版では認証を使っていません');
        const b = await json();
        if (!verifyPassword(me, b.current||'')) throw httpError(401, '現在のパスワードが違います');
        if (!validPassword(b.next)) throw httpError(400, 'パスワードは8文字以上にしてください');
        me.salt = crypto.randomBytes(16).toString('hex'); me.hash = hashPassword(b.next, me.salt); me.updatedAt = new Date().toISOString(); saveUsers();
        send(res, 200, { ok:true }); return true;
      }
      throw httpError(405, 'method not allowed');
    }
    // /api/users (管理者のみ)
    if (!enabled) throw httpError(400, 'ローカル版では認証を使っていません');
    if (!me || me.role !== 'admin') throw httpError(403, '管理者のみ操作できます');
    const id = parts[2];
    if (!id && req.method === 'GET'){ send(res, 200, { users: store.users.map(publicUser) }); return true; }
    if (!id && req.method === 'POST'){ const b = await json(); const u = createUser({ name:b.name, displayName:b.displayName, password:b.password, role:b.role }); send(res, 201, { user: publicUser(u) }); return true; }
    const target = store.users.find(u=>u.id===id); if (!target) throw httpError(404, 'ユーザーが見つかりません');
    if (req.method === 'PUT'){
      const b = await json();
      if (b.displayName !== undefined){ const d = String(b.displayName||'').trim(); if (!d) throw httpError(400, '表示名を入力してください'); target.displayName = d; }
      if (b.role !== undefined){ const r = b.role === 'admin' ? 'admin' : 'member'; if (target.role === 'admin' && r !== 'admin' && store.users.filter(u=>u.role==='admin').length <= 1) throw httpError(400, '管理者が0人になるため変更できません'); target.role = r; }
      if (b.password !== undefined){ if (!validPassword(b.password)) throw httpError(400, 'パスワードは8文字以上にしてください'); target.salt = crypto.randomBytes(16).toString('hex'); target.hash = hashPassword(b.password, target.salt); }
      target.updatedAt = new Date().toISOString(); saveUsers(); send(res, 200, { user: publicUser(target) }); return true;
    }
    if (req.method === 'DELETE'){
      if (target.id === me.id) throw httpError(400, '自分自身は削除できません');
      if (target.role === 'admin' && store.users.filter(u=>u.role==='admin').length <= 1) throw httpError(400, '最後の管理者は削除できません');
      store.users = store.users.filter(u=>u.id!==id); saveUsers(); send(res, 200, { ok:true }); return true;
    }
    throw httpError(405, 'method not allowed');
  } catch(e){ send(res, e.status||500, { error: e.message||'エラー' }); return true; }
}

module.exports = { enabled, init, authenticate, handleRoutes, handleApi, publicUser, usersCount: ()=>store.users.length };
