// Real navigation from Workbench chat into an EMPTY PsView. No initial URL, fetch patch or real user assets.
// node test/ps-entry-perf.test.mjs [--before]  (--before runs the client from 88d9869 without changing the tree).
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';

const repo=fileURLToPath(new URL('../',import.meta.url)), before=process.argv.includes('--before');
const ref='88d9869', api='/api/velapi-image-go';
const client=before?execFileSync('git',['show',ref+':client.js'],{cwd:repo,encoding:'utf8',maxBuffer:8<<20}):readFileSync(path.join(repo,'client.js'),'utf8');
const chrome=process.env.VIG_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const require=createRequire(path.resolve(process.env.VIG_REACT_ROOT||'G:/Gg-gank/frontend/deeix-chat/frontend/node_modules','fixture.cjs'));
const js=(r,pkg,file)=>readFileSync(path.join(path.dirname(r.resolve(pkg)),'cjs',file+'.development.js'),'utf8');
const libraries={react:js(require,'react','react'),'react-dom':js(require,'react-dom','react-dom'),'react-dom/client':js(require,'react-dom','react-dom-client'),scheduler:js(createRequire(require.resolve('react-dom')),'scheduler','scheduler')};
const vendor=`const factories={},cache={};function req(id){if(!cache[id]){const m=cache[id]={exports:{}};factories[id](m,m.exports,req);}return cache[id].exports;}\n`+Object.entries(libraries).map(([key,src])=>`factories[${JSON.stringify(key)}]=function(module,exports,require){const process={env:{NODE_ENV:'development'}};\n${src}\n};`).join('\n');

