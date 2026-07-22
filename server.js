const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

// FFmpeg (optional — agar load na ho to render passthrough ho jayega, crash nahi)
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  console.log('FFmpeg ready:', ffmpegPath);
} catch (e) {
  console.warn('ffmpeg-static not found — render will passthrough:', e.message);
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

// Env fallbacks — agar app query mein zone/key na bheje to yahan se le lo
const ENV_ZONE = process.env.BUNNY_ZONE || '';
const ENV_KEY  = process.env.BUNNY_KEY  || '';
const BUNNY_HOST = process.env.BUNNY_HOST || 'storage.bunnycdn.com';

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', server: 'live', envZone: !!ENV_ZONE, envKey: !!ENV_KEY, ffmpeg: !!ffmpegPath }));

// CONFIG — app isse Bunny/Gemini status leta hai (tokens NAHI bhejte, sirf flags + pullzone)
app.get('/api/config', (req, res) => {
  const pullzone = process.env.BUNNY_PULLZONE || (ENV_ZONE ? ('https://' + ENV_ZONE + '.b-cdn.net') : '');
  res.json({
    hasBunny: !!(ENV_ZONE && ENV_KEY),
    pullzone: pullzone,
    zone: ENV_ZONE || '',
    hasGemini: !!process.env.GEMINI_KEY
  });
});

// BUNNY: LIST
app.get('/api/bunny-list', (req, res) => {
  const zone = req.query.zone || ENV_ZONE;
  const key  = req.query.key  || ENV_KEY;
  if (!zone || !key) return res.status(400).json({ error: 'Missing params' });
  const r = https.request({ hostname: BUNNY_HOST, path: '/' + encodeURIComponent(zone) + '/', method: 'GET', headers: { 'AccessKey': key, 'Accept': 'application/json' } }, (resp) => {
    let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res.json(JSON.parse(d)); } catch (e) { res.status(500).json({ error: 'Parse error' }); } });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.end();
});

// BUNNY: UPLOAD (zone/key ab env se bhi mil sakte hain)
app.post('/api/bunny-upload', (req, res) => {
  const zone = req.query.zone || ENV_ZONE;
  const key  = req.query.key  || ENV_KEY;
  const file = req.query.file;
  if (!zone || !key || !file) return res.status(400).json({ error: 'Missing params', got: { zone: !!zone, key: !!key, file: !!file } });
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = req.headers['content-type'] || 'application/octet-stream';
    const r = https.request({ hostname: BUNNY_HOST, path: '/' + encodeURIComponent(zone) + '/' + encodeURIComponent(file), method: 'PUT', headers: { 'AccessKey': key, 'Content-Type': ct, 'Content-Length': body.length } }, (resp) => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res.json({ status: resp.statusCode, ok: resp.statusCode < 300 }));
    });
    r.on('error', e => res.status(500).json({ error: e.message }));
    r.write(body);
    r.end();
  });
});

