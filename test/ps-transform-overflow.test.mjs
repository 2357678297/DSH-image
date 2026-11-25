// Offline Chrome acceptance. VIG_CLIENT_REF=v0.2.100.106 selects the released client for a before/after comparison.
export async function auditGripOverflow({host,check,wait,flushSync,ui,React,root}) {
  host.classList.add('vig-root');
  const q=s=>host.querySelector(s), all=s=>[...host.querySelectorAll(s)];
  const paint=(color)=>{const a=document.createElement('canvas');a.width=96;a.height=64;if(color){const g=a.getContext('2d');g.fillStyle=color;g.fillRect(0,0,96,64);}return a;};
  const fill=(a,color,x,y,w,h)=>{const g=a.getContext('2d');g.fillStyle=color;g.fillRect(x,y,w,h);};
  const read=(a,x,y)=>x>=0&&y>=0&&x<a.width&&y<a.height?[...a.getContext('2d').getImageData(Math.floor(x),Math.floor(y),1,1).data].join(','):'outside';
  const view=()=>q('.vig-ps-canvas'), grip=k=>q('[data-ps-handle="'+k+'"]'), hist=()=>all('.vig-ps-history-item.is-past').length;
  const click=async el=>{if(!el)throw Error('control missing');flushSync(()=>el.click());await wait(45);};
  const tool=()=>click(q('[data-ps-tool="transform"]')), undo=()=>click(q('.vig-toolbar [title="撤销"]'));
  const mount=async(key,canvas,extra={})=>{flushSync(()=>root.render(React.createElement(ui.PsView,{key,state:{library:[],presets:[]},actions:{toast(){}},initial:{name:key+'.png',canvas,width:canvas.width,height:canvas.height,scale:.25,...extra}})));await wait(80);};
  const sample=(x,y,expectedW,expectedH)=>{const c=view();return read(c,x*c.width/expectedW,y*c.height/expectedH);};
  const rect=el=>el.getBoundingClientRect();
  const fire=async(el,type,x,y)=>{flushSync(()=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerdown'||type==='pointermove'?1:0,isPrimary:true,pointerId:32,clientX:x,clientY:y})));await wait(45);};
  const drag=async(key,dx,dy,w=96,h=64)=>{const el=grip(key);if(!el)throw Error('missing '+key);const a=rect(el),v=rect(view()),x=a.left+a.width/2,y=a.top+a.height/2,tx=x+dx*v.width/w,ty=y+dy*v.height/h;await fire(el,'pointerdown',x,y);await fire(el,'pointermove',tx,ty);return {up:()=>fire(el,'pointerup',tx,ty),cancel:()=>fire(el,'pointercancel',tx,ty)};};
  const exportPng=async()=>{let url='';const original=HTMLAnchorElement.prototype.click;try{HTMLAnchorElement.prototype.click=function(){if(this.download)url=this.href;else original.call(this);};await click(all('.vig-toolbar button').find(e=>e.textContent.trim()==='下载'));}finally{HTMLAnchorElement.prototype.click=original;}if(!url.startsWith('data:image/png'))throw Error('no exported PNG');const img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);return c;};
  const assert=(name,pass,detail={})=>check(name,pass,JSON.stringify(detail));
  const red='255,0,0,255',green='0,255,0,255',blue='0,0,255,255';
  try {
    const original=paint('red');fill(original,'lime',72,0,24,64);const bytes=original.toDataURL();await mount('opaque',original);await tool();
    const initialW=rect(view()).width,initialHistory=hist(),g=await drag('e',64,0);
    const previewW=rect(view()).width,edge=rect(grip('e')),v=rect(view());
    assert('25% 不透明图向右拉出原画布，实时预览绿边伸到手柄处',Math.abs(previewW-initialW*160/96)<1.1&&Math.abs(edge.left+edge.width/2-v.right)<1.1&&sample(144,32,160,64)===green&&sample(88,32,160,64)===red&&hist()===initialHistory,{initialCssWidth:initialW,previewCssWidth:previewW,handleRight:edge.left+edge.width/2,canvasRight:v.right,inner:sample(88,32,160,64)});
    await g.up();const png=await exportPng();assert('松手后下载的 PNG 已扩为 160×64，原边界外有真实绿像素',png.width===160&&png.height===64&&read(png,88,32)===red&&read(png,144,32)===green&&hist()===initialHistory+1,{dimensions:[png.width,png.height],outsidePixel:read(png,144,32)});
    await undo();const back=await exportPng();assert('一次撤销还原原素材尺寸及全部像素',back.toDataURL()===bytes&&original.toDataURL()===bytes);
    const cancel=await drag('e',64,0);await cancel.cancel();assert('取消越界拉伸恢复预览尺寸，不写历史',Math.abs(rect(view()).width-initialW)<1&&hist()===initialHistory);
    const bg=paint('blue'),fg=paint(null);fill(bg,'lime',60,40,16,12);fill(fg,'red',8,8,24,16);
    await mount('negative-origin',bg,{layers:[{id:'foreground',name:'red patch',canvas:fg,visible:true,mode:'normal',opacity:1}]});await click(q('.vig-ps-chip:not(.is-base):not(.is-add)'));await tool();const nw=await drag('nw',-24,-16);await nw.up();const expanded=await exportPng();
    assert('左上越界后扩为 112×72，底图只平移补边，标记不被缩放',expanded.width===112&&expanded.height===72&&read(expanded,3,3)===red&&read(expanded,82,54)===green&&read(expanded,64,43)===blue,{size:[expanded.width,expanded.height],nw:read(expanded,3,3),marker:read(expanded,82,54)});
    const mask=paint(null);fill(mask,'white',24,16,32,24);const tex=paint('red');fill(tex,'lime',48,0,48,64);const alpha=Uint8ClampedArray.from({length:96*64},(_,i)=>i%96>=24&&i%96<56&&Math.floor(i/96)>=16&&Math.floor(i/96)<40?255:0);
    await mount('mask-only',paint('blue'),{layers:[{id:'texture',name:'banded',canvas:tex,visible:true,mode:'normal',opacity:1,mask:{canvas:mask,alpha}}]});await click(q('.vig-ps-chip:not(.is-base):not(.is-add)'));await click(q('[data-ps-grip-mode="mask"]'));const maskBefore=await exportPng(),m=await drag('e',-52,0);await m.up();const narrowed=await exportPng();
    assert('新增蒙版收窄只隐藏预期区域，旧蒙版外仍显示蓝底',narrowed.width===96&&read(narrowed,40,30)===red&&read(narrowed,49,30)===blue&&read(narrowed,2,2)===blue);
    const expandMask=await drag('e',28,0);await expandMask.up();const moved=await exportPng();assert('独立蒙版再扩大仅揭示原像素，原蒙版和颜色交界不改',read(moved,47,30)===red&&read(moved,49,30)===green&&read(moved,70,30)===blue&&moved.toDataURL()===maskBefore.toDataURL(),{boundary:read(moved,49,30),oldMasked:read(moved,70,30)});
    await undo();assert('撤销扩展准确恢复收窄状态',(await exportPng()).toDataURL()===narrowed.toDataURL());await click(q('[data-ps-mask-reset]'));assert('解除矩形限制不破坏已有用户蒙版',(await exportPng()).toDataURL()===maskBefore.toDataURL());
    await mount('base-mask',original);await tool();await click(q('[data-ps-grip-mode="mask"]'));const crop=await drag('e',-32,0);await crop.up();const cropped=await exportPng();assert('底图蒙版向内收时只隐藏像素，文档尺寸不变',cropped.width===96&&read(cropped,80,32)==='0,0,0,0'&&read(cropped,30,32)===red,{size:cropped.width,hidden:read(cropped,80,32)});
    await click(q('[data-ps-mask-reset]'));const revealed=await exportPng();assert('移除蒙版逐像素找回原素材，文件未被裁切',revealed.toDataURL()===bytes&&original.toDataURL()===bytes);
    const cropAgain=await drag('e',-32,0);await cropAgain.up();await click(q('[data-ps-grip-mode="pixels"]'));const shift=await drag('move',16,0);await shift.up();await click(q('[data-ps-grip-mode="mask"]'));await click(q('[data-ps-mask-reset]'));const restored=await exportPng();assert('蒙版后移动像素再移除蒙版，原图隐藏块同样跟着平移',read(restored,84,32)===red&&read(restored,92,32)===green&&read(restored,2,30)==='0,0,0,0',{dims:[restored.width,restored.height],movedGreen:read(restored,92,32)});
    await mount('session',paint('blue'),{layers:[{id:'local',name:'local edit',canvas:original,visible:true,mode:'normal'}]});const chip=q('.vig-ps-chip:not(.is-base):not(.is-add)');flushSync(()=>chip.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));await wait(40);await tool();const local=await drag('e',64,0);await local.up();await click(q('.vig-ps-layer-session button'));const stackPng=await exportPng();assert('单层编辑向右拉出旧边界，回到合成后保持扩张尺寸和边缘像素',stackPng.width===160&&stackPng.height===64&&read(stackPng,144,30)===green&&!q('.vig-ps-layer-session'),{dims:[stackPng.width,stackPng.height],newEdge:read(stackPng,144,30)});
  }catch(e){check('越界/独立蒙版专项执行完整',false,String(e.stack||e));}
}
