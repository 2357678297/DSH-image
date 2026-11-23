// Real Chrome + real React. Only the asset service and the surrounding app actions are fixtures.
// node test/gallery-perf.test.mjs --baseline   # pre-pagination commit aee97ba
// node test/gallery-perf.test.mjs              # current working tree
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.includes('--baseline');
const ref = 'aee97bad643f020cb8d91089090acb35ec818392';
const source = baseline ? execFileSync('git', ['show', ref + ':client.js'], { cwd:repo, encoding:'utf8', maxBuffer:8<<20 }) : readFileSync(path.join(repo,'client.js'),'utf8');
const chrome = process.env.VIG_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const reactRoot = process.env.VIG_REACT_ROOT || 'G:/Gg-gank/frontend/deeix-chat/frontend/node_modules';
const resolve = createRequire(path.resolve(reactRoot,'gallery-fixture.cjs'));
const cjs = (name,file) => path.join(path.dirname(resolve.resolve(name)),'cjs',file);
const modules = {
  react:cjs('react','react.development.js'), 'react-dom':cjs('react-dom','react-dom.development.js'),
  'react-dom/client':cjs('react-dom','react-dom-client.development.js'),
  scheduler:path.join(path.dirname(createRequire(resolve.resolve('react-dom')).resolve('scheduler')),'cjs','scheduler.development.js')
};
const registry = `const factories={}, cache={}; function req(k){ if (!cache[k]) {const m=cache[k]={exports:{}};factories[k](m,m.exports,req);}return cache[k].exports; }\n` + Object.entries(modules).map(([name,file])=>`factories[${JSON.stringify(name)}]=function(module,exports,require){const process={env:{NODE_ENV:'development'}};\n${readFileSync(file,'utf8')}\n};`).join('\n');

