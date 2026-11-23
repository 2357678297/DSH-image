// Offline deterministic timing tests; exercise the exact read-channel and decoder used by PsView.
// The only substitutes are the transport, native Image completion, and the final canvas draw target.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){

const code = readFileSync(new URL('../client.js',import.meta.url),'utf8');
const assets = new Map(), issued=[],released=[],requests=[], canvases=[];
let record, fetchImpl;
class FixtureURL extends URL {
  static createObjectURL(blob){const key=`blob:fixture/${issued.length}`; issued.push(key);assets.set(key,blob);return key;}
  static revokeObjectURL(key){released.push(key);assets.delete(key);}
}
class FixtureImage {
  removeAttribute(){}
  set src(value){const entry=assets.get(value);this.naturalWidth=entry?.w || 30;this.naturalHeight=entry?.h || 18;
    if (entry?.hold) {entry.decoding=true;return;}
    queueMicrotask(()=>entry?.bad?this.onerror?.():this.onload?.());}
}
const bare='dsh-app://app/';
const sandbox={window:{__ModuleLoader__:{load:r=>{record=r;}}},console,URL:FixtureURL,Image:FixtureImage,location:{href:bare},AbortController,
  document:{baseURI:bare,createElement(type){assert.equal(type,'canvas');const element={getContext(){return {drawImage(){}};}};canvases.push(element);return element;}},
  fetch:(url,options)=>{requests.push({url,options});return fetchImpl(url,options);} };
vm.runInNewContext(code,sandbox,{filename:'client.js'});
const {psReadChannel,psDecodeInput,psApplyDpi}=record.factory(()=>({})).__internals;
const deferred=()=>{let done,fail;const promise=new Promise((resolve,reject)=>{done=resolve;fail=reject;});return {promise,done,fail};};
const fixture=()=>{const commits=[],errors=[],busy=[];const reads=psReadChannel();const run=work=>reads.run(work,x=>commits.push(x),e=>errors.push(e),v=>busy.push(v));return {reads,run,commits,errors,busy};};
let checks=0;
async function test(name,fn){await fn();console.log('PASS '+name);checks++;}
await test('B supersedes slow A; A cannot commit, surface a stale error, or clear B’s busy indicator',async()=>{
  const f=fixture();const a=deferred(),b=deferred();let signalA;
  const first=f.run(signal=>{signalA=signal;return a.promise;});const second=f.run(()=>b.promise);
  assert.ok(signalA.aborted);a.fail(Error('old request failed'));assert.equal(await first,false);
  assert.deepEqual(f.busy,[true,true]);assert.deepEqual(f.commits,[]);assert.deepEqual(f.errors,[]);
  b.done('B pixels');assert.equal(await second,true);assert.deepEqual(f.commits,['B pixels']);assert.deepEqual(f.busy,[true,true,false]);
});
await test('late success cannot replace the newer document or add a layer after session exit/unmount',async()=>{
  const f=fixture(),a=deferred();const first=f.run(()=>a.promise);await f.run(async()=> 'B');a.done('A');assert.equal(await first,false);
  const layer=deferred();const pending=f.run(()=>layer.promise);f.reads.cancel();layer.done('stray layer');assert.equal(await pending,false);
  assert.deepEqual(f.commits,['B']);assert.deepEqual(f.errors,[]);assert.deepEqual(f.busy,[true,true,false,true]);
});
await test('success-only commit and one actionable error for the current document',async()=>{
  const f=fixture();await f.run(async()=> 'existing doc');const bad=Error('missing file');assert.equal(await f.run(async()=>{throw bad;}),false);
  assert.deepEqual(f.commits,['existing doc']);assert.deepEqual(f.errors,[bad]);assert.equal(f.busy.at(-1),false);
});
const inputPNG=readFileSync(new URL('../assets/presets/product-stand.png',import.meta.url));
const png300=Buffer.from(psApplyDpi('data:image/png;base64,'+inputPNG.toString('base64'),300).split(',')[1],'base64');
const sized=(bytes,fields={})=>Object.assign(new Blob([bytes],{type:'image/png'}),fields);
await test('desktop asset uses the relative host route with cancellation; no full-size base64 copy to recover DPI',async()=>{
  const blob=sized(png300);const slices=[];blob.arrayBuffer=()=>{throw Error('Unexpected full-file read');};const slice=blob.slice.bind(blob);blob.slice=(a,b)=>{slices.push([a,b]);return slice(a,b);};
  const controller=new AbortController();fetchImpl=async()=>({ok:true,blob:async()=>blob});const at=issued.length;
  const {canvas,dpi}=await psDecodeInput({url:'/api/velapi-image-go/asset/source.png'},controller.signal);
  assert.equal(requests.at(-1).url,'/api/velapi-image-go/asset/source.png');assert.equal(requests.at(-1).options.signal,controller.signal);
  assert.deepEqual([canvas.width,canvas.height,dpi],[30,18,300]);assert.deepEqual(slices,[[0,262144]]);assert.equal(released.at(-1),issued[at]);
});
await test('files use object URLs and return 72 DPI if unknown; internal tile uses its parent DPI',async()=>{
  const signal=new AbortController().signal;const old=requests.length;
  const {dpi}=await psDecodeInput({file:sized([42])},signal);assert.equal(dpi,72);assert.equal(requests.length,old);
  const internal={width:4,height:3};const decoded=await psDecodeInput({canvas:internal,dpi:144},signal);assert.equal(decoded.canvas,internal);assert.equal(decoded.dpi,144);
  const layer=sized(png300);layer.slice=()=>{throw Error('layer should not read header');};const cut=await psDecodeInput({file:layer},signal,{width:14,height:12});assert.deepEqual([cut.canvas.width,cut.canvas.height],[14,12]);
});
await test('decode failures, oversized rasters, and aborted decodes release only their owned URL and allocate no canvas',async()=>{
  const baseCount=canvases.length, signal=new AbortController().signal;
  await assert.rejects(psDecodeInput({file:sized(inputPNG,{bad:true})},signal));await assert.rejects(psDecodeInput({file:sized(inputPNG,{w:32768,h:32768})},signal));
  const c=new AbortController(),hold=sized(inputPNG,{hold:true});const load=psDecodeInput({file:hold},c.signal);assert.ok(hold.decoding);c.abort();await assert.rejects(load);
  assert.equal(canvases.length,baseCount);assert.equal(assets.size,0);assert.deepEqual(released,issued);
});
await test('file URLs and different desktop hosts are rejected without a request',async()=>{
  const old=requests.length, signal=new AbortController().signal;
  for(const url of ['file:///c:/none.png','dsh-app://shell/api/velapi-image-go/asset/x.png','dsh-app://app/api/config'])await assert.rejects(psDecodeInput({url},signal));
  assert.equal(requests.length,old);
});
console.log(`${checks}/${checks} image processing read audit cases passed`);
}