// Thumbnail and original use different colours; only the original has 960×640 dimensions.
function png(w,h,r,g,b){
 const chunk=(tag,bytes)=>{const t=Buffer.from(tag);let crc=-1;for(const n of Buffer.concat([t,bytes])){crc^=n;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const len=Buffer.alloc(4),end=Buffer.alloc(4);len.writeUInt32BE(bytes.length);end.writeUInt32BE((~crc)>>>0);return Buffer.concat([len,t,bytes,end]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
 const row=Buffer.alloc(w*3+1);for(let i=1;i<row.length;i+=3){row[i]=r;row[i+1]=g;row[i+2]=b;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array(h).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
const thumbs=png(160,100,211,150,76),original=png(960,640,22,80,170),sample=png(720,400,190,150,42);
const library=Array.from({length:200},(_,i)=>({id:`img_${i}`,name:`photo-${i}.png`,url:`${api}/asset/photo-${i}.png`,thumbUrl:`${api}/asset/thumb-${i}.png`,width:960,height:640}));
const presets=Array.from({length:12},(_,i)=>({id:`p${i}`,title:`sample-${i}`,prompt:'fixture',image:`${api}/preset/sample-${i}.png`}));
const config={defaultSize:'1024x1024',defaultModel:'',shortcuts:'',defaultEndpoint:'auto',hasKey:false};

async function exercise(before,picker){
 const React=req('react'), {flushSync}=req('react-dom'), root=req('react-dom/client').createRoot(document.getElementById('root'));
 const ui=window.record.factory(req).__internals, stylesheet=document.createElement('style');stylesheet.textContent=ui.CSS;document.head.append(stylesheet);
 const $=s=>document.querySelector(s),all=s=>[...document.querySelectorAll(s)],sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
 const until=async(fn,label)=>{const end=performance.now()+9000;while(performance.now()<end){if(fn())return;await sleep(30);}throw Error('Timed out: '+label);};
 const check=(value,label)=>{if(!value)throw Error(label);},click=el=>{check(el,'missing control');flushSync(()=>el.click());};
 const phase=k=>fetch('/phase/'+k,{method:'POST'}).then(r=>r.json()),metrics=()=>fetch('/metrics').then(r=>r.json());
 const waitImages=async(sel)=>{await until(()=>all(sel).some(el=>el.complete&&el.naturalWidth>0),'decode '+sel);await sleep(280);};
 const previewReport=async(sel)=>{const elements=all(sel);return {mounted:elements.length,decoded:elements.filter(x=>x.complete&&x.naturalWidth>0).length,blob:elements.filter(x=>(x.currentSrc||'').startsWith('blob:')).length,...await metrics()};};
 const okThumbs=m=>m.fetch>0&&m.fetch<=m.mounted&&m.image===0&&m.fetchPeak<=2&&m.blob>0;
 const onlyPrepared=m=>m.paths.every(p=>/\/asset\/thumb-\d+\.png$/.test(p));
 const navTo=id=>click($(`[data-page="${id}"]`));
 localStorage.setItem('dsh.velapi-image-go.view','chat');localStorage.setItem('dsh.velapi-image-go.side','0');
 flushSync(()=>root.render(React.createElement(ui.Workbench)));
 await until(()=>$('.vig-nav-foot-val')?.textContent==='200'&&$('[data-page="ps"]'),'200 metadata rows ready');await sleep(240);
 await phase(picker?'pickerEntry':'entry');const start=performance.now();navTo('ps');
 await until(()=>$('.vig-ps-empty'),'blank PS entry');const toEmptyMs=+(performance.now()-start).toFixed(1);
 // Give both native lazy loading and effect-driven thumbnails a chance to hit the local server.
 await sleep(550);
 const entry=await previewReport('.vig-ps-empty img'), output={toEmptyMs,entry};
 if(before){check(entry.mounted>=24&&entry.image>0,'baseline did not reproduce direct page-entry requests');}
 else {check(entry.mounted===0&&!entry.requests,'closed entry should create zero img elements and zero asset GETs: '+JSON.stringify(entry));}
 const group=key=>$(`[data-ps-browse="${key}"]`),expanded=button=>button?.getAttribute('aria-expanded')==='true';
 if(!before)check(group('recent')&&group('samples')&&!expanded(group('recent'))&&!expanded(group('samples')),'both shelves independently closed');
 if(picker){
   await phase('picker');click($('.vig-ps-empty .vig-row button:nth-of-type(2)'));
   const sel='dialog .vig-tile img';await waitImages(sel);output.picker=await previewReport(sel);
   if(!before)check(okThumbs(output.picker)&&onlyPrepared(output.picker),'picker not queued on demand: '+JSON.stringify(output.picker));
   else check(output.picker.mounted>0&&output.picker.image>0,'legacy picker did not fetch full images');
 }else if(!before){
   await phase('recent');click(group('recent'));
   const cards='.vig-ps-empty .vig-ps-recent-tile',sel=cards+' img';await waitImages(sel);output.recent=await previewReport(sel);
   check(expanded(group('recent'))&&!expanded(group('samples'))&&output.recent.mounted===8&&okThumbs(output.recent)&&onlyPrepared(output.recent),'first 8 recent thumbnails: '+JSON.stringify(output.recent));
   const more=group('recent').parentElement.querySelector('button.vig-link');check(more,'more recent assets accessible');click(more);check(all(cards).length===16,'next recent batch adds only 8');
   await sleep(350);click(group('recent'));check(all(cards).length===0,'closing recent unmounts images');
   await phase('samples');click(group('samples'));await waitImages(sel);output.samples=await previewReport(sel);
   check(!expanded(group('recent'))&&expanded(group('samples'))&&output.samples.mounted===8&&okThumbs(output.samples),'first 8 preset previews: '+JSON.stringify(output.samples));
   click(group('samples'));click(group('recent'));await waitImages(sel);await phase('open');
   const selected=all(cards).find(b=>b.title==='photo-2.png');click(selected);
   await until(()=>$('.vig-toolbar')?.textContent.includes('photo-2.png')&&$('.vig-toolbar').textContent.includes('960×640')&&$('.vig-ps-canvas')?.width>1,'selected full original');
   const view=$('.vig-ps-canvas');const color=[...view.getContext('2d').getImageData(1,1,1,1).data];output.open={name:selected.title,color,...await metrics()};
   check(output.open.paths.length===1&&output.open.paths[0].endsWith('/asset/photo-2.png')&&color.join()==='22,80,170,255','selection must load requested full original: '+JSON.stringify(output.open));
 }
 flushSync(()=>root.unmount());return output;
}

const blank=()=>({requests:0,image:0,fetch:0,fetchPeak:0,paths:[]});let stats=blank(),inFlight=0;
let settle,reject;const done=new Promise((ok,fail)=>{settle=ok;reject=fail;});const reports={};
const server=createServer(async (req,res)=>{
 const u=new URL(req.url,'http://localhost'),p=u.pathname;
 const reply=(payload,kind='application/json',code=200)=>{res.writeHead(code,{'cache-control':'no-store','content-type':kind});res.end(typeof payload==='string'||Buffer.isBuffer(payload)?payload:JSON.stringify(payload));};
 if(p==='/')return reply(`<!doctype html><meta charset="utf-8"><title>PS entry</title><style>html,body{margin:0}#root{width:960px;height:760px;display:flex}</style><div id="root"></div><script>window.__ModuleLoader__={load:r=>window.record=r}</script><script src="/client.js"></script><script src="/vendor.js"></script><script src="/driver.js"></script>`,'text/html;charset=utf-8');
 if(p==='/client.js')return reply(client,'text/javascript;charset=utf-8');if(p==='/vendor.js')return reply(vendor,'text/javascript;charset=utf-8');
 if(p==='/driver.js')return reply(`const picker=location.search==='?picker';(${exercise.toString()})(${before},picker).then(async result=>{await fetch('/result?'+(picker?'picker':'entry'),{method:'POST',body:JSON.stringify(result)});if(!picker)location.href='/?picker';}).catch(e=>fetch('/result',{method:'POST',body:JSON.stringify({error:String(e.stack||e)})}));`,'text/javascript;charset=utf-8');
 if(p.startsWith('/phase/')){stats=blank();inFlight=0;return reply({});}if(p==='/metrics')return reply(stats);
 if(p==='/result'){let text='';for await(const chunk of req)text+=chunk;try{const data=JSON.parse(text);if(data.error)reject(Error(data.error));else{reports[u.search.slice(1)]=data;if(reports.picker)settle(reports);}}catch(e){reject(e);}return reply({});}
 if(p.startsWith(api+'/asset/')||p.startsWith(api+'/preset/')){
   const bucket=stats,dest=req.headers['sec-fetch-dest'];bucket.requests++;bucket.paths.push(p);if(dest==='image')bucket.image++;else if(dest==='empty'){bucket.fetch++;bucket.fetchPeak=Math.max(bucket.fetchPeak,++inFlight);}
   // Serve slowly enough to observe overlapping fetches, without delaying unrelated JSON responses.
   res.once('close',()=>{if(bucket===stats&&dest==='empty')inFlight--;});await new Promise(ok=>setTimeout(ok,30));
   return reply(p.includes('/thumb-')?thumbs:p.includes('/sample-')?sample:original,'image/png');
 }
 if(p.startsWith(api+'/')){let data={ok:true,items:[]};switch(p.slice(api.length)){
   case '/presets':data.items=presets;break;case '/library':data={ok:true,items:library,total:library.length};break;
   case '/status':data={ok:true,config,presets,protocols:[],chatModels:[]};break;case '/config':data={ok:true,config};break;
   case '/conversations':data.items=[{id:'conv_default',title:'Default'}];break;
 }return reply(data);}
 return reply('','text/plain',404);
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});const profile=mkdtempSync(path.join(os.tmpdir(),'vig-ps-entry-'));
let child,ended,timer;try{
 child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--disable-sync','--disable-background-networking','--window-size=1280,1000','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore',windowsHide:true});
 ended=new Promise(ok=>{child.once('error',e=>{reject(e);ok();});child.once('exit',code=>{reject(Error('Chrome exited '+code));ok();});});
 timer=setTimeout(()=>reject(Error('PS entry test timed out')),45000);
 const r=await done;assert.ok(r.entry&&r.picker);console.log(JSON.stringify({baseline:before?ref:'working tree',...r},(k,v)=>k==='paths'&&v.length>5?`${v.length} requested paths`:v,2));
}finally{clearTimeout(timer);if(child){child.kill();await ended;}server.closeAllConnections();await new Promise(ok=>server.close(ok));if(path.dirname(profile)===path.resolve(os.tmpdir())&&path.basename(profile).startsWith('vig-ps-entry-'))rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