// Generate two real, inexpensive raster assets without external packages / user images. URLs are unique;
// contents are flat colours, not representative photographic compression or bandwidth benchmarks.
function png(w,h) {
  const chunk=(type,bytes)=>{const head=Buffer.from(type);let crc=-1;for(const b of Buffer.concat([head,bytes])){crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4), end=Buffer.alloc(4);size.writeUInt32BE(bytes.length);end.writeUInt32BE((~crc)>>>0);return Buffer.concat([size,head,bytes,end]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(w*3+1);for(let i=1;i<row.length;i+=3){row[i]=30;row[i+1]=120;row[i+2]=205;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array(h).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}

async function inBrowser(baseline) {
  const React=req('react'), h=React.createElement, flush=req('react-dom').flushSync;
  const ui=window.record.factory(req).__internals, host=document.getElementById('host');
  const style=document.createElement('style');style.textContent=ui.CSS;document.head.appendChild(style);
  const library=Array.from({length:200},(_,i)=>{
    const num=String(i+1).padStart(3,'0'), big=i===12;
    return {id:'img_'+num, name:`item-${num}.png`, url:`/api/velapi-image-go/asset/img_${num}.png`, model:i%2?'model-b':'model-a', width:big?4096:640, height:big?2048:320, prompt:i===199?'only-last':'example', createdAt:'2026-11-01T00:00:00Z'};
  });
  let created=0;
  for(const name of ['createElement','createElementNS']) {const native=document[name].bind(document);document[name]=(...args)=>{created++;return native(...args);};}
  const state={library,providers:[],libraryTotal:library.length};
  function Harness(){const [v,set]=React.useState(null);
    const actions={ openViewer:(items,index)=>set({items,index}), reloadLibrary:async()=>{}, toast:()=>{} };
    return h(React.Fragment,null,h(ui.LibraryView,{state,actions}),v&&h(ui.ImageViewer,{...v,onIndex:index=>set({...v,index}),onClose:()=>set(null)}));
  }
  const $=s=>host.querySelector(s), $$=s=>[...host.querySelectorAll(s)];
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(pred,label)=>{const end=performance.now()+6500;while(performance.now()<end){if(pred())return;await wait(30);}throw Error('timeout: '+label);};
  const stats=()=>fetch('/stats',{cache:'no-store'}).then(r=>r.json());
  const check=(ok,label,detail)=>{if(!ok)throw Error(label+' '+JSON.stringify(detail));};
  const click=el=>{check(el,'missing control');flush(()=>el.click());};
  const search=value=>{const el=$('.vig-toolbar input');flush(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});};
  const loaded=el=>el?.complete&&el.naturalWidth>0;
  const view=()=>Array.from($$('.vig-viewmode-btn'));
  const modal=()=>$('.vig-viewer');
  const openAndRead=async(el,label)=>{click(el);await until(()=>loaded($('.vig-viewer-img')),label);const img=$('.vig-viewer-img');return {elements:modal().querySelectorAll('*').length, imgElements:modal().querySelectorAll('img').length, counter:$('.vig-viewer-count')?.textContent, title:$('.vig-viewer-title')?.textContent, naturalWidth:img.naturalWidth, url:img.getAttribute('src')};};
  const totalCreated=()=>created;
  const root=req('react-dom/client').createRoot(host);flush(()=>root.render(h(Harness)));
  await until(()=>loaded($('.vig-tile img')),'first grid tile decoded');
  // Give the initial native lazy-loader / thumbnail queue a chance to settle. Request numbers are snapshots,
  // not a claim about future speculative Chrome loads; DOM and direct-original-src counts are hard bounds.
  await wait(450);
  const tiles=$$('.vig-tiles .vig-tile'), tileImages=$$('.vig-tiles img');
  const first=await stats();
  const report={baseline, userAgent:navigator.userAgent, grid:{tiles:tiles.length, images:tileImages.length,elements:$('.vig-tiles').querySelectorAll('*').length,createdOnMount:totalCreated(),directOriginalSources:tileImages.filter(x=>(x.getAttribute('src')||'').includes('/asset/')).length,server:first}};
  check(tiles.length===(baseline?200:12),'first grid page cap',report.grid);
  if (!baseline) {
    check(first.unique>0&&first.unique<=12 && first.fetch>0,'first grid reads no more originals than its page',first);
    check(first.fetchPeak<=2,'first grid thumbnail concurrency',first);
    check(report.grid.createdOnMount<500 && report.grid.elements<400,'first mount DOM budget',report.grid);
    check(report.grid.directOriginalSources===0,'first grid must not bind originals directly',report.grid);
  }
  if(!baseline){
    check($('[data-lib-prev]')?.disabled,'previous disabled on first page');
    click(tiles[0].querySelector('.vig-tile-meta'));check(tiles[0].classList.contains('is-on'),'selected');
    click($('[data-lib-next]'));await until(()=>$('.vig-tile-name')?.textContent==='item-013.png','global grid offset 12');
    check(!$('.vig-toolbar .is-danger'),'previous-page selection not actionable');
  }
  const idx=baseline?12:0, cell=$$('.vig-tile')[idx];cell.scrollIntoView({block:'center'});
  await until(()=>loaded(cell.querySelector('img')),'4K fixture tile decoded');
  const thumb=cell.querySelector('img');report.bigTile={w:thumb.naturalWidth,h:thumb.naturalHeight,blob:(thumb.currentSrc||'').startsWith('blob:')};
  if(!baseline) check(report.bigTile.blob&&report.bigTile.w<=320&&report.bigTile.w>0&&report.bigTile.w===2*report.bigTile.h,'thumbnail must really be a smaller 2:1 raster',report.bigTile);
  const prior=created;report.viewer=await openAndRead(cell.querySelector('img'),'viewer opened 4K original');report.viewer.createdOnOpen=created-prior;
  check(report.viewer.counter?.trim()==='13 / 200'&&report.viewer.title==='item-013.png'&&report.viewer.naturalWidth===4096&&report.viewer.imgElements===1,'full global list; one original at real resolution',report.viewer);
  click($('.vig-viewer-nav.is-next'));check($('.vig-viewer-title')?.textContent==='item-014.png','viewer next uses global index');click($('.vig-viewer-head button[title="Esc"]'));
  if(!baseline){
    const before=await stats();click($('[data-lib-prev]'));await until(()=>loaded($('.vig-tile img')),'cached first page');await wait(250);const again=await stats();
    report.grid.firstPageFetchIncrement=again.page1Fetch-before.page1Fetch;
    check(report.grid.firstPageFetchIncrement===0,'returning to cached first page must not fetch originals again',report.grid.firstPageFetchIncrement);
    search('only-last');await until(()=>$('.vig-tile-name')?.textContent==='item-200.png','filter searches full index');
    check($$('.vig-tile').length===1,'filter result length');search('');check($('.vig-tile-name')?.textContent==='item-001.png','clear search resets page');
  }
  if(!baseline) host.parentElement.style.width='1255px';
  const stagePrior=created;click(view()[1]);await until(()=>loaded($('.vig-stage-img')),'stage original');await wait(250);
  report.stage={stripImages:$$('.vig-strip-item img').length,stripElements:$('.vig-strip').querySelectorAll('*').length,createdOnSwitch:created-stagePrior,mainWidth:$('.vig-stage-img').naturalWidth};
  if (baseline) check(report.stage.stripImages===200,'baseline stage strip',report.stage);
  if(!baseline){
    const stripItems=()=>$$('.vig-strip-item');
    const id=name=>Number(/^item-(\d+)\.png$/.exec(name)?.[1]);
    const sourceId=()=>id($('.vig-stage-img')?.alt);
    const chosenId=()=>id($('.vig-strip-item.is-on')?.title);
    const next=()=>$('[data-lib-next]'), prev=()=>$('[data-lib-prev]');
    const range=()=>stripItems().map(el=>id(el.title));
    const fourFrames=async()=>{for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);};
    const stripSize=async()=>{
      await fourFrames(); // Deliver CSS container queries, ResizeObserver and the subsequent React commit.
      const strip=$('.vig-strip');
      await Promise.all(strip.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
      const items=stripItems(), box=strip.getBoundingClientRect(), style=getComputedStyle(strip);
      const a=items[0].getBoundingClientRect(), b=items.at(-1).getBoundingClientRect();
      const measured={width:box.width, count:items.length,leftGap:a.left-box.left,rightGap:box.right-b.right,
        leftInset:parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth),rightInset:parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth),
        overflow:strip.scrollWidth-strip.clientWidth, tileWidth:b.width, tileHeight:b.height};
      check(measured.count>0 && measured.count<=48 && measured.overflow<=1 && Math.abs(measured.leftGap-measured.leftInset)<=1 && Math.abs(measured.rightGap-measured.rightInset)<=1,
        'filled group uses both strip edges (padding only), zero horizontal overflow, bounded mounted items',measured);
      check(items.every(el=>getComputedStyle(el.querySelector('img')).objectFit==='cover'),'thumbnails use object-fit:cover');
      return measured;
    };
    const assertGroup=(first,last)=>{
      const ids=range(), expected=Array.from({length:last-first+1},(_,i)=>first+i);
      const output=$('.vig-lib-pages output')?.textContent.trim();
      check(ids.length===expected.length && ids.every((v,i)=>v===expected[i]),'group covers a contiguous logical range',{ids,expected});
      check(output===`${first}–${last} / 200`,'pager range equals the actual visible strip',{first,last,output});
      check(chosenId()===sourceId() && ids.includes(chosenId()) && stripItems().filter(el=>el.getAttribute('aria-pressed')==='true').length===1,'current original remains selected in the strip',{chosen:chosenId(),source:sourceId(),ids});
    };
    const wide=await stripSize(), cap=wide.count;
    check(wide.width>1210 && wide.width<=1255 && cap>12,'~1255px host uses more than 12 thumbnail slots',wide);assertGroup(1,cap);
    click(stripItems().at(-1)); const picked=sourceId();
    host.parentElement.style.width='320px';const narrow=await stripSize();
    check(narrow.width>300 && narrow.width<=320 && narrow.count<cap && picked===sourceId() && picked===chosenId(),'narrowing the host changes capacity, not the current image',{narrow,cap,picked,chosen:chosenId()});
    host.parentElement.style.width='1255px';const restored=await stripSize();
    check(restored.count===cap && picked===sourceId() && picked===chosenId(),'widening restores capacity and keeps current image',{restored,picked,chosen:chosenId()});assertGroup(1,cap);
    report.stage.sizes={wide,narrow,restored};
    click(next());assertGroup(cap+1,cap*2);
    click(stripItems().at(-1));const stage=$('.vig-stage-main');stage.focus();flush(()=>stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120})));
    await until(()=>chosenId()===cap*2+1,'wheel from last thumbnail reaches next group');assertGroup(cap*2+1,cap*3);
    // Keep the preceding group's boundaries so we can verify the padded last group overlaps it.
    let previous;
    for(let i=0;i<200&&!next().disabled;i++){previous=range();click(next());}
    check(next().disabled && !prev().disabled,'last group controls');const tail=await stripSize();
    const tailStart=201-cap;
    assertGroup(tailStart,200);check(tail.count===cap && sourceId()===previous.at(-1)+1,'last page selects the first new original instead of backing up to a borrowed thumbnail',{tail,tailStart,previousEnd:previous.at(-1),active:sourceId()});
    const firstNew=sourceId();
    const shared=previous?.filter(v=>v>=tailStart)??[];check(shared.length>0,'chosen host width exercises a partially overlapping final group',{cap,previous,tailStart});
    const sharedId=shared.at(-1);click(stripItems().find(el=>id(el.title)===sharedId));assertGroup(tailStart,200);
    check(next().disabled && sourceId()===sharedId,'clicking a shared thumbnail does not jump to the preceding group');
    click(stripItems().at(-1));check(sourceId()===200,'last image reachable');
    click(view()[0]);check($$('.vig-tile').length===8 && $('.vig-tile-name')?.textContent==='item-193.png','back to grid: current image 200 lies on the last 12-item page');
    click(view()[1]);await fourFrames();check(chosenId()===200 && sourceId()===200,'grid/stage round-trip keeps the exact image');
    for(let i=0;i<200 && !prev().disabled;i++)click(prev());assertGroup(1,cap);click(stripItems()[0]);check(sourceId()===1 && prev().disabled,'return to first group and first original');
    report.stage.lastGroup={first:tailStart,last:200,firstNew,overlap:shared.length,clicked:sharedId,count:tail.count};
    search('only-last');await fourFrames();
    const solo=stripItems();check(solo.length===1 && chosenId()===200,'one-result filter still shows and selects the matching original');
    await Promise.all(solo[0].getAnimations().map(anim=>anim.finished.catch(()=>{})));
    const single=solo[0].getBoundingClientRect(), rail=$('.vig-strip').getBoundingClientRect();
    report.stage.singleResult={width:single.width, height:single.height, leftGap:single.left-rail.left,rightGap:rail.right-single.right};
    check(Math.abs((single.left-rail.left)-(rail.right-single.right))<=1 && Math.abs(single.width-wide.tileWidth)<=2,
      'one-result filter centers the thumbnail without stretching it across the strip',report.stage.singleResult);
    click(view()[0]);const searchInput=$('.vig-toolbar input');searchInput.focus();search('only-last');await until(()=>$('.vig-tile-name')?.textContent==='item-200.png','search refreshes current page');search('');
    for(let n=0;n<16;n++){const next=$('[data-lib-next]');check(next&&!next.disabled,'next exists before last',n);click(next);}
    check($$('.vig-tile').length===8 && $('[data-lib-next]')?.disabled && $$('.vig-tile-name').at(-1)?.textContent==='item-200.png','last page exposes final 8 assets');
    report.finalGridCount=$$('.vig-tile').length;
  }
  flush(()=>root.unmount());
  if (!baseline) {
    // Smoke-test the real Workbench controller, not a fake load-more callback. Non-asset API
    // responses are fixtures; browser image fetches and decoding still go to the HTTP server.
    const offsets=[], realFetch=window.fetch;
    const extra={...library[0], id:'img_201',name:'item-201.png',url:'/api/velapi-image-go/asset/img_201.png',prompt:'archive-needle'};
    const rows=[...library,extra];
    window.fetch=async (input,init)=>{
      const u=new URL(input,location.href), route=u.pathname.replace('/api/velapi-image-go','');
      if (!u.pathname.startsWith('/api/velapi-image-go/') || route.startsWith('/asset/')) return realFetch(input,init);
      let data={ok:true,items:[]};
      if (route==='/library') {
        const offset=Number(u.searchParams.get('offset')||0), limit=Number(u.searchParams.get('limit'));
        offsets.push([offset,limit]);if(offset) await wait(60);
        data={ok:true,items:rows.slice(offset,offset+limit),total:rows.length};
      } else if(route==='/status') data={ok:true,config:{},protocols:[]};
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    };
    host.parentElement.style.width='320px';host.parentElement.style.height='480px';host.parentElement.classList.remove('vig-root');
    localStorage.setItem('dsh.velapi-image-go.view','library');
    const app=req('react-dom/client').createRoot(host);
    try {
      flush(()=>app.render(h(ui.Workbench)));
      await until(()=>$('[data-lib-more]') && $('.vig-root')?.dataset.compact==='1','compact Workbench and 200/201 index');
      const next=$('[data-lib-next]'), older=$('[data-lib-more]'), bb=$('.vig-root').getBoundingClientRect();
      for(const el of [next,older]){
        el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        check(r.width>0 && r.left>=bb.left-1 && r.right<=bb.right+1 && el.contains(hit),'320px pager buttons fit and are hit-testable', {button:el.outerHTML,left:r.left,right:r.right,hit:hit?.className});
      }
      click(next);check($('.vig-tile-name')?.textContent==='item-013.png','320px next-page button works');
      search('archive-needle');check(!$('.vig-tile'),'older entry is not in the initial metadata');
      click($('[data-lib-more]'));const second=$('[data-lib-more]');if(second)click(second);
      await until(()=>$('.vig-tile-name')?.textContent==='item-201.png','fetch older entries while filtered');
      check(JSON.stringify(offsets)==='[[0,200],[200,200]]' && !$('[data-lib-more]'),'exactly one offset 200 call after explicit click',offsets);
      report.narrow={rootWidth:bb.width,hitTest:'next and more',calls:offsets,filteredResult:$('.vig-tile-name')?.textContent};
    } finally { flush(()=>app.unmount());window.fetch=realFetch; }
  }
  return report;
}

