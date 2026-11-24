// Real-time Chrome benchmark for opening an existing 8K PsView document.
// node test/ps-open-perf.test.mjs [--before]
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';

const repo=fileURLToPath(new URL('../',import.meta.url));
const before=process.argv.includes('--before');
const ref='9d0264a';
const source=before?execFileSync('git',['show',`${ref}:client.js`],{cwd:repo,encoding:'utf8',maxBuffer:16<<20}):readFileSync(path.join(repo,'client.js'),'utf8');
const chrome=process.env.VIG_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const reactRoot=process.env.VIG_REACT_ROOT||'G:/Gg-gank/frontend/deeix-chat/frontend/node_modules';
const resolve=createRequire(path.resolve(reactRoot,'ps-perf-fixture.cjs'));
const cjs=(r,file)=>path.join(path.dirname(r.resolve('react-dom')),'cjs',file);
const modules={
  react:path.join(path.dirname(resolve.resolve('react')),'cjs','react.development.js'),
  'react-dom':cjs(resolve,'react-dom.development.js'),
  'react-dom/client':cjs(resolve,'react-dom-client.development.js'),
  scheduler:path.join(path.dirname(createRequire(resolve.resolve('react-dom')).resolve('scheduler')),'cjs','scheduler.development.js')
};
const registry=`const factories={},cache={};function req(k){if(!cache[k]){const m=cache[k]={exports:{}};factories[k](m,m.exports,req);}return cache[k].exports;}\n`+
 Object.entries(modules).map(([id,file])=>`factories[${JSON.stringify(id)}]=function(module,exports,require){const process={env:{NODE_ENV:'development'}};\n${readFileSync(file,'utf8')}\n};`).join('\n');

function png(width,height){
 const chunk=(type,data)=>{const name=Buffer.from(type),parts=Buffer.concat([name,data]);let crc=-1;for(const byte of parts){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4),end=Buffer.alloc(4);size.writeUInt32BE(data.length);end.writeUInt32BE((~crc)>>>0);return Buffer.concat([size,name,data,end]);};
 const row=Buffer.alloc(width*3+1);for(let x=0;x<width;x++){const at=1+x*3;row[at]=x&255;row[at+1]=(x*3)&255;row[at+2]=190;}
 const raw=Buffer.alloc(row.length*height);for(let y=0;y<height;y++)row.copy(raw,y*row.length);
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
}
const pngUrl='data:image/png;base64,'+png(8192,3456).toString('base64');

async function audit(){
  const React=req('react'),{flushSync}=req('react-dom'),{createRoot}=req('react-dom/client');
  const ui=window.record.factory(req).__internals,host=document.querySelector('#host');
  const style=document.createElement('style');style.textContent=ui.CSS;document.head.append(style);
  const fetchReal=window.fetch;
  window.fetch=async()=>new Response(JSON.stringify({ok:true,config:{shortcuts:''}}),{headers:{'content-type':'application/json'}});
  const root=createRoot(host),start=performance.now();
  flushSync(()=>root.render(React.createElement(ui.PsView,{state:{library:[],presets:[]},actions:{toast(){}},initialUrl:{name:'8k.png',dataUrl:window.__imageDataUrl},onConsumeInitialUrl(){}})));
  const commitMs=performance.now()-start;
  const waitFor=async(check)=>{const until=Date.now()+12000;while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,16));}throw Error('timed out waiting for first preview');};
  await waitFor(()=>{const canvas=host.querySelector('.vig-ps-canvas');return canvas?.width>1&&canvas?.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data[3]===255;});
  const readyMs=performance.now()-start,view=host.querySelector('.vig-ps-canvas'),overlay=host.querySelector('.vig-ps-overlay');
  const result={baseline:window.__baseline,source:[8192,3456],css:[parseFloat(view.style.width),parseFloat(view.style.height)],view:[view.width,view.height],overlay:[overlay.width,overlay.height],extraMiB:+(((view.width*view.height+overlay.width*overlay.height)*4/1048576).toFixed(1)),commitMs:+commitMs.toFixed(1),firstPreviewMs:+readyMs.toFixed(1)};
  flushSync(()=>root.unmount());window.fetch=fetchReal;
  fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
}

const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#host{width:1020px;height:760px;display:flex}</style><main id="host" class="vig-root"></main>
<script>window.__baseline=${before};window.__imageDataUrl=${JSON.stringify(pngUrl)};window.__ModuleLoader__={load:r=>window.record=r};</script><script>${source}</script><script>${registry}</script>
<script>(${audit.toString()})().catch(error=>fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({error:String(error.stack||error)})}));</script>`;
let resolveResult,rejectResult;
const observed=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
const server=createServer(async(req,res)=>{
 if(req.url==='/'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);return;}
 if(req.url==='/result'&&req.method==='POST'){let body='';for await(const part of req)body+=part;res.end('ok');try{const result=JSON.parse(body);result.error?rejectResult(Error(result.error)):resolveResult(result);}catch(e){rejectResult(e);}return;}
 res.writeHead(404);res.end();
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const profile=mkdtempSync(path.join(os.tmpdir(),'vig-ps-open-perf-'));
let child,exited,timer;
try{
 child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--disable-sync','--window-size=1280,900','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore',windowsHide:true});
 exited=new Promise(resolve=>{child.once('error',error=>{rejectResult(error);resolve();});child.once('exit',()=>resolve());});
 timer=setTimeout(()=>rejectResult(Error('Chrome benchmark timed out')),30000);
 const result=await observed;console.log(JSON.stringify(result,null,2));
 if(!before)assert.ok(result.view[0]<4096&&result.overlay[0]===1&&result.overlay[1]===1,'large image must use a screen-sized preview and defer the idle overlay');
}finally{
 clearTimeout(timer);if(child){child.kill();await exited;}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(path.dirname(profile)===path.resolve(os.tmpdir())&&path.basename(profile).startsWith('vig-ps-open-perf-'))rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
