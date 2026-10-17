/*
 * 画像の形式変換(サーバー側)
 *   POST /api/convert … iPhone の HEIC/HEIF 写真を JPEG にする
 * ブラウザ(特に Chrome)は HEIC を表示も切り出しもできないので、取り込み時に一度ここで JPEG に直す。
 * 長辺 2400px までに縮小して返す(名刺・名簿の読み取りには十分で、変換も速い)。
 * 依存: heic-decode(libheif の WebAssembly)、jpeg-js(純JS のエンコーダ)。package.json 参照。
 */
'use strict';
const MAX_FILE = 25 * 1024 * 1024;
const MAX_SIDE = 2400;

async function heicToJpeg(buffer){
  if (!buffer || !buffer.length){ const e = new Error('ファイルが空です'); e.status = 400; throw e; }
  if (buffer.length > MAX_FILE){ const e = new Error('ファイルが大きすぎます(25MBまで)'); e.status = 413; throw e; }
  let decode, jpeg;
  try { decode = require('heic-decode'); jpeg = require('jpeg-js'); }
  catch(e){ const err = new Error('この環境では HEIC を変換できません(npm install が必要)'); err.status = 503; throw err; }
  let img;
  try { img = await decode({ buffer }); }
  catch(e){ const err = new Error('HEIC として読み込めませんでした'); err.status = 400; throw err; }
  const { width, height } = img;
  const sc = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * sc)), h = Math.max(1, Math.round(height * sc));
  let data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  if (sc < 1){
    // 最近傍を少しなめらかにした縮小(2×2 の平均)。速さ優先
    const out = Buffer.alloc(w * h * 4);
    const fx = width / w, fy = height / h;
    for (let y = 0; y < h; y++){
      const sy0 = Math.floor(y * fy), sy1 = Math.min(height - 1, sy0 + 1);
      for (let x = 0; x < w; x++){
        const sx0 = Math.floor(x * fx), sx1 = Math.min(width - 1, sx0 + 1);
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++){
          out[o + c] = (data[(sy0 * width + sx0) * 4 + c] + data[(sy0 * width + sx1) * 4 + c] + data[(sy1 * width + sx0) * 4 + c] + data[(sy1 * width + sx1) * 4 + c]) >> 2;
        }
        out[o + 3] = 255;
      }
    }
    data = out;
  }
  const encoded = jpeg.encode({ data, width: w, height: h }, 88);
  return { buffer: encoded.data, width: w, height: h };
}

/* server.js から呼ぶ: 処理できたら true、対象外なら false */
async function handle(req, res, url, { readBody, send }){
  if (url.pathname !== '/api/convert') return false;
  if (req.method !== 'POST'){ send(res, 405, { error:'method not allowed' }); return true; }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FILE){ send(res, 413, { error:'ファイルが大きすぎます(25MBまで)' }); req.resume(); return true; }
  try {
    const buf = await readBody(req, MAX_FILE);
    const out = await heicToJpeg(buf);
    res.writeHead(200, { 'Content-Type':'image/jpeg', 'Content-Length': out.buffer.length, 'Cache-Control':'no-store', 'X-Image-Size': `${out.width}x${out.height}` });
    res.end(out.buffer);
  } catch(e){ console.error('[convert]', e.message); send(res, e.status || 500, { error: e.message || '変換に失敗しました' }); }
  return true;
}

module.exports = { handle, heicToJpeg };
