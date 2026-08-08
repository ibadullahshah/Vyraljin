const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
app.use(cors());
// ── FIX: express.json() ab GLOBAL nahi hai — pehle ye har request (JSON content-type)
// ka body intercept kar leta tha, jisse /api/bunny-upload (jo caption/banner JSON
// bhejta hai) ko khaali stream milti thi aur Bunny par 0-byte file save ho jati thi.
// Ab sirf un routes par lagega jinhe req.body chahiye. ──
const jsonParser = express.json({ limit: '50mb' });

const BUNNY_KEY = process.env.BUNNY_KEY || '';
const BUNNY_HOST = process.env.BUNNY_HOST || 'storage.bunnycdn.com';
const BUNNY_ZONE = process.env.BUNNY_ZONE || '';
const BUNNY_PULLZONE = (process.env.BUNNY_PULLZONE || '').replace(/\/$/,'');
const GEMINI_KEY = process.env.GEMINI_KEY || '';
const FIREBASE_KEY = process.env.FIREBASE_KEY || '';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
const FIREBASE_APP_ID = process.env.FIREBASE_APP_ID || '';

let FFMPEG_BIN = 'ffmpeg';
try { const s = require('ffmpeg-static'); if (s) FFMPEG_BIN = s; } catch(e) {}

let shareCounts = {};
const SHARECOUNTS_FILE = 'vj_sharecounts.json';
let _scSaveTimer = null;

function bunnyGetJSON(filename) {
  return new Promise((resolve) => {
    if (!BUNNY_KEY || !BUNNY_ZONE) return resolve(null);
    const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(filename),method:'GET',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{
      let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{
        if(resp.statusCode!==200) return resolve(null);
        try{ resolve(JSON.parse(d)); }catch(e){ resolve(null); }
      });
    });
    r.on('error',()=>resolve(null)); r.end();
  });
}
function bunnyPutJSON(filename, data) {
  return new Promise((resolve) => {
    if (!BUNNY_KEY || !BUNNY_ZONE) return resolve(false);
    const body = Buffer.from(JSON.stringify(data));
    const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(filename),method:'PUT',headers:{'AccessKey':BUNNY_KEY,'Content-Type':'application/json','Content-Length':body.length}},(resp)=>{
      resp.on('data',()=>{}); resp.on('end',()=>resolve(resp.statusCode<300));
    });
    r.on('error',()=>resolve(false)); r.write(body); r.end();
  });
}
bunnyGetJSON(SHARECOUNTS_FILE).then(data=>{ if(data && typeof data==='object') shareCounts = data; }).catch(()=>{});

function saveShareCountsDebounced(){
  if(_scSaveTimer) clearTimeout(_scSaveTimer);
  _scSaveTimer = setTimeout(()=>{ bunnyPutJSON(SHARECOUNTS_FILE, shareCounts).catch(()=>{}); }, 3000);
}

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ver: 'v9.7-clean', ffmpeg: FFMPEG_BIN, bunny: !!BUNNY_KEY, bunnyHost: BUNNY_HOST, gemini: !!GEMINI_KEY }));
app.get('/api/config', (req, res) => res.json({
  pullzone: BUNNY_PULLZONE, hasBunny: !!BUNNY_KEY, hasGemini: !!GEMINI_KEY,
  hasFirebase: !!(FIREBASE_KEY && FIREBASE_DB_URL),
  fbApiKey: FIREBASE_KEY, fbDbUrl: FIREBASE_DB_URL, fbProjectId: FIREBASE_PROJECT_ID, fbAppId: FIREBASE_APP_ID
}));

app.get('/api/proxy-fetch', (req, res) => {
  const target = req.query.url;
  if (!target || !/^https:\/\/[a-zA-Z0-9.-]*\.(b-cdn\.net|bunnycdn\.com)\//i.test(target)) {
    return res.status(400).json({ error: 'Invalid or disallowed URL' });
  }
  https.get(target, (resp) => {
    if (resp.statusCode >= 400) { res.status(resp.statusCode).end(); return; }
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/json');
    resp.pipe(res);
  }).on('error', e => res.status(500).json({ error: e.message }));
});

app.post('/api/mark-shared', jsonParser, (req, res) => {
  const videoURL = req.body && req.body.videoURL;
  if (!videoURL) return res.status(400).json({ error: 'No videoURL' });
  shareCounts[videoURL] = (shareCounts[videoURL] || 0) + 1;
  saveShareCountsDebounced();
  res.json({ ok: true, count: shareCounts[videoURL] });
});