// BUNNY: DOWNLOAD (verify + read sidecars/files)
app.get('/api/bunny-download', (req, res) => {
  const zone = req.query.zone || ENV_ZONE;
  const key  = req.query.key  || ENV_KEY;
  const file = req.query.file;
  if (!zone || !key || !file) return res.status(400).json({ error: 'Missing params' });
  const r = https.request({ hostname: BUNNY_HOST, path: '/' + encodeURIComponent(zone) + '/' + encodeURIComponent(file), method: 'GET', headers: { 'AccessKey': key } }, (resp) => {
    if (resp.statusCode >= 400) { res.status(resp.statusCode).end(); return; }
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    resp.pipe(res);
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.end();
});

// PROXY-FETCH (CDN download fallback for weak networks)
app.get('/api/proxy-fetch', (req, res) => {
  const target = req.query.url;
  if (!target || !/^https:\/\/[a-zA-Z0-9.-]*\.(b-cdn\.net|bunnycdn\.com)/i.test(target)) {
    return res.status(400).json({ error: 'Invalid or disallowed URL' });
  }
  https.get(target, (resp) => {
    if (resp.statusCode >= 400) { res.status(resp.statusCode).end(); return; }
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    resp.pipe(res);
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// GEMINI PROXY (AI hooks + captions)
app.post('/api/gemini', express.json({ limit: '10mb' }), (req, res) => {
  const gk = process.env.GEMINI_KEY;
  if (!gk) return res.status(400).json({ error: 'Gemini key not configured' });
  const { prompt, maxTokens } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens || 2048 }
  });
  const r = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-2.0-flash:generateContent?key=' + gk,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (resp) => {
    let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
      try {
        const j = JSON.parse(d);
        const text = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
        res.json({ text: text, raw: j });
      } catch (e) { res.status(500).json({ error: 'Parse error', body: d.slice(0, 200) }); }
    });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.write(payload);
  r.end();
});

// BUNNY: DELETE
app.delete('/api/bunny-delete', (req, res) => {
  const zone = req.query.zone || ENV_ZONE;
  const key  = req.query.key  || ENV_KEY;
  const file = req.query.file;
  if (!zone || !key || !file) return res.status(400).json({ error: 'Missing params' });
  const fname = decodeURIComponent(file);
  const r = https.request({ hostname: BUNNY_HOST, path: '/' + encodeURIComponent(zone) + '/' + fname, method: 'DELETE', headers: { 'AccessKey': key } }, (resp) => {
    let d = ''; resp.on('data', c => d += c); resp.on('end', () => res.json({ status: resp.statusCode, ok: resp.statusCode < 300 }));
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.end();
});

// BUNNY: BILLING
app.get('/api/bunny-billing', (req, res) => {
  const key = req.query.key || ENV_KEY;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  const r = https.request({ hostname: 'api.bunny.net', path: '/billing/summary', method: 'GET', headers: { 'AccessKey': key, 'Accept': 'application/json' } }, (resp) => {
    let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res.json(JSON.parse(d)); } catch (e) { res.status(500).json({ error: 'Parse error' }); } });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.end();
});

// RAILWAY USAGE (cost auto-fetch)
app.post('/api/railway-usage', express.json(), (req, res) => {
  const token = req.query.token || process.env.RAILWAY_TOKEN;
  const { query, variables } = req.body || {};
  if (!token || !query) return res.status(400).json({ error: 'Missing token/query' });
  const body = JSON.stringify({ query, variables: variables || {} });
  const r = https.request({ hostname: 'backboard.railway.com', path: '/graphql/v2', method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
    let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res.json(JSON.parse(d)); } catch (e) { res.status(500).json({ error: 'Parse error' }); } });
  });
  r.on('error', e => res.status(500).json({ error: e.message }));
  r.write(body);
  r.end();
});

// RENDER — FFmpeg overlay (banner+text PNG) burn onto video + optional trim.
// Agar ffmpeg na mile ya overlay na ho, to seedha video wapas (passthrough).
app.post('/api/render', upload.any(), (req, res) => {
  const files = req.files || [];
  const vf = files.find(f => f.fieldname === 'video');
  const ovf = files.find(f => f.fieldname === 'overlay');
  const cleanup = (extra) => { [vf, ovf, extra].forEach(f => { if (f && f.path) { try { fs.unlink(f.path, () => {}); } catch (e) {} } }); };

  if (!vf) { cleanup(); return res.status(400).json({ error: 'No video' }); }

  const trimStart = parseFloat(req.body.trimStart) || 0;
  const trimEnd = parseFloat(req.body.trimEnd) || 0;
  const duration = (trimEnd > trimStart) ? (trimEnd - trimStart) : 0;

  // Passthrough case: koi overlay nahi ya ffmpeg available nahi
  if (!ovf || !ffmpegPath) {
    const stream = fs.createReadStream(vf.path);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);
    stream.on('end', () => cleanup());
    stream.on('error', () => cleanup());
    return;
  }

  const outPath = vf.path + '_out.mp4';
  // FFmpeg args: video + overlay PNG ko scale karke overlay karo, phir encode
  const args = ['-y'];
  if (trimStart > 0) args.push('-ss', String(trimStart));
  args.push('-i', vf.path);
  args.push('-i', ovf.path);
  if (duration > 0) args.push('-t', String(duration));
  // overlay ko video ke size par scale karo, phir (0,0) par overlay
  args.push('-filter_complex', '[1:v]scale=iw:ih[ov];[0:v][ov]overlay=0:0:format=auto[v]');
  args.push('-map', '[v]', '-map', '0:a?');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
  args.push(outPath);

  execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64, timeout: 170000 }, (err) => {
    if (err || !fs.existsSync(outPath)) {
      console.error('ffmpeg error:', err && err.message);
      // fallback: original video wapas bhejo (feature fail na ho)
      try {
        const stream = fs.createReadStream(vf.path);
        res.setHeader('Content-Type', 'video/mp4');
        stream.pipe(res);
        stream.on('end', () => cleanup());
        stream.on('error', () => cleanup());
      } catch (e) { cleanup(); res.status(500).json({ error: 'render failed' }); }
      return;
    }
    const stream = fs.createReadStream(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);
    const done = () => { cleanup(); try { fs.unlink(outPath, () => {}); } catch (e) {} };
    stream.on('end', done);
    stream.on('error', done);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v2.4 on port ' + PORT));
