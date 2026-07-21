const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const app = express();
app.use(express.json({ limit: '50mb' }));
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
app.use(cors());
let FFMPEG_BIN = 'ffmpeg';
try { const s = require('ffmpeg-static'); if (s) FFMPEG_BIN = s; } catch(e) {}
app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ffmpeg: FFMPEG_BIN }));
app.get('/api/bunny-list',(req,res)=>{const{zone,key}=req.query;if(!zone||!key)return res.status(400).json({error:'Missing params'});const https=require('https');const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/',method:'GET',headers:{'AccessKey':key,'Accept':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});});r.on('error',e=>res.status(500).json({error:e.message}));r.end();});
app.get('/api/bunny-download',(req,res)=>{const{zone,key,file}=req.query;if(!zone||!key||!file)return res.status(400).json({error:'Missing params'});const https=require('https');const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/'+encodeURIComponent(file),method:'GET',headers:{'AccessKey':key}},(resp)=>{if(resp.statusCode>=400){res.status(resp.statusCode).end();return;}res.setHeader('Content-Type',resp.headers['content-type']||'application/octet-stream');resp.pipe(res);});r.on('error',e=>res.status(500).json({error:e.message}));r.end();});
app.get('/api/proxy-fetch',(req,res)=>{const target=req.query.url;if(!target||!/^https://[a-zA-Z0-9.-]*.(b-cdn.net|bunnycdn.com)//i.test(target))return res.status(400).json({error:'Invalid or disallowed URL'});const https=require('https');https.get(target,(resp)=>{if(resp.statusCode>=400){res.status(resp.statusCode).end();return;}res.setHeader('Content-Type',resp.headers['content-type']||'application/json');resp.pipe(res);}).on('error',e=>res.status(500).json({error:e.message}));});
app.post('/api/bunny-upload',(req,res)=>{const{zone,key,file}=req.query;if(!zone||!key||!file)return res.status(400).json({error:'Missing params'});const https=require('https');const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=Buffer.concat(chunks);const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/'+encodeURIComponent(file),method:'PUT',headers:{'AccessKey':key,'Content-Type':'video/mp4','Content-Length':body.length}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));});r.on('error',e=>res.status(500).json({error:e.message}));r.write(body);r.end();});});
app.delete('/api/bunny-delete',(req,res)=>{const{zone,key,file}=req.query;if(!zone||!key||!file)return res.status(400).json({error:'Missing params'});const https=require('https');const fname=decodeURIComponent(file);const r=https.request({hostname:'storage.bunnycdn.com',path:'/'+encodeURIComponent(zone)+'/'+fname,method:'DELETE',headers:{'AccessKey':key}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));});r.on('error',e=>res.status(500).json({error:e.message}));r.end();});
app.post('/api/render', upload.fields([{name:'video',maxCount:1},{name:'overlay',maxCount:1}]), (req, res) => {
  const vf = req.files['video']?.[0]; if (!vf) return res.status(400).json({ error: 'No video' });
  const of = req.files['overlay']?.[0];
  const ts = Math.max(0, parseFloat(req.body.trimStart)||0);
  const te = parseFloat(req.body.trimEnd)||0;
  const dur = te > ts ? te - ts : 0;
  const out = '/tmp/final_' + Date.now() + '.mp4';
  const rW = parseInt(req.body.videoW)||1080;
  const rH = parseInt(req.body.videoH)||1920;
  const clientPortrait = req.body.isPortrait === '1';
  const { spawn } = require('child_process');
  let _rendered = false;
  function doRender(tf) {
    if (_rendered) return; _rendered = true;
    tf = tf || '';
    const scaleF = tf + 'scale=' + rW + ':' + rH + ':force_original_aspect_ratio=decrease,pad=' + rW + ':' + rH + ':(ow-iw)/2:(oh-ih)/2';
    const fcOv = '[0:v]' + tf + 'scale=' + rW + ':' + rH + ':force_original_aspect_ratio=decrease,pad=' + rW + ':' + rH + ':(ow-iw)/2:(oh-ih)/2,format=yuv420p[base];[1:v]scale=' + rW + ':' + rH + ':force_original_aspect_ratio=disable,format=rgba[ov];[base][ov]overlay=0:0:format=auto,format=yuv420p';
    const trimArgs = dur > 0
      ? ['-ss', String(ts), '-i', vf.path, '-t', String(dur)]
      : ['-ss', String(ts), '-i', vf.path];
    const args = of
      ? ['-y',...trimArgs,'-i',of.path,'-filter_complex',fcOv,'-c:v','libx264','-preset','fast','-crf','17','-c:a','aac','-movflags','+faststart',out]
      : ['-y',...trimArgs,'-vf',scaleF,'-c:v','libx264','-preset','fast','-crf','17','-c:a','aac','-movflags','+faststart',out];
    const ff = spawn(FFMPEG_BIN, args);
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('close', code => {
      fs.unlink(vf.path, ()=>{});
      if (of) fs.unlink(of.path, ()=>{});
      if (code !== 0) return res.status(500).json({ error: 'FFmpeg failed', detail: err.slice(-400) });
      res.setHeader('Content-Type','video/mp4');
      const s = fs.createReadStream(out);
      s.pipe(res);
      s.on('end', () => fs.unlink(out, ()=>{}));
      s.on('error', () => fs.unlink(out, ()=>{}));
    });
    setTimeout(() => { ff.kill('SIGKILL'); if (!res.headersSent) res.status(500).json({ error: 'Timeout' }); }, 180000);
  }
  let FFPROBE_BIN = 'ffprobe';
  try { const s = require('ffprobe-static'); if(s && s.path) FFPROBE_BIN = s.path; } catch(e) {}
  const fbTimer = setTimeout(() => { doRender(clientPortrait ? 'transpose=1,' : ''); }, 4000);
  try {
    const probe = spawn(FFPROBE_BIN, ['-v','quiet','-print_format','json','-show_streams',vf.path]);
    let probeOut = '';
    probe.stdout.on('data', d => probeOut += d);
    probe.stderr.on('data', ()=>{});
    probe.on('error', () => { clearTimeout(fbTimer); doRender(clientPortrait ? 'transpose=1,' : ''); });
    probe.on('close', () => {
      clearTimeout(fbTimer);
      let tf = '';
      try {
        const info = JSON.parse(probeOut || '{}');
        const vs = info.streams?.find(s => s.codec_type==='video');
        const rot = Math.abs(parseInt(vs?.tags?.rotate || vs?.side_data_list?.[0]?.rotation || '0'));
        if (rot === 90) tf = 'transpose=1,';
        else if (rot === 270) tf = 'transpose=2,';
        if (!tf && clientPortrait && vs) {
          const rawW = parseInt(vs.width)||0; const rawH = parseInt(vs.height)||0;
          if (rawW > rawH) tf = 'transpose=1,';
        }
      } catch(e) {}
      doRender(tf);
    });
  } catch(e) { clearTimeout(fbTimer); doRender(clientPortrait ? 'transpose=1,' : ''); }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v2.4 on port ' + PORT));