app.get('/api/share-counts', (req, res) => {
  res.json(shareCounts);
});

let _lastRenderErr='(abhi koi error nahi)';
let _lastRenderParams='(abhi koi render nahi)';
app.get('/api/lasterror',(req,res)=>res.type('text/plain').send('===PARAMS (permanent, overwrite nahi hote)===\n'+_lastRenderParams+'\n\n===LIVE STATUS===\n'+_lastRenderErr));
// 🔬 TEST: sirf video receive karo, render NAHI — pata karne ke liye upload pohanchti hai ya nahi
app.post('/api/uptest', upload.fields([{name:'video',maxCount:1}]), (req,res)=>{
  const vf=req.files['video']?.[0];
  let sz=0; try{sz=fs.statSync(vf.path).size;}catch(e){}
  if(vf)fs.unlink(vf.path,()=>{});
  _lastRenderErr='UPTEST: video mili! size='+sz+' bytes, time='+new Date().toISOString();
  res.json({ok:true,size:sz});
});

app.post('/api/gemini', jsonParser, async (req, res) => {
  const _gT0 = Date.now();
  if (!GEMINI_KEY) { console.log('[GEMINI] FAIL: No Gemini key configured on server'); return res.status(400).json({ error: 'No Gemini key' }); }
  const prompt = req.body.prompt || '';
  if (!prompt) { console.log('[GEMINI] FAIL: No prompt in request body'); return res.status(400).json({ error: 'No prompt' }); }
  const maxTok = parseInt(req.body.maxTokens) || 8192;
  // FIX (NEW — AI topic guess): agar client image bhi bhejta hai, usay bhi
  // prompt ke saath Gemini ko dikhao (vision).
  const _imgB64 = req.body.imageBase64 || null;
  const _imgMime = req.body.imageMime || 'image/jpeg';
  console.log('[GEMINI] Request received, promptLen=' + prompt.length + ', maxTokens=' + maxTok + (_imgB64?', with image':''));
  // FIX: gemini-2.5-flash by default "thinking" (internal reasoning) tokens bhi
  // maxOutputTokens budget mein se hi kaatta hai — isi wajah se poora budget
  // sochne mein khatam ho jata tha aur asli visible caption sirf 100-200 chars
  // ka reh jata tha (chahe HTTP 200 SUCCESS ho). thinkingBudget:0 se yeh
  // internal reasoning bilkul band ho jati hai, taake poora token budget sirf
  // asli caption text banane mein use ho.
  const _parts = _imgB64
    ? [{ text: prompt }, { inline_data: { mime_type: _imgMime, data: _imgB64 } }]
    : [{ text: prompt }];
  const body = JSON.stringify({ contents:[{parts:_parts}], generationConfig:{temperature:0.9,maxOutputTokens:maxTok,thinkingConfig:{thinkingBudget:0}} });
  const models = ['gemini-2.5-flash','gemini-2.5-flash-preview-04-17'];
  for (const m of models) {
    try {
      const r = await new Promise((resolve,reject)=>{
        const rq = https.request({hostname:'generativelanguage.googleapis.com',path:'/v1beta/models/'+m+':generateContent?key='+GEMINI_KEY,method:'POST',headers:{'Content-Type':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>resolve({status:resp.statusCode,data:d}));});
        rq.on('error',reject); rq.write(body); rq.end();
      });
      console.log('[GEMINI] Model ' + m + ' -> HTTP ' + r.status + ' (' + (Date.now()-_gT0) + 'ms)');
      if (r.status === 200) {
        const j = JSON.parse(r.data);
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) { console.log('[GEMINI] SUCCESS with ' + m + ', textLen=' + text.length); return res.json({ text }); }
        console.log('[GEMINI] Model ' + m + ' returned HTTP 200 but EMPTY text. Raw response: ' + r.data.slice(0,500));
      } else {
        console.log('[GEMINI] Model ' + m + ' error body: ' + r.data.slice(0,500));
      }
    } catch(e) { console.log('[GEMINI] Model ' + m + ' threw exception: ' + e.message); continue; }
  }
  console.log('[GEMINI] FAIL: all models exhausted, returning 500');
  res.status(500).json({ error: 'Gemini failed' });
});

