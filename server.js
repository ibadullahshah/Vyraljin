const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

// Env fallbacks — agar app query mein zone/key na bheje to yahan se le lo
const ENV_ZONE = process.env.BUNNY_ZONE || '';
const ENV_KEY  = process.env.BUNNY_KEY  || '';
const BUNNY_HOST = process.env.BUNNY_HOST || 'storage.bunnycdn.com';

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', server: 'live', envZone: !!ENV_ZONE, envKey: !!ENV_KEY }));

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

// SIMPLE RENDER (no FFmpeg — passthrough). Accepts video + optional overlay + any text fields.
app.post('/api/render', upload.any(), (req, res) => {
  try {
    const files = req.files || [];
    const vf = files.find(f => f.fieldname === 'video');
    const ovf = files.find(f => f.fieldname === 'overlay');
    if (!vf) {
      files.forEach(f => { try { fs.unlink(f.path, () => {}); } catch (e) {} });
      return res.status(400).json({ error: 'No video' });
    }
    // Overlay abhi burn nahi karte (FFmpeg nahi) — sirf original video wapas bhejte hain
    if (ovf) { try { fs.unlink(ovf.path, () => {}); } catch (e) {} }
    const stream = fs.createReadStream(vf.path);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlink(vf.path, () => {}); } catch (e) {} });
    stream.on('error', () => { try { fs.unlink(vf.path, () => {}); } catch (e) {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v2.4 on port ' + PORT));