// Real PsView / React, real PNG/Blob decode. Only our own asset responses are held back.
export async function auditPSReads({check,wait,flushSync,ui,React,createRoot}) {
  const mount=document.createElement('div');mount.className='vig-root';mount.style.cssText='width:1020px;height:720px';document.body.append(mount);
  const root=createRoot(mount),h=React.createElement,$=s=>mount.querySelector(s),all=s=>[...mount.querySelectorAll(s)];
  const click=el=>{if(!el)throw Error('missing control');flushSync(()=>el.click());};
  const deferred=()=>{let resolve;const p=new Promise(r=>resolve=r);return {p,resolve};};
  const checkUntil=async (p,msg)=>{const end=Date.now()+3500;while(!p()&&Date.now()<end)await wait(10);if(!p())throw Error('timeout: '+msg);};
  const canvas=(w,h,color)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,w,h);return c;};
  const fixture=canvas(22,17,'#1b5df1'), base=canvas(12,9,'#ff1744'), layer=canvas(12,9,'#00cc66');
  const png=new Blob([ui.psB64Decode(ui.psApplyDpi(fixture.toDataURL(),300).split(',')[1])],{type:'image/png'});
  const plain=new Blob([ui.psB64Decode(fixture.toDataURL().split(',')[1])],{type:'image/png'});
  const sources=['A','B','Layer','C'].map(id=>({id,name:id+'.png',url:URL.createObjectURL(plain)}));
  const state={library:sources,presets:[]}, messages=[],consumed=[],held=new Map(), originalFetch=window.fetch;
  window.fetch=(url,init)=>{
    const match=sources.find(x=>String(url).endsWith(x.url));if(!match)return originalFetch(url,init);
    const gate=deferred();held.set(match.id,{...gate,signal:init.signal});return gate.p; // intentionally ignores abort
  };
  const actions={toast:(msg,kind)=>messages.push([msg,kind])};
  const render=initialUrl=>flushSync(()=>root.render(h(ui.PsView,{initial:{name:'seed.png',width:12,height:9,canvas:base,dpi:144,selection:{x:2,y:1,w:4,h:3},tool:'select',layers:[{id:'L',name:'绿层',canvas:layer,mode:'normal',opacity:1,visible:true}]},state,actions,initialUrl,onConsumeInitialUrl:v=>consumed.push(v)})));
  const sample=()=>[...$('.vig-ps-canvas').getContext('2d').getImageData(1,1,1,1).data].join();
  const title=()=>$('.vig-toolbar')?.textContent||'', canvasDoc=()=>$('.vig-ps-canvas');
  const response=blob=>new Response(blob,{headers:{'content-type':'image/png'}});
  const selection=()=>{const c=$('.vig-ps-overlay');return c && c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((n,i)=>i%4===3&&n>0);}; const undo=()=>$('.vig-toolbar button[title="撤销"]');
  const errorCount=()=>messages.filter(([,k])=>k==='err').length;
  const dfiles=f=>{const data=new DataTransfer();data.items.add(f);const input=$('input[type=file]');input.files=data.files;flushSync(()=>input.dispatchEvent(new Event('change',{bubbles:true})));};
  try{
    render(null);await checkUntil(()=>canvasDoc()?.width===12,'seed');
    click($('.vig-ps-chip:not(.is-add):not(.is-base) .vig-ps-chip-eye'));
    const snapshot=sample(),past=all('.vig-ps-history-item.is-past').length;
    check('初始选区与可撤销的图层显隐作为工具重置基线',selection() && past===1 && !undo().disabled && snapshot==='255,23,68,255');
    click(all('button').find(b=>b.textContent.trim()==='重置工具参数'));
    check('重置只清草稿；已提交像素、图层、历史、144 DPI 均保留',!selection() && all('.vig-ps-history-item.is-past').length===past && !undo().disabled && sample()===snapshot && title().includes('144 DPI'));
    render(sources[0]);await checkUntil(()=>held.has('A'),'A requested');render(sources[1]);await checkUntil(()=>held.has('B'),'B requested');
    const errors=errorCount();held.get('A').resolve(new Response('old image error',{status:503}));await wait(30);
    check('迟到 A 错误不弹提示也不清 B 的读图状态',!!held.get('A').signal?.aborted && !!$('.vig-toolbar [role=status]') && errorCount()===errors && sample()===snapshot);
    held.get('B').resolve(response(png));await checkUntil(()=>title().includes('B.png') && !$('.vig-toolbar [role=status]'),'B committed');
    check('最后选择的 B 显示其真实尺寸/DPI，历史、图层与旧选择不串入',title().includes('22×17') && title().includes('300 DPI') && undo().disabled && !$('.vig-ps-chip:not(.is-base):not(.is-add)') && !selection() && sample()==='27,93,241,255' && JSON.stringify(consumed.map(x=>x.id))==='["A","B"]');
    click($('.vig-ps-chip.is-add'));const entry=await (async()=>{await checkUntil(()=>!!Array.from(document.querySelectorAll('dialog .vig-tile img')).find(x=>x.alt==='Layer.png'),'layer picker');return Array.from(document.querySelectorAll('dialog .vig-tile img')).find(x=>x.alt==='Layer.png').closest('button');})();
    click(entry);await checkUntil(()=>held.has('Layer'),'layer pending');dfiles(new File([plain],'C.png',{type:'image/png'}));
    await checkUntil(()=>title().includes('C.png'),'file committed');held.get('Layer').resolve(response(png));await wait(30);
    check('图层 A 晚于选取的本地文档 C：不写层、不增加撤销、无 DPI 继承',!!held.get('Layer').signal?.aborted && !$('.vig-ps-chip:not(.is-base):not(.is-add)') && undo().disabled && !title().includes('300 DPI') && !$('.vig-toolbar [role=status]') && errorCount()===errors);
  }catch(e){check('图片处理读入审计完整执行',false,String(e.stack||e));}
  finally{window.fetch=originalFetch;flushSync(()=>root.unmount());mount.remove();for(const x of sources)URL.revokeObjectURL(x.url);}
}
