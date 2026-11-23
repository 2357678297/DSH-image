// Standalone real-PsView, real-React, real-Canvas regression; never mounts the user workbench or contacts a relay.
// node test/ps-history-audit.test.mjs [--before]    (--before: reproduce defect at 063d209)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../',import.meta.url));
const before=process.argv.includes('--before'), source=before?execFileSync('git',['show','063d209:client.js'],{cwd:repo,encoding:'utf8',maxBuffer:4<<20}):fs.readFileSync(path.join(repo,'client.js'),'utf8');
const reactRoot=process.env.VIG_REACT_ROOT || 'G:/Gg-gank/frontend/deeix-chat/frontend/node_modules', resolve=createRequire(path.resolve(reactRoot,'anchor.cjs'));
const cjs=(r,id,name)=>path.join(path.dirname(r.resolve(id)),'cjs',name+'.development.js');
const modules={react:cjs(resolve,'react','react'),'react-dom':cjs(resolve,'react-dom','react-dom'),'react-dom/client':cjs(resolve,'react-dom','react-dom-client'),scheduler:cjs(createRequire(resolve.resolve('react-dom')),'scheduler','scheduler')};
const deps='const factories={},cache={}; function req(k){if(!cache[k]){const m=cache[k]={exports:{}};factories[k](m,m.exports,req);}return cache[k].exports;}\n'+Object.entries(modules).map(([id,file])=>`factories[${JSON.stringify(id)}]=function(module,exports,require){const process={env:{NODE_ENV:'development'}};\n${fs.readFileSync(file,'utf8')}\n};`).join('\n');