app.post('/api/embed', jsonParser, async (req, res) => {
  const text = req.body.text || '';
  if (!GEMINI_KEY) return res.status(400).json({ error: 'No Gemini key' });
  if (!text) return res.status(400).json({ error: 'Missing text' });
  try {
    const body = JSON.stringify({ content: { parts: [{ text: text.slice(0, 2000) }] } });
    const r = await new Promise((resolve, reject) => {
      const req2 = https.request({hostname:'generativelanguage.googleapis.com',path:'/v1beta/models/gemini-embedding-001:embedContent?key='+GEMINI_KEY,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},(resp)=>{
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
      });
      req2.on('error', reject); req2.write(body); req2.end();
    });
    const parsed = JSON.parse(r);
    const embedding = parsed && parsed.embedding && parsed.embedding.values ? parsed.embedding.values : null;
    if (!embedding) return res.status(500).json({ error: 'No embedding returned' });
    res.json({ embedding });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bunny-list', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/',method:'GET',headers:{'AccessKey':BUNNY_KEY,'Accept':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});});
  r.on('error',e=>res.status(500).json({error:e.message})); r.end();
});

// ── FIX: pull-zone (CDN) se turant readback karne par propagation-delay/negative-cache
// ki wajah se 404 mil sakta hai, chahe file storage zone par pehle se maujood ho. Yeh
// endpoint seedha Bunny STORAGE API se padhta hai (CDN cache bypass), isliye turant aur
// bharosemand result deta hai — verification isi ko use karega jab bunny_key/zone available ho ──
app.get('/api/bunny-download', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename' });
  const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(file),method:'GET',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{
    if (resp.statusCode >= 400) { res.status(resp.statusCode).end(); return; }
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    resp.pipe(res);
  });
  r.on('error', e => res.status(500).json({ error: e.message })); r.end();
});

app.post('/api/bunny-upload', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename' });
  // FIX: pehle hamesha 'video/mp4' Content-Type bhejta tha, chahe file JSON ya
  // image ho — extension se sahi mime-type nikalo taake JSON/image sidecar files
  // Bunny par sahi tarah save/serve hon.
  const _extMimeMap = { '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.mp4':'video/mp4',
    '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.wav':'audio/wav', '.ogg':'audio/ogg', '.opus':'audio/opus' };
  const _fext = ((file.match(/\.[^.]+$/) || [''])[0]).toLowerCase();
  const _mime = _extMimeMap[_fext] || 'application/octet-stream';
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    console.log('[BUNNY-UPLOAD] file=' + file + ', mime=' + _mime + ', size=' + bodyBuf.length + ' bytes');
    if (bodyBuf.length === 0) console.log('[BUNNY-UPLOAD] WARNING: empty body for ' + file);
    const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(file),method:'PUT',headers:{'AccessKey':BUNNY_KEY,'Content-Type':_mime,'Content-Length':bodyBuf.length}},(resp)=>{
      let d='';resp.on('data',c=>d+=c);
      resp.on('end',()=>{
        console.log('[BUNNY-UPLOAD] ' + file + ' -> Bunny HTTP ' + resp.statusCode);
        res.json({status:resp.statusCode,ok:resp.statusCode<300,url:BUNNY_PULLZONE+'/'+file});
      });
    });
    r.on('error',e=>{ console.log('[BUNNY-UPLOAD] ' + file + ' -> exception: ' + e.message); res.status(500).json({error:e.message}); });
    r.write(bodyBuf); r.end();
  });
});

// ══════ RESUMABLE CHUNK UPLOAD — VyralJin ══════
// App file ko 256KB tukron mein bhejti hai. Net toote to jitna aa chuka wo
// /tmp mein mehfooz rehta hai — app usi offset se aagay bhejti hai, zero se
// dobara kabhi nahi. Aakhri tukra aate hi poori file Bunny par PUT ho jati hai.
const VJ_CHUNK_DIR = '/tmp/vj_chunks';
if (!fs.existsSync(VJ_CHUNK_DIR)) fs.mkdirSync(VJ_CHUNK_DIR, { recursive: true });
const vjChunkPath = f => VJ_CHUNK_DIR + '/' + String(f).replace(/[^a-zA-Z0-9._-]/g, '_');
const vjDoneMap = {}; // file -> {done, bunnyOk, total, mime}

function vjBunnyPutBuffer(file, buf, mime) {
  return new Promise((resolve) => {
    if (!BUNNY_KEY || !BUNNY_ZONE) return resolve(false);
    const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(file),method:'PUT',headers:{'AccessKey':BUNNY_KEY,'Content-Type':mime||'video/mp4','Content-Length':buf.length}},(resp)=>{
      resp.on('data',()=>{}); resp.on('end',()=>resolve(resp.statusCode<300));
    });
    r.on('error',()=>resolve(false)); r.write(buf); r.end();
  });
}

