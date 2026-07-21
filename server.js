const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', server: 'live' }));

// BUNNY ENDPOINTS
app.get('/api/bunny-list',(req,res)=>{
  const{zone,key}=req.query;
  if(!zone||!key)return res.status(400).json({error:'Missing params'});
  const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/',method:'GET',headers:{'AccessKey':key,'Accept':'application/json'}},(resp)=>{
    let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});
  });
  r.on('error',e=>res.status(500).json({error:e.message}));
  r.end();
});

app.post('/api/bunny-upload',(req,res)=>{
  const{zone,key,file}=req.query;
  if(!zone||!key||!file)return res.status(400).json({error:'Missing params'});
  const chunks=[];
  req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
    const body=Buffer.concat(chunks);
    const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/'+encodeURIComponent(file),method:'PUT',headers:{'AccessKey':key,'Content-Type':'video/mp4','Content-Length':body.length}},(resp)=>{
      let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));
    });
    r.on('error',e=>res.status(500).json({error:e.message}));
    r.write(body);
    r.end();
  });
});

app.delete('/api/bunny-delete',(req,res)=>{
  const{zone,key,file}=req.query;
  if(!zone||!key||!file)return res.status(400).json({error:'Missing params'});
  const fname=decodeURIComponent(file);
  const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/'+fname,method:'DELETE',headers:{'AccessKey':key}},(resp)=>{
    let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));
  });
  r.on('error',e=>res.status(500).json({error:e.message}));
  r.end();
});

app.get('/api/bunny-billing',(req,res)=>{
  const{key}=req.query;
  if(!key)return res.status(400).json({error:'Missing key'});
  const r=https.request({hostname:'api.bunny.net',path:'/billing/summary',method:'GET',headers:{'AccessKey':key,'Accept':'application/json'}},(resp)=>{
    let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});
  });
  r.on('error',e=>res.status(500).json({error:e.message}));
  r.end();
});

// RAILWAY API
app.post('/api/railway-usage',express.json(),(req,res)=>{
  const{token}=req.query;
  const{query,variables}=req.body||{};
  if(!token||!query)return res.status(400).json({error:'Missing token/query'});
  const body=JSON.stringify({query,variables:variables||{}});
  const r=https.request({hostname:'backboard.railway.com',path:'/graphql/v2',method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},(resp)=>{
    let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});
  });
  r.on('error',e=>res.status(500).json({error:e.message}));
  r.write(body);
  r.end();
});

// SIMPLE RENDER (no FFmpeg)
app.post('/api/render', upload.fields([{name:'video',maxCount:1}]), (req, res) => {
  const vf = req.files['video']?.[0];
  if (!vf) return res.status(400).json({ error: 'No video' });
  const stream = fs.createReadStream(vf.path);
  res.setHeader('Content-Type', 'video/mp4');
  stream.pipe(res);
  stream.on('end', () => fs.unlink(vf.path, ()=>{}));
  stream.on('error', () => fs.unlink(vf.path, ()=>{}));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v2.4 on port ' + PORT));