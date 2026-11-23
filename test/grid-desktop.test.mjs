// Standalone native desktop protocol regression. No DSH app/profile, live backend, or downloaded dependencies.
// VIG_ELECTRON may name an unpackaged Electron executable. Otherwise use an isolated copy of available runtime files.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
const repo=fileURLToPath(new URL('..',import.meta.url)), baseline='757b38b';
const reactRoot=process.env.VIG_REACT_ROOT || 'G:/Gg-gank/frontend/deeix-chat/frontend/node_modules';
const resolve=createRequire(path.join(reactRoot,'anchor.cjs'));
const srcJs=await fs.readFile(path.join(repo,'client.js'),'utf8'), oldJs=execFileSync('git',['show',baseline+':client.js'],{cwd:repo,maxBuffer:4<<20,encoding:'utf8'});
const cjs=(name,file)=>path.join(path.dirname(resolve.resolve(name)),'cjs',file);
const modules={react:cjs('react','react.development.js'),'react-dom':cjs('react-dom','react-dom.development.js'),'react-dom/client':cjs('react-dom','react-dom-client.development.js'),scheduler:path.join(path.dirname(createRequire(resolve.resolve('react-dom')).resolve('scheduler')),'cjs','scheduler.development.js')};
const registry=`const factories={},cache={};function req(id){if(!cache[id]){const m=cache[id]={exports:{}};factories[id](m,m.exports,req);}return cache[id].exports;}\n`+Object.entries(modules).map(([id,p])=>`factories[${JSON.stringify(id)}]=function(module,exports,require){const process={env:{NODE_ENV:'development'}};\n${readFileSync(p,'utf8')}\n};`).join('\n');
// Use 8-bit palette PNGs to avoid allocating a full-size 28 MP RGBA buffer just to build the fixture.
function png(w,h,palette) {
  const crc32=bytes=>{let v=-1;for (const b of bytes){v^=b;for(let k=0;k<8;k++)v=v>>>1^((v&1)?0xedb88320:0);}return ~v>>>0;};
  const chunk=(kind,b)=>{const x=Buffer.concat([Buffer.from(kind),b]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(b.length);tail.writeUInt32BE(crc32(x));return Buffer.concat([head,x,tail]);};
  const raw=Buffer.alloc((w+1)*h),head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=3;
  if(palette.length===6) for(let y=0;y<h;y++)for(let c=0;c<3;c++){const start=y*(w+1)+1;raw.fill((y<h/2?0:3)+c,start+Math.round(c*w/3),start+Math.round((c+1)*w/3));}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('PLTE',Buffer.from(palette.flat())),chunk('IDAT',deflateSync(raw,{level:3})),chunk('IEND',Buffer.alloc(0))]);
}
async function scenario(old) {
  const from='/api/velapi-image-go/asset/sheet.png', output='/api/velapi-image-go/asset/patch.png';
  const source={id:'sheet',assetId:'sheet',name:'sheet.png',width:8192,height:3456,url:from};
  const job={id:'desktop-job',prompt:'桌面六宫格',model:'gpt-image-2',status:'succeeded',conversationId:'conv_test',images:[source],createdAt:'2026-01-01T00:00:00Z'};
  const generated={...job,id:'desktop-patch',images:[{assetId:'patch',name:'patch.png',url:output,width:48,height:32}]};
  const bodies=[],native=window.fetch.bind(window),seenImages=[];
  const strict=(condition,msg)=>{if(!condition)throw Error(msg);};
  const utc=(o)=>new Response(JSON.stringify(o),{headers:{'content-type':'application/json'}});
  window.fetch=async(input,init={})=>{
    const u=new URL(typeof input==='string'?input:input.url||String(input),location.href);
    strict(u.hostname==='app' && u.protocol==='dsh-app:','non-fixture fetch '+u.href);
    if(u.pathname===from||u.pathname===output){seenImages.push(u.href);return native(input,init);}
    const route=u.pathname.replace('/api/velapi-image-go','');
    if(route==='/status')return utc({ok:true,config:{defaultModel:'gpt-image-2',defaultQuality:'LOW',defaultSize:'1024x1024',defaultCount:1,defaultEndpoint:'auto',hasKey:true,activeProviderId:'p'},protocols:[{id:'auto',kind:'auto'}]});
    if(route==='/capabilities')return utc({ok:true,electron:true,nativeDrag:true,clipboard:true});
    if(route==='/conversations')return utc({ok:true,items:[{id:'conv_test',title:'桌面测试'}]});
    if(route==='/providers')return utc({ok:true,items:[{id:'p',name:'test',enabled:true,keyMask:'fixture',models:['gpt-image-2'],modelMeta:{'gpt-image-2':{kind:'image'}}}]});
    if(route==='/library')return utc({ok:true,items:[source],total:1});
    if(route==='/jobs')return utc({ok:true,items:[job],pending:0});
    if(route==='/generate'){bodies.push(JSON.parse(init.body));return utc({ok:true,job:generated});}
    if(route==='/job')return utc({ok:true,job:generated});
    return utc({ok:true,items:[]});
  };
  const ui=window.record.factory(req).__internals, root=req('react-dom/client').createRoot(document.querySelector('main'));
  const click=el=>req('react-dom').flushSync(()=>el.click());
  const $=sel=>document.querySelector(sel), ctrl=s=>$('[data-grid-'+s+']');
  async function until(fn,msg){for(let i=0;i<250;i++){const x=fn();if(x)return x;await new Promise(r=>setTimeout(r,30));}throw Error('timeout: '+msg+'; editor='+ctrl('editor')?.innerText);}
  req('react-dom').flushSync(()=>root.render(req('react').createElement(ui.Workbench,{})));
  const img=await until(()=>$('.vig-shot-img img')?.naturalWidth&&$('.vig-shot-img img'),'card decoded');
  strict(location.href.startsWith('dsh-app://app/') && img.currentSrc==='dsh-app://app'+from && img.naturalWidth===8192 && img.naturalHeight===3456,'expected real 8K desktop card');
  let sourceDraws=0;const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(source===img)sourceDraws++;return draw.call(this,source,...args);};
  try {
    click(img.closest('.vig-shot').querySelector('[data-grid-open]'));
    const loaded=await until(()=>ctrl('editor') && (ctrl('canvas')||ctrl('editor').querySelector('[role="alert"]')),'grid open');
    if(old){strict(loaded.tagName!=='CANVAS' && loaded.textContent.includes('无法读取图片'),'old client should reject custom scheme: '+loaded.textContent);return {status:'old error reproduced',page:location.href,realImage:img.currentSrc,size:[img.naturalWidth,img.naturalHeight],error:loaded.textContent};}
    strict(loaded.tagName==='CANVAS' && loaded.width===8192 && loaded.height===3456 && document.querySelectorAll('[data-grid-cell]').length===6 && sourceDraws>=1,'grid did not use decoded card');
    const sample=(c,x,y)=>[...c.getContext('2d').getImageData(x,y,1,1).data];
    const originals=[[231,45,61],[15,160,90],[39,81,202],[227,151,20],[158,64,222],[20,153,189]];
    const points=originals.map((_,i)=>[Math.floor((i%3+.5)*8192/3), Math.floor((Math.floor(i/3)+.5)*3456/2)]);
    strict(points.every(([x,y],i)=>sample(loaded,x,y).join()===originals[i].concat(255).join()),'wrong source pixels');
    click($('[data-grid-cell="4"]'));
    const mode=ctrl('mode'), prompt=ctrl('prompt');req('react-dom').flushSync(()=>{mode.value='generate';mode.dispatchEvent(new Event('change',{bubbles:true}));});
    req('react-dom').flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(prompt,'桌面协议测试');prompt.dispatchEvent(new Event('input',{bubbles:true}));});
    click(ctrl('generate'));const candidate=await until(()=>ctrl('candidate')?.naturalWidth && ctrl('candidate'),'same-scheme candidate');
    const candidateUrl=candidate.currentSrc;strict(candidateUrl==='dsh-app://app'+output && candidate.naturalWidth===48 && bodies.length===1,'wrong candidate URL or native dimensions');
    click(ctrl('apply'));const edited=await until(()=>!ctrl('candidate')&&ctrl('canvas'),'apply');
    strict(points.every(([x,y],i)=>sample(edited,x,y).join()===(i===4?[254,17,180]:originals[i]).concat(255).join()),'changed unrelated grid pixels');
    strict(!seenImages.includes(img.currentSrc),'grid re-fetched the visible source');
    return {status:'6 cells; candidate applied to cell 5 only',page:location.href,realImage:img.currentSrc,size:[8192,3456],sourceDraws,sourceFetch:0,candidate:candidateUrl};
  } finally{CanvasRenderingContext2D.prototype.drawImage=draw;req('react-dom').flushSync(()=>root.unmount());}
}
const appCode = `const {app,BrowserWindow,protocol,session}=require('electron'),fs=require('node:fs'),path=require('node:path');
const dir=process.env.VIG_GRID_ISOLATED;app.disableHardwareAcceleration();app.setPath('userData',path.join(dir,'user'));app.setPath('sessionData',path.join(dir,'user'));app.setPath('crashDumps',path.join(dir,'crash'));app.setAppLogsPath(path.join(dir,'logs'));
protocol.registerSchemesAsPrivileged([{scheme:'dsh-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true,codeCache:true}}]);
let win;async function run(){await app.whenReady();const ses=session.fromPartition('grid-standalone');const files={'/react.js':['react.js','text/javascript'],'/old.js':['old.js','text/javascript'],'/current.js':['current.js','text/javascript'],'/api/velapi-image-go/asset/sheet.png':['sheet.png','image/png'],'/api/velapi-image-go/asset/patch.png':['patch.png','image/png']};
ses.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!(/^(?:dsh-app:\\/\\/app\\/|blob:|data:|about:blank$)/.test(d.url))}));
ses.protocol.handle('dsh-app',async req=>{const u=new URL(req.url);if(u.host!=='app'||req.method!=='GET')return new Response('fixture only',{status:403});if(u.pathname==='/'){const which=u.searchParams.get('build')==='old'?'old':'current';return new Response('<!doctype html><meta charset=utf-8><main style="width:960px;height:720px"></main><script>window.__ModuleLoader__={load:r=>window.record=r};</script><script src="/react.js"></script><script src="/'+which+'.js"></script>',{headers:{'content-type':'text/html; charset=utf-8'}});} const f=files[u.pathname];return f?new Response(fs.readFileSync(path.join(dir,f[0])),{headers:{'content-type':f[1]}}):new Response('unknown fixture',{status:404});});
const reports=[];for(const which of ['old','current']){win=new BrowserWindow({show:false,width:1120,height:860,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadURL('dsh-app://app/?build='+which);reports.push(await win.webContents.executeJavaScript('('+${JSON.stringify(scenario.toString())}+')('+JSON.stringify(which==='old')+')'));win.destroy();}return reports;}
app.on('window-all-closed',()=>{});run().then(reports=>{fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({reports,electron:process.versions.electron}));app.exit(0);},err=>{fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({error:String(err.stack||err)}));app.exit(1);});`;
const desktop=process.env.DSH_NODE_EXECUTABLE||'G:/deepseek-harness/DeepSeek Harness.exe';
let dev=process.env.VIG_ELECTRON; if(!dev)try{const guess=resolve('electron');if(typeof guess==='string' && existsSync(guess))dev=guess;}catch{}
if(dev && (!/^(electron|electron\.exe)$/i.test(path.basename(dev))||!existsSync(dev)))throw Error('VIG_ELECTRON must point to the actual unbundled developer Electron executable');
const base=path.resolve(dev?tmpdir():(path.parse(desktop).root===path.parse(tmpdir()).root?tmpdir():existsSync(path.join(path.parse(desktop).root,'tmp'))?path.join(path.parse(desktop).root,'tmp'):tmpdir()));
const dir=await fs.mkdtemp(path.join(base,'vig-desktop-qa-'));let child,timer,exit;
try {
  let binary=dev;const application=path.join(dir,'app');await fs.mkdir(application);const pack={name:'vig-desktop-fixture',version:'1.0.0',main:'main.cjs'};
  if(!dev){
    assert.ok(existsSync(desktop),'Supply VIG_ELECTRON or a readable installed Electron runtime');const source=path.dirname(desktop), copy=path.join(dir,'runtime');await fs.mkdir(copy);
    const link=async(from,to)=>{try{await fs.link(from,to);}catch{await fs.copyFile(from,to);}};
    binary=path.join(copy,path.basename(desktop));await link(desktop,binary);
    // Only allowlisted runtime support files. Never copy installed resources/app.asar, external plugins, config or profile.
    for(const name of ['chrome_100_percent.pak','chrome_200_percent.pak','resources.pak','icudtl.dat','snapshot_blob.bin','v8_context_snapshot.bin','ffmpeg.dll','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll'])if(existsSync(path.join(source,name)))await link(path.join(source,name),path.join(copy,name));
    await fs.mkdir(path.join(copy,'locales'));for(const name of ['en-US.pak','zh-CN.pak'])if(existsSync(path.join(source,'locales',name)))await link(path.join(source,'locales',name),path.join(copy,'locales',name));
    const target=path.join(copy,'resources','app');await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'package.json'),JSON.stringify(pack));await fs.writeFile(path.join(target,'main.cjs'),appCode);
  }
  await fs.writeFile(path.join(application,'package.json'),JSON.stringify(pack));await fs.writeFile(path.join(application,'main.cjs'),appCode);
  await Promise.all(['user','logs','crash','temp','roaming','local'].map(d=>fs.mkdir(path.join(dir,d))));
  for(const [name,data] of [['old.js',oldJs],['current.js',srcJs],['react.js',registry],['sheet.png',png(8192,3456,[[231,45,61],[15,160,90],[39,81,202],[227,151,20],[158,64,222],[20,153,189]])],['patch.png',png(48,32,[[254,17,180]])]])await fs.writeFile(path.join(dir,name),data);
  const env={...process.env,VIG_GRID_ISOLATED:dir,APPDATA:path.join(dir,'roaming'),LOCALAPPDATA:path.join(dir,'local'),TEMP:path.join(dir,'temp'),TMP:path.join(dir,'temp'),LANG:'en_US.UTF-8'};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;console.log('Native Electron fixture:',dev?'unpackaged developer binary':'isolated runtime copy (without DSH resources or app.asar)', 'baseline',baseline);
  child=spawn(binary,[...(dev?[application]:[]),'--no-error-dialogs','--lang=en-US','--disable-background-networking','--disable-sync','--disable-gpu','--user-data-dir='+path.join(dir,'user')],{cwd:dir,env,stdio:'inherit',windowsHide:true});
  exit=new Promise((ok,fail)=>{child.once('error',fail);child.once('exit',(code)=>ok(code));});
  timer=setTimeout(()=>{console.error('Desktop protocol regression timed out');child.kill();},35000);
  const code=await exit, file=path.join(dir,'result.json');if(!existsSync(file))throw Error('No result from isolated Electron (exit '+code+'); do not bypass runtime fuses; use VIG_ELECTRON');
  const result=JSON.parse(await fs.readFile(file,'utf8'));if(result.error)throw Error(result.error);assert.equal(code,0);assert.equal(result.reports.length,2);console.log(JSON.stringify(result,null,2));
} finally {
  clearTimeout(timer);if(child && child.exitCode===null && !child.killed && child.pid){child.kill();await exit;}
  assert.equal(path.dirname(dir),base);assert.ok(path.basename(dir).startsWith('vig-desktop-qa-'));await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