async function vjFinalizeToBunny(f) {
  const d = vjDoneMap[f]; if (!d || d.done) return d;
  try {
    const buf = fs.readFileSync(vjChunkPath(f));
    const ok = await vjBunnyPutBuffer(f, buf, d.mime);
    d.bunnyOk = ok; d.done = ok;
    console.log('[CHUNK-UP] finalize ' + f + ' -> ' + (ok ? 'OK' : 'FAIL') + ', size=' + buf.length);
    if (ok) { try { fs.unlinkSync(vjChunkPath(f)); } catch (e) {} }
  } catch (e) { d.bunnyOk = false; d.done = false; }
  return d;
}

app.get('/api/bunny-upload-status', async (req, res) => {
  const f = req.query.file || '';
  let received = 0;
  try { received = fs.existsSync(vjChunkPath(f)) ? fs.statSync(vjChunkPath(f)).size : ((vjDoneMap[f] && vjDoneMap[f].total) || 0); } catch (e) {}
  let d = vjDoneMap[f];
  // Poora file aa chuka lekin Bunny PUT reh gaya tha — yahin dobara try ho jata hai
  if (d && !d.done && d.total && received >= d.total) d = await vjFinalizeToBunny(f);
  res.json({ ok: true, received: received, done: !!(d && d.done), bunnyOk: !(d && d.bunnyOk === false) });
});

app.post('/api/bunny-upload-chunk', (req, res) => {
  const f = req.query.file || '';
  const offset = parseInt(req.query.offset || '0', 10);
  const total = parseInt(req.query.total || '0', 10);
  const mime = req.query.mime || 'video/mp4';
  if (!f || !total) return res.status(400).json({ ok: false, error: 'file/total missing' });
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      if (!body.length) return res.status(400).json({ ok: false, error: 'empty chunk' });
      const p = vjChunkPath(f);
      const cur = fs.existsSync(p) ? fs.statSync(p).size : 0;
      if (offset !== cur) return res.status(409).json({ ok: false, received: cur });
      fs.appendFileSync(p, body);
      const now = fs.statSync(p).size;
      console.log('[CHUNK-UP] ' + f + ' @' + offset + ' +' + body.length + ' = ' + now + '/' + total);
      if (now >= total) {
        vjDoneMap[f] = { done: false, bunnyOk: false, total: total, mime: mime };
        const d = await vjFinalizeToBunny(f);
        return res.json({ ok: true, received: now, done: d.done, bunnyOk: d.bunnyOk });
      }
      res.json({ ok: true, received: now, done: false });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });
});

app.delete('/api/bunny-delete', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename' });
  const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+decodeURIComponent(file),method:'DELETE',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));});
  r.on('error',e=>res.status(500).json({error:e.message})); r.end();
});