const metrics={unique:0,requests:0,fetch:0,image:0,other:0,fetchPeak:0,page1Fetch:0};
const seen=new Set();let activeFetch=0,resolveResult,rejectResult;
const observed=new Promise((res,rej)=>{resolveResult=res;rejectResult=rej;});
const normal=png(640,320),big=png(4096,2048);
const page=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#host{display:flex;flex:1;min-height:0;overflow:auto}</style><main class="vig-root" data-compact="0" style="width:1020px;height:760px"><div id="host"></div></main><script>window.__ModuleLoader__={load:r=>window.record=r};</script><script src="/client.js"></script><script src="/react.js"></script><script src="/driver.js"></script>`;
const driver=`(${inBrowser.toString()})(${baseline}).then(report=>fetch('/result',{method:'POST',body:JSON.stringify({report})})).catch(e=>fetch('/result',{method:'POST',body:JSON.stringify({error:e.stack||String(e)})}));`;
const server=createServer(async (request,res)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  const send=(content,type)=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(content);};
  if(url.pathname==='/')return send(page,'text/html;charset=UTF-8');
  if(url.pathname==='/react.js')return send(registry,'text/javascript;charset=UTF-8');
  if(url.pathname==='/client.js')return send(source,'text/javascript;charset=UTF-8');
  if(url.pathname==='/driver.js')return send(driver,'text/javascript;charset=UTF-8');
  if(url.pathname==='/stats')return send(JSON.stringify(metrics),'application/json');
  if(url.pathname==='/result'&&request.method==='POST'){let body='';for await(const part of request)body+=part;send('ok','text/plain');resolveResult(JSON.parse(body));return;}
  const asset=/^\/api\/velapi-image-go\/asset\/img_(\d{3})\.png$/.exec(url.pathname);
  if(asset){const n=Number(asset[1]);seen.add(n);metrics.unique=seen.size;metrics.requests++;const dest=request.headers['sec-fetch-dest'];
    const isFetch=dest==='empty';metrics[isFetch?'fetch':dest==='image'?'image':'other']++;
    if(isFetch){metrics.fetchPeak=Math.max(metrics.fetchPeak,++activeFetch);if(n<=12)metrics.page1Fetch++;}
    // Real overlapping requests remain observable even on loopback; no rate/time result uses this delay.
    await new Promise(r=>setTimeout(r,20));if(isFetch)activeFetch--;send(n===13?big:normal,'image/png');return;}
  res.writeHead(404);res.end();
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
const userData=mkdtempSync(path.join(tmpdir(),'vig-gallery-perf-'));
let child,exited,timer;
try {
  const url='http://127.0.0.1:'+server.address().port+'/';
  child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--disable-sync','--window-size=1280,900','--user-data-dir='+userData,url],{stdio:'ignore',windowsHide:true});
  exited=new Promise(done=>{child.once('error',e=>{rejectResult(e);done();});child.once('exit',(code)=>{rejectResult(Error('Chrome exited: '+code));done();});});
  timer=setTimeout(()=>rejectResult(Error('gallery benchmark deadline exceeded')),45000);
  const {report,error}=await observed;assert.ok(!error,error);console.log(JSON.stringify({client:baseline?ref:'working-tree',...report},null,2));
} finally {
  clearTimeout(timer);if(child){child.kill();await exited;}
  server.closeAllConnections();await new Promise(done=>server.close(done));
  // Only the unique test-owned profile (never a user Chrome/Ego profile).
  if(path.dirname(userData)===path.resolve(tmpdir())&&path.basename(userData).startsWith('vig-gallery-perf-'))rmSync(userData,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