async function exercise(before) {
  const react=req('react'),{flushSync}=req('react-dom'),{createRoot}=req('react-dom/client');
  const ui=window.record.factory(req).__internals,host=document.querySelector('main'),root=createRoot(host);
  const css=document.createElement('style');css.textContent=ui.CSS;document.head.appendChild(css);
  const results=[],check=(name,ok,details)=>{if(!ok)throw Error(name+' '+JSON.stringify(details));results.push(name);};
  const fixture=()=>{const c=document.createElement('canvas');c.width=13;c.height=7;const g=c.getContext('2d');g.fillStyle='#f20';g.fillRect(0,0,5,4);g.fillStyle='#38f';g.fillRect(6,2,3,3);return c;};
  const render=(key,initial)=>flushSync(()=>root.render(react.createElement(ui.PsView,{key,state:{library:[],presets:[]},actions:{toast:()=>{}},initial})));
  const $=s=>host.querySelector(s), all=s=>Array.from(host.querySelectorAll(s));
  const btn=name=>all('button').find(el=>el.textContent.trim()===name),click=el=>{if(!el||el.disabled)throw Error('missing/disabled control: '+el?.textContent+' '+el?.title);flushSync(()=>el.click());};
  const rotate=()=>click(btn('顺时针 90°')), rows=()=>all('.vig-ps-history-item'), undo=()=>click($('button[title="撤销"]')), redo=()=>click($('button[title="重做"]'));
  const shown=()=>$('.vig-ps-canvas').toDataURL(), active=()=>$('.vig-ps-chip.is-on .vig-ps-chip-name')?.textContent;
  const layer=()=>$('.vig-ps-chip:not(.is-base):not(.is-add)'), enter=()=>{click(layer());flushSync(()=>layer().dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));}, back=()=>click(btn('回到合成'));
  const count=(kind)=>all('.vig-ps-history-item.is-'+kind).length;
  const beforeRows=()=>rows().map(el=>el.textContent);
  try {
    const sheet=fixture();render('timeline',{name:'A',canvas:sheet,width:13,height:7,tool:'rotate'});
    const states=[shown()];for(let n=0;n<3;n++){rotate();states.push(shown());}
    check('four physically different rendered states',new Set(states).size===4);
    click(rows()[0]);check('jump to first frame restores exact pixels',shown()===states[0]);redo();
    if(before){check('old client duplicates current undo target after timeline jump',shown()===states[0] && rows().length===5,{rows:beforeRows()});return results;}
    check('redo from first history entry advances immediately to B',shown()===states[1] && rows().length===4,{rows:beforeRows()});
    click(rows().at(-1));check('jump over multiple future states goes to D',shown()===states[3] && !count('future'));
    undo();check('undo after jumping forward restores C, not the origin A/B',shown()===states[2]);
    undo();check('undo from C restores B exactly',shown()===states[1]);
    rotate();check('new edit after undo drops stale redo branch',shown()===states[2] && !count('future') && rows().length===3);
    const b=fixture(),l=fixture();l.getContext('2d').clearRect(0,0,4,2);
    render('layer',{name:'base',canvas:b,width:b.width,height:b.height,tool:'rotate',layers:[{id:'a',name:'Layer A',canvas:l,visible:true,opacity:.7,mode:'normal'}]});
    const untouched=shown();rotate();const beforeLayer=shown();enter();
    check('ordinary layer editing starts its own undo boundary',!!$('.vig-ps-layer-session') && count('past')===0 && $('button[title="撤销"]').disabled);
    const innerA=shown();rotate();const innerB=shown();undo();check('inner undo stays inside layer',!!$('.vig-ps-layer-session') && shown()===innerA && count('past')===0);redo();check('inner redo restores its exact raster',shown()===innerB);
    back();const afterLayer=shown();check('writing back is exactly one outer step',!$('.vig-ps-layer-session') && count('past')===2 && afterLayer!==beforeLayer,{rows:beforeRows()});
    undo();check('outer undo restores original composite and selected layer',!$('.vig-ps-layer-session') && shown()===beforeLayer && active()==='Layer A');
    undo();check('outer history prior to layer entry survives',shown()===untouched);
    redo();redo();check('outer redo restores edited layer pixels and selection',shown()===afterLayer && active()==='Layer A');
    enter();back();check('entering and returning without edits is not an undo step',shown()===afterLayer && count('past')===2);
    const w=fixture();render('warp',{name:'W',canvas:w,width:w.width,height:w.height,tool:'warp'});
    click(all('.vig-ps-seg-btn').find(el=>el.textContent.trim()==='变形'));await new Promise(r=>setTimeout(r,90));click($('[data-warp-confirm]'));const locked=shown();
    check('confirmed perspective creates a locked result layer',!!$('[data-warp-locked]')&&!$('[data-warp-fliph]').disabled);
    undo();check('undo warp returns to parent, no phantom result lock',!$('.vig-ps-layer-session') && !$('[data-warp-locked]'));
    redo();check('redo warp restores exact pixels, active layer and flip eligibility',shown()===locked && !!$('[data-warp-locked]') && active()==='确认矫正' && !$('[data-warp-fliph]').disabled);
    click($('[data-warp-fliph]'));const flipped=shown();undo();check('result flip is independently undoable without unlocking',shown()===locked && flipped!==locked && !!$('[data-warp-locked]'));
    for (const name of ['psHistoryPush','psHistorySeek']) check(name+' exported for audits',typeof ui[name]==='function');
    let h={past:[],future:[]};for(let n=0;n<16;n++)h=ui.psHistoryPush(h,{name:'seed',label:'s'+n,canvas:w},'s'+(n+1));check('snapshot limit retains 12 prior states',h.past.length===12 && h.currentLabel==='s16');
    return results;
  }finally{flushSync(()=>root.unmount());}
}
const tmpBase=os.tmpdir(), tmp=fs.mkdtempSync(path.join(tmpBase,'vig-ps-history-'));const cli=process.env.VIG_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
try{
  fs.writeFileSync(path.join(tmp,'client.js'),source);fs.writeFileSync(path.join(tmp,'react.js'),deps);
  fs.writeFileSync(path.join(tmp,'check.html'),`<!doctype html><meta charset="utf-8"><main></main><pre id="result"></pre><script>window.__ModuleLoader__={load:x=>window.record=x}</script><script src="client.js"></script><script src="react.js"></script><script>(${exercise.toString()})(${before}).then(v=>result.textContent=JSON.stringify({results:v}),err=>result.textContent=JSON.stringify({error:String(err.stack||err)}));</script>`);
  const out=execFileSync(cli,['--headless=new','--disable-gpu','--disable-background-networking','--disable-sync','--disable-extensions','--no-first-run','--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','--virtual-time-budget=2000',new URL('file:///'+path.join(tmp,'check.html').replaceAll('\\','/')).href],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore'],timeout:22000,maxBuffer:4<<20});
  const m=out.match(/<pre id="result">([^<]*)<\/pre>/);assert.ok(m?.[1],'no browser result');const res=JSON.parse(m[1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&gt;','>').replaceAll('&lt;','<'));assert.ok(!res.error,res.error);console.log(res.results.map(v=>'PASS '+v).join('\n'));console.log('PsView timeline '+res.results.length+'/'+res.results.length+' ('+(before?'reproduced old bug':'current')+')');
}finally{assert.equal(path.dirname(tmp),tmpBase);assert.ok(path.basename(tmp).startsWith('vig-ps-history-'));fs.rmSync(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:300});}