// ── ONE-TIME MIGRATION: 'ws_biz-v5b5j6__' prefix wali files ko bina-prefix
// naam par copy kar ke purani (prefix wali) delete kar deta hai. Sirf ek
// dafa use karne ke liye — kaam ho jaye to ye poora route hata dena. ──
app.get('/api/migrate-legacy-prefix', async (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const PREFIX = 'ws_biz-v5b5j6__';
  const results = [];

  function bunnyList() {
    return new Promise((resolve, reject) => {
      const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/',method:'GET',headers:{'AccessKey':BUNNY_KEY,'Accept':'application/json'}},(resp)=>{
        let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ reject(e); } });
      });
      r.on('error',reject); r.end();
    });
  }
  function bunnyGetRaw(filename) {
    return new Promise((resolve) => {
      const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(filename),method:'GET',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{
        if (resp.statusCode >= 400) return resolve(null);
        const chunks=[]; resp.on('data',c=>chunks.push(c)); resp.on('end',()=>resolve(Buffer.concat(chunks)));
      });
      r.on('error',()=>resolve(null)); r.end();
    });
  }
  function bunnyPutRaw(filename, buf) {
    return new Promise((resolve) => {
      const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(filename),method:'PUT',headers:{'AccessKey':BUNNY_KEY,'Content-Type':'application/octet-stream','Content-Length':buf.length}},(resp)=>{
        resp.on('data',()=>{}); resp.on('end',()=>resolve(resp.statusCode<300));
      });
      r.on('error',()=>resolve(false)); r.write(buf); r.end();
    });
  }
  function bunnyDeleteRaw(filename) {
    return new Promise((resolve) => {
      const r = https.request({hostname:BUNNY_HOST,path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(filename),method:'DELETE',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{
        resp.on('data',()=>{}); resp.on('end',()=>resolve(resp.statusCode<300));
      });
      r.on('error',()=>resolve(false)); r.end();
    });
  }

  try {
    const files = await bunnyList();
    const targets = (files || []).filter(f => f.ObjectName && f.ObjectName.indexOf(PREFIX) === 0 && !f.IsDirectory);
    console.log('[MIGRATE] found ' + targets.length + ' files with prefix ' + PREFIX);
    for (const f of targets) {
      const oldName = f.ObjectName;
      const newName = oldName.slice(PREFIX.length);
      try {
        const buf = await bunnyGetRaw(oldName);
        if (!buf) { results.push({ oldName, status: 'download-failed' }); continue; }
        const putOk = await bunnyPutRaw(newName, buf);
        if (!putOk) { results.push({ oldName, status: 'upload-failed' }); continue; }
        const delOk = await bunnyDeleteRaw(oldName);
        results.push({ oldName, newName, status: delOk ? 'ok' : 'copied-but-old-not-deleted' });
        console.log('[MIGRATE] ' + oldName + ' -> ' + newName + ' : ' + (delOk ? 'ok' : 'copy-only'));
      } catch (e) {
        results.push({ oldName, status: 'error', error: e.message });
      }
    }
    res.json({ total: targets.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bunny-billing', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'No account key' });
  const r = https.request({hostname:'api.bunny.net',path:'/billing/summary',method:'GET',headers:{'AccessKey':key,'Accept':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});});
  r.on('error',e=>res.status(500).json({error:e.message})); r.end();
});

app.post('/api/railway-usage', jsonParser, (req, res) => {
  const token = req.query.token;
  const { query, variables } = req.body || {};
  if (!token || !query) return res.status(400).json({ error: 'Missing token/query' });
  const body = JSON.stringify({ query, variables: variables || {} });
  const r = https.request({hostname:'backboard.railway.com',path:'/graphql/v2',method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});});
  r.on('error',e=>res.status(500).json({error:e.message})); r.write(body); r.end();
});

