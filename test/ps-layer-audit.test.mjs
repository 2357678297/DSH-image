// Loaded by tools/viewer-check.mjs --query audit=pslayers. Real React, DOM + 2-D pixels; no network/provider.
export async function auditPSLayers({check,wait,flushSync,ui,React,createRoot}) {
  const mount=document.createElement('div'); mount.style.cssText='width:1000px;height:760px'; document.body.append(mount);
  const root=createRoot(mount), $=s=>mount.querySelector(s), all=s=>[...mount.querySelectorAll(s)];
  const assert=(test,msg)=>{if(!test)throw Error(msg);};
  const canvas=(w,h,color)=>{const c=document.createElement('canvas'); c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,w,h);return c;};
  const base=canvas(16,12,'#ff0000'), a=canvas(16,12,'#0000ff'), b=canvas(16,12,'#00ff00');
  const layers=[{id:'a',name:'blue',canvas:a,visible:true,mode:'normal',opacity:1},{id:'b',name:'green',canvas:b,visible:false,mode:'normal',opacity:1}];
  const orig=HTMLCanvasElement.prototype.toDataURL,origClick=HTMLAnchorElement.prototype.click;let encoded=0,download='',reference='';
  HTMLCanvasElement.prototype.toDataURL=function(...args){if(this.width===56&&this.height===56)encoded++;return orig.apply(this,args);};
  HTMLAnchorElement.prototype.click=function(){if(this.download){download=this.href;return;}return origClick.call(this);};
  const click=e=>{assert(e,'missing clickable element');flushSync(()=>e.click());};
  const title=(scope,t)=>[...scope.querySelectorAll('button')].find(el=>el.title===t);
  const chip=(n=0)=>all('.vig-ps-chip:not(.is-base):not(.is-add)')[n], row=n=>all('.vig-ps-layer-row:not(.is-base)').find(el=>el.querySelector('.vig-ps-layer-name')?.textContent===n);
  const stage=()=>$('.vig-ps-canvas'), sample=(x=1)=>[...stage().getContext('2d').getImageData(x,1,1,1).data];
  const blue=()=>sample().join()==='0,0,255,255', red=()=>sample().join()==='255,0,0,255';
  const historySize=()=>all('.vig-ps-history-item.is-past').length;
  const undo=()=>click(title(mount,'撤销')),redo=()=>click(title(mount,'重做'));
  const change=(el,v)=>{flushSync(()=>{Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,String(v));el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));});};
  try {
    flushSync(()=>root.render(React.createElement(ui.PsView,{state:{library:[],presets:[]},actions:{toast:()=>{},attachReference:async v=>{reference=v.dataUrl;return true;}},
      initial:{name:'layer-audit.png',canvas:base,width:16,height:12,selection:{x:0,y:0,w:8,h:12},layers}})));
    await wait(60);
    check('初始合成只显示蓝层，三张 56px 小图各编码一次',blue()&&encoded===3,JSON.stringify({sample:sample(),encoded}));
    const snap=()=>ui.psApplyDpi(stage().toDataURL('image/png'),72);
    const matchesOutputs=async()=>{
      download=reference='';const expected=snap();click(all('.vig-toolbar .vig-btn').find(e=>e.textContent.trim()==='下载'));
      click($('.vig-toolbar .vig-btn.is-primary'));await wait(20);
      return download===expected && reference===expected;
    };
    click(title(row('blue'),'加蒙版（有选区就用选区）'));
    check('局部蒙版只画选区内的蓝层，参考图与导出都保留右半底图',blue() && sample(12).join()==='255,0,0,255' && await matchesOutputs());
    undo();check('撤销局部蒙版不会保留无效的遮罩',blue() && sample(12).join()==='0,0,255,255');
    click(chip().querySelector('.vig-ps-chip-eye'));check('关闭可见蓝层执行一次事务，底图像素重现',red()&&historySize()===1);
    check('隐藏层不进入下载或参考图，字节均与可见画布相同',await matchesOutputs());
    undo();check('显隐撤销回原色，重做可用',blue()&&!title(mount,'重做').disabled);redo();check('显隐重做生效',red());undo();
    click(chip());const alpha=$('.vig-ps-chipprops .vig-ps-layer-opacity');const n=historySize();
    flushSync(()=>alpha.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1})));change(alpha,80);change(alpha,50);change(alpha,25);flushSync(()=>alpha.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1})));
    check('一次透明度拖动更新三次预览，只占一条撤销',historySize()===n+1 && Math.abs(sample()[0]-191)<=1 && Math.abs(sample()[2]-64)<=1,JSON.stringify({sample:sample(),past:historySize(),n}));
    undo();check('一次撤销恢复拖动前的不透明度',blue());
    const blueRow=row('blue');change(blueRow.querySelector('select'),'multiply');check('高级面板复用事务：正片叠底像素变黑',sample().join()==='0,0,0,255');undo();
    click(title(row('blue'),'加蒙版（有选区就用选区）')); const initialMasked=[sample(),sample(12)];
    check('添加蒙版可撤销，画布及导出一致',historySize()>0 && await matchesOutputs());
    click(title(row('blue'),'反转蒙版'));const inverted=[sample(),sample(12)];
    check('反转蒙版后画布可见区域反转且导出一致',inverted.every((v,i)=>v[0]+initialMasked[i][0]===255 && v[2]+initialMasked[i][2]===255) && await matchesOutputs(),JSON.stringify({initialMasked,inverted}));
    const past=historySize();click(title(row('blue'),'删掉蒙版'));check('删除蒙版产生一步历史',historySize()===past+1 && blue());undo();check('撤销删除恢复同一覆盖率',JSON.stringify([sample(),sample(12)])===JSON.stringify(inverted));
    // Clicking on a child path of the eye button must not enter a layer session.
    const svg=row('green').querySelector('.vig-ps-layer-eye svg');flushSync(()=>svg.dispatchEvent(new MouseEvent('click',{bubbles:true})));check('嵌套图标点击仅切换显隐，不误入图层会话',!$('.vig-ps-layer-session') && sample().join()==='0,255,0,255');
    click(title(row('blue'),'上移'));check('上移后顺序可撤销',chip(1).textContent==='blue');undo();check('撤销上移恢复真实层序',chip(0).textContent==='blue');
    const data=new DataTransfer();flushSync(()=>chip(0).dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data})));flushSync(()=>chip(1).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})));check('拖拽排序可撤销',chip(1).textContent==='blue');undo();
    click(chip(1).querySelector('.vig-ps-chip-x'));check('删除当前合成层后可以原位撤销',!row('green'));undo();check('删除撤销恢复被删图层',!!row('green'));
    check('布局、显隐、顺序、模式、透明度、蒙版和撤销不重新编码原缩略图',encoded===3,JSON.stringify({expected:3,encoded}));
    // Session export is the editable *raw* canvas, not the composition, mask, or the hidden base.
    check('单层会话使用真实图层尺寸而非舞台合成',ui.psExportComposite(a,layers,true)===a && ui.psExportComposite(base,[{...layers[0],visible:false}],false)===base);
    const prev=encoded;ui.psLayerThumb(a,56,7);ui.psLayerThumb(a,56,7);check('显式像素版本失效一次且仅影响该层',encoded===prev+1);
  } catch(e) {check('图层事务审计完整执行',false,String(e.stack||e));}
  finally {HTMLCanvasElement.prototype.toDataURL=orig;HTMLAnchorElement.prototype.click=origClick;flushSync(()=>root.unmount());mount.remove();}
}