// ══════ MUSIC HELPER — Bunny URL se /tmp par download ══════
function vjDownloadMusic(url) {
  return new Promise((resolve) => {
    if (!url || !/^https:\/\//i.test(url)) return resolve(null);
    const ext = ((url.match(/\.(mp3|m4a|aac|wav|ogg|opus)(\?|$)/i) || [])[1] || 'mp3').toLowerCase();
    const p = '/tmp/vjmus_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext;
    try {
      const ws = fs.createWriteStream(p);
      const rq = https.get(url, (resp) => {
        if (resp.statusCode >= 400) { try { ws.close(); fs.unlinkSync(p); } catch (e) {} return resolve(null); }
        resp.pipe(ws);
        ws.on('finish', () => { ws.close(() => { console.log('[RENDER] music downloaded ->', p); resolve(p); }); });
      });
      rq.on('error', () => { try { fs.unlinkSync(p); } catch (e) {} resolve(null); });
      rq.setTimeout(45000, () => { try { rq.destroy(); } catch (e) {} resolve(null); });
    } catch (e) { resolve(null); }
  });
}

// FIX (NEW — Auto-Trim Silence): video ke SHURU aur AAKHIR mein khamoshi
// khud detect karo aur user ke manual trim ke upar additional trim laga do.
// Sirf shuru/aakhir (boundary) trim hoti hai, beech mein kabhi nahi —
// isliye result kabhi ajeeb/broken nahi lagta. Max 2.5 second har taraf
// (safety cap) — koi accidental over-trim nahi.
function detectLeadTrailSilence(filePath) {
  return new Promise((resolve) => {
    try {
      const { spawn: _spawn } = require('child_process');
      const args = ['-i', filePath, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'];
      const ff = _spawn(FFMPEG_BIN, args);
      let err = '';
      ff.stderr.on('data', d => { err += d.toString(); });
      ff.on('close', () => {
        try {
          const starts = [...err.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
          const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
          const durMatch = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
          let totalDur = 0;
          if (durMatch) totalDur = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + parseFloat(durMatch[3]);
          let leadSilence = 0, trailSilence = 0;
          if (starts.length && starts[0] < 0.15 && ends.length) leadSilence = ends[0];
          if (starts.length && totalDur > 0) {
            const lastStart = starts[starts.length - 1];
            if (lastStart != null && (totalDur - lastStart) < 5 && ends.length < starts.length) {
              trailSilence = totalDur - lastStart;
            }
          }
          resolve({ leadSilence: Math.min(leadSilence, 2.5), trailSilence: Math.min(trailSilence, 2.5), totalDur });
        } catch (e) { resolve({ leadSilence: 0, trailSilence: 0, totalDur: 0 }); }
      });
      ff.on('error', () => resolve({ leadSilence: 0, trailSilence: 0, totalDur: 0 }));
    } catch (e) { resolve({ leadSilence: 0, trailSilence: 0, totalDur: 0 }); }
  });
}

app.post('/api/render', (req,res,next)=>{ _lastRenderErr='STEP 0: /api/render request aayi! '+new Date().toISOString(); next(); }, upload.fields([{name:'video',maxCount:1},{name:'overlay',maxCount:1},{name:'music',maxCount:1}]), async (req, res) => {
  _lastRenderErr='STEP 0.5: multer ke baad, files='+JSON.stringify(Object.keys(req.files||{}));
  const vf = req.files['video']?.[0]; if (!vf) { _lastRenderErr='STEP 0.6: VIDEO FILE NAHI MILI multer ke baad'; return res.status(400).json({ error: 'No video' }); }
  const of = req.files['overlay']?.[0];
  let _vfSize=0;
  try{ _vfSize=fs.statSync(vf.path).size; }catch(e){}
  console.log('VIDEO received size:', _vfSize);
  _lastRenderErr='STEP 1: video mila, size='+_vfSize+' bytes, overlay='+(of?'haan':'nahi');
  _lastRenderParams = 'RAW BODY: trimStart='+req.body.trimStart+' trimEnd='+req.body.trimEnd
    +' | origVol='+req.body.origVol+' keepOriginal='+req.body.keepOriginal
    +' | musicVol='+req.body.musicVol+' musicUrl='+(req.body.musicUrl?'HAAN':'NAHI')
    +' | time='+new Date().toISOString();
  let ts = Math.max(0, parseFloat(req.body.trimStart)||0);
  let te = parseFloat(req.body.trimEnd)||0;
  if (req.body.autoTrimSilence !== '0') {
    try {
      const sil = await detectLeadTrailSilence(vf.path);
      if (sil.leadSilence > 0.15) { ts += sil.leadSilence; console.log('[AUTOTRIM] lead silence trimmed:', sil.leadSilence.toFixed(2)+'s'); }
      if (sil.trailSilence > 0.15 && sil.totalDur > 0) {
        const naturalEnd = (te > ts) ? te : sil.totalDur;
        te = Math.max(ts + 0.5, naturalEnd - sil.trailSilence);
        console.log('[AUTOTRIM] trail silence trimmed:', sil.trailSilence.toFixed(2)+'s');
      }
    } catch (e) {}
  }
  const dur = te > ts ? te - ts : 0;
  _lastRenderErr='STEP 1.5: TRIM DEBUG ts='+ts+' te='+te+' dur='+dur+' body.trimStart='+req.body.trimStart+' body.trimEnd='+req.body.trimEnd;
  const out = '/tmp/final_' + Date.now() + '.mp4';
  const { spawn } = require('child_process');
  let _rendered = false;
  let musicPath = null;
  let _keepOrig = (req.body.keepOriginal !== '0');
  function doRender() {
    if (_rendered) return; _rendered = true;
    _lastRenderErr='STEP 2: doRender shuru, size='+_vfSize;
    // ASLI SHAPE: video ke original dimensions hi rakho — na scale, na crop, na pad.
    const scaleF = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p';
    // Overlay PNG ko video ke har frame par overlay karo. eof_action=repeat se overlay
    // poori video par rehta hai aur video poori length chalti hai (1 frame nahi).
    const fcOv = '[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[base];[1:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[ov];[base][ov]overlay=0:0:eof_action=repeat:format=auto[outv]';
    // FIX (ROOT CAUSE — cut/trim bilkul apply nahi ho raha tha): -t flag
    // -i ke BAAD tha, jo FFmpeg mein sirf agle input par ya output par
    // attach ho jata hai — us wajah se video ki poori length render hoti
    // thi trim ke bawajood. Ab -t, -ss ke sath -i se PEHLE hai (input option),
    // taake sirf vf.path input hi trim ho.
    const trimArgs = dur > 0.05 ? ['-ss', String(ts), '-t', String(dur), '-i', vf.path] : ['-i', vf.path];

    // ══════ BACKGROUND MUSIC MIX ══════
    // keepOrig = video ki asli awaaz rakhni hai ya nahi.
    // Agar video mein audio track hi na ho to amix fail hota hai — neeche wala
    // close-handler khud music-only par dobara try kar leta hai.
    function buildArgs(keepOrig) {
      if (!musicPath) {
        return of
          ? ['-y','-filter_complex_threads','1',...trimArgs,'-i',of.path,'-filter_complex',fcOv,'-map','[outv]','-map','0:a?','-c:v','libx264','-preset','veryfast','-threads','1','-crf','28','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart','-max_muxing_queue_size','1024',out]
          : ['-y','-filter_threads','1',...trimArgs,'-vf',scaleF,'-c:v','libx264','-preset','veryfast','-threads','1','-crf','28','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart','-max_muxing_queue_size','1024',out];
      }
      const mVol    = Math.max(0, Math.min(3,  parseFloat(req.body.musicVol)   || 0.6));
      const oVol    = Math.max(0, Math.min(3,  (req.body.origVol !== undefined && req.body.origVol !== '') ? parseFloat(req.body.origVol) : 1));
      const mStart  = Math.max(0,              parseFloat(req.body.musicStart) || 0);
      const mEnd    = Math.max(0,              parseFloat(req.body.musicEnd)   || 0);
      const fadeIn  = Math.max(0, Math.min(20, parseFloat(req.body.fadeIn)     || 0));
      const fadeOut = Math.max(0, Math.min(20, parseFloat(req.body.fadeOut)    || 0));
      const segLen  = (mEnd > mStart) ? (mEnd - mStart) : 0;
      const mixLen  = dur > 0.5 ? dur : segLen;
      const musIdx  = of ? 2 : 1;

      let bg = '[' + musIdx + ':a]';
      if (segLen > 0) bg += 'atrim=duration=' + segLen.toFixed(2) + ',asetpts=PTS-STARTPTS,';
      bg += 'volume=' + mVol.toFixed(3);
      if (fadeIn > 0) bg += ',afade=t=in:st=0:d=' + fadeIn.toFixed(2);
      if (fadeOut > 0 && mixLen > fadeOut) bg += ',afade=t=out:st=' + (mixLen - fadeOut).toFixed(2) + ':d=' + fadeOut.toFixed(2);
      bg += ',apad,atrim=duration=3600[bg]';  // apad = video khatam hone tak khamoshi; atrim cap zaroori
                                              // warna stream infinite ho jati hai aur muxer buffer bhar ke
                                              // "No space left on device" error aata hai

      const vChain = of ? fcOv : '[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p[outv]';

      _lastRenderParams += ' | COMPUTED: ts='+ts+' te='+te+' dur='+dur+' oVol='+oVol+' mVol='+mVol+' keepOrig='+keepOrig+' -> BRANCH='+((keepOrig && oVol > 0)?'DUCKING(original+music dono)':'MUSIC-ONLY(original gayab)');
      let fc, aMap;
      if (keepOrig && oVol > 0) {
        // FIX (NEW — smart auto-ducking): pehle music hamesha fixed volume par
        // rehta tha, chahe video ki apni awaaz bol rahi ho ya khamoshi ho —
        // isi wajah se awaaz aur music aapas mein takrate the. Ab
        // sidechaincompress filter original awaaz (oa) ko "detector" bana kar
        // music (bg) ka volume real-time mein khud control karta hai: jab
        // awaaz bole, music khud halka ho jata hai; jab awaaz ruke/khamosh
        // ho, music khud wapas upar aa jata hai. Podcasts/YouTube mein isi
        // technique ko "ducking" kehte hain.
        // threshold=0.04 (~-28dB) — halki si bhi awaaz duck trigger kar de
        // ratio=10 — mazboot ducking taake awaaz hamesha saaf sunaayi de
        // attack=8ms — awaaz shuru hote hi turant music halka ho jaye
        // release=350ms — awaaz rukte hi thodi si smooth der se music upar aaye (achanak jhatka na lage)
        // FIX (ROOT CAUSE — final video mein sirf music, original sound gayab):
        // video ki apni audio aur music file ki sample-rate/channel-layout
        // aksar match nahi karte the, jis wajah se sidechaincompress/amix
        // FFmpeg mein fail ho jata tha aur code khamoshi se music-only retry
        // kar leta tha (neeche wala close-handler). Ab dono streams ko
        // sidechain/amix se PEHLE ek common format (44100Hz stereo) mein
        // normalize karte hain — isse yeh mismatch-failure khatam ho jati hai
        // aur original awaaz hamesha final video mein bhi bachi rehti hai,
        // bilkul preview jaisa.
        fc = vChain + ';' + bg + ';[0:a]volume=' + oVol.toFixed(3) + ',aformat=sample_rates=44100:channel_layouts=stereo[oa];'
           + '[bg]aformat=sample_rates=44100:channel_layouts=stereo[bgf];'
           + '[bgf][oa]sidechaincompress=threshold=0.04:ratio=10:attack=8:release=350:makeup=1[duckedbg];'
           + '[oa][duckedbg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]';
        aMap = '[outa]';
      } else {
        fc = vChain + ';' + bg;
        aMap = '[bg]';
      }

      const a = ['-y','-filter_complex_threads','1', ...trimArgs];
      if (of) a.push('-i', of.path);
      a.push('-ss', String(mStart), '-i', musicPath);
      a.push('-filter_complex', fc, '-map', '[outv]', '-map', aMap,
        '-c:v','libx264','-preset','veryfast','-threads','1','-crf','28','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','128k','-ar','44100','-shortest',
        '-movflags','+faststart','-max_muxing_queue_size','1024', out);
      return a;
    }

    const args = buildArgs(_keepOrig);
    const ff = spawn(FFMPEG_BIN, args);
    _lastRenderErr='STEP 3: FFmpeg spawn hua, ARGS='+args.join(' ');
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); _lastRenderErr='STEP 4: FFmpeg chal raha\n\n'+err.slice(-1500); });
    ff.on('close', code => {
      // ── Video mein audio track hi nahi tha? Music-only par ek dafa dobara try karo ──
      if (code !== 0 && musicPath && _keepOrig) {
        _keepOrig = false;
        _rendered = false;
        console.log('[RENDER] ducking/amix fail -> music-only retry. ORIGINAL ERROR:', err.slice(-800));
        // FIX: asal error ab retry ke overwrite se pehle safe kar lete hain,
        // taake /api/lasterror par pata chal sake ke ducking kyun fail hui thi
        _lastRenderErr = 'PRIMARY (with-original-audio) ATTEMPT FAILED, retrying music-only.\n\nORIGINAL ERROR:\n' + err.slice(-1200) + '\n\n---RETRY BELOW---';
        // FIX (NEW): ye ab PARAMS wale permanent variable mein bhi save hota
        // hai, taake retry ka STEP 4 progress ise overwrite na kar sake aur
        // /api/lasterror par DUCKING fail hone ki asal wajah hamesha dikhe.
        _lastRenderParams += '\n\n!!! DUCKING FAILED, YE RAHI ASAL WAJAH !!!\n' + err.slice(-1200);
        return doRender();
      }
      fs.unlink(vf.path, ()=>{});
      if (of) fs.unlink(of.path, ()=>{});
      if (musicPath) fs.unlink(musicPath, ()=>{});
      if (code !== 0) { _lastRenderErr='EXIT '+code+' | size:'+_vfSize+'\n\nARGS: '+args.join(' ')+'\n\n'+err; return res.status(500).json({ error: 'FFmpeg failed', detail: err.slice(-1500) }); }
      res.setHeader('Content-Type','video/mp4');
      const s = fs.createReadStream(out);
      s.pipe(res);
      s.on('end', () => fs.unlink(out, ()=>{}));
      s.on('error', () => fs.unlink(out, ()=>{}));
    });
    setTimeout(() => { ff.kill('SIGKILL'); if (!res.headersSent) { _lastRenderErr='TIMEOUT 900s | size:'+_vfSize; res.status(500).json({ error: 'Timeout' }); } }, 900000);
  }
  // AUTO-ROTATE: FFmpeg khud rotation metadata padh ke seedha kar leta hai — manual transpose nahi.
  // Music multipart mein aayi? warna Bunny URL se download karo, phir render.
  const mfUp = req.files['music'] && req.files['music'][0];
  if (mfUp) {
    musicPath = mfUp.path;
    console.log('[RENDER] music (upload) =', mfUp.size, 'bytes');
    doRender();
  } else if (req.body.musicUrl) {
    console.log('[RENDER] music URL:', req.body.musicUrl);
    vjDownloadMusic(req.body.musicUrl).then(p => {
      musicPath = p;
      if (!p) console.log('[RENDER] music download FAIL — bina music render');
      doRender();
    }).catch(() => doRender());
  } else {
    doRender();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v7.0-noscale on port ' + PORT));