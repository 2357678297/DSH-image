// Run inside the offline Chrome viewer fixture: --query audit=pstransform.
export async function auditPsTransform({host,check,wait,flushSync,ui,React,root}) {
  host.classList.add('vig-root');
  const q=s=>host.querySelector(s), all=s=>[...host.querySelectorAll(s)], view=()=>q('.vig-ps-canvas');
  const ctr=(el)=>{const r=el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];};
  const ck=(name,ok,detail)=>check(name,ok,detail===undefined?'':JSON.stringify(detail));
  const make=(fill,patch)=>{const c=document.createElement('canvas');c.width=96;c.height=64;const g=c.getContext('2d');if(fill){g.fillStyle=fill;g.fillRect(0,0,96,64);}if(patch){g.fillStyle=patch;g.fillRect(24,16,32,24);}return c;};
  const mount=async(key,canvas,extra={})=>{flushSync(()=>root.render(React.createElement(ui.PsView,{key,state:{library:[],presets:[]},actions:{toast(){}},initial:{name:'offset-test.png',canvas,width:canvas.width,height:canvas.height,tool:'select',...extra}})));await wait(80);};
  const click=async el=>{if(!el)throw Error('control not found');flushSync(()=>el.click());await wait(45);};
  const enter=()=>click(q('[data-ps-tool="transform"]'));
  const h=k=>q('[data-ps-handle="'+k+'"]');
  const fire=async(el,type,x,y,shift=false)=>{flushSync(()=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerdown'||type==='pointermove'?1:0,isPrimary:true,pointerId:11,clientX:x,clientY:y,shiftKey:shift})));await wait(35);};
  const gesture=async(key,dx,dy,shift=false)=>{const el=h(key);if(!el)throw Error('handle missing: '+key);const [x,y]=ctr(el),r=view().getBoundingClientRect();const tx=x+dx*r.width/w,ty=y+dy*r.height/ht;
    await fire(el,'pointerdown',x,y,shift);await fire(el,'pointermove',tx,ty,shift);return {up:()=>fire(el,'pointerup',tx,ty,shift),cancel:()=>fire(el,'pointercancel',tx,ty,shift)};};
  const col=(x,y)=>{const c=view();return [...c.getContext('2d').getImageData(Math.floor(x*c.width/w),Math.floor(y*c.height/ht),1,1).data].join(',');};
  const snap=()=>view().toDataURL(), history=()=>all('.vig-ps-history-item.is-past').length;
  const undo=()=>click(q('.vig-toolbar [title="撤销"]'));
  let w=96,ht=64;
  try {
    const red='255,0,0,255',blue='0,0,255,255',clear='0,0,0,0';
    await mount('base',make(null,'red'));ck('普通框选保持原样，没有自由变换手柄',!h('move')&&!!view());await enter();
    const keys=['nw','n','ne','w','move','e','sw','s','se'];const nodes=all('[data-ps-handle]');
    ck('当前目标有且仅有九个不同的拖动手柄',nodes.length===9&&keys.every(k=>!!h(k)),nodes.map(el=>el.dataset.psHandle));
    const r=view().getBoundingClientRect(), anchorPoints=[[24,16],[40,16],[56,16],[24,28],[40,28],[56,28],[24,40],[40,40],[56,40]];
    ck('九点实际布局贴合内容包围框的四角、四边和中心',keys.every((key,i)=>{const [x,y]=ctr(h(key)),[sx,sy]=anchorPoints[i];return Math.abs(x-r.left-r.width*sx/w)<2&&Math.abs(y-r.top-r.height*sy/ht)<2;}),keys.map(key=>ctr(h(key))));
    const initial=snap(), moves=history(); const drag=await gesture('move',12,6);ck('移动中立即显示预览，不写撤销历史',col(26,20)===clear&&col(61,30)===red&&history()===moves);
    await drag.up();ck('松开提交移动且只有一条撤销记录',col(26,20)===clear&&col(61,30)===red&&history()===moves+1);await undo();ck('一次撤销逐像素恢复移动前图像',snap()===initial&&history()===moves);
    for(const [key,dx,dy,x,y] of [['e',8,0,61,30],['w',-8,0,18,30],['n',0,-8,35,10],['s',0,8,35,45],['ne',8,-8,61,10],['nw',-8,-8,18,10],['se',8,8,61,45],['sw',-8,8,18,45]]) {
      const g=await gesture(key,dx,dy);await g.up();ck(key+' 拉伸影响预期边缘像素且只提交一次',col(x,y)===red&&history()===moves+1,{sample:col(x,y),history:history()});await undo();
    }
    const phys=()=>{const a=ctr(h('nw')),b=ctr(h('se'));return (b[0]-a[0])/(b[1]-a[1]);};
    const ratio=phys(),locked=await gesture('se',12,1,true);await locked.up();ck('Shift 拖角保持包围盒宽高比',Math.abs(ratio-4/3)<.05&&Math.abs(phys()-ratio)<.09,{before:ratio,after:phys()});await undo();
    const cancel=await gesture('move',14,8);await cancel.cancel();ck('pointercancel 不改像素及历史',snap()===initial&&history()===moves);
    const esc=await gesture('se',8,8);flushSync(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));await wait(35);await esc.up();ck('Esc 取消后松手也不提交',snap()===initial&&history()===moves);
    await click(all('.vig-ps-zoom-btn').find(el=>el.textContent.trim()==='+'));const z=await gesture('move',12,6);await z.up();ck('缩放后拖动仍按源图像素换算位移',col(26,20)===clear&&col(61,30)===red);
    const mask=make(null,null);const mg=mask.getContext('2d');mg.fillStyle='white';mg.fillRect(28,20,16,12);
    await mount('layer',make('blue'),{layers:[{id:'red-patch',name:'red patch',canvas:make(null,'red'),mask:{canvas:mask},visible:true,opacity:1,mode:'normal'}]});
    await click(q('.vig-ps-chip:not(.is-base):not(.is-add)'));
    ck('单击普通图层缩略卡直接显示九手柄，无需再切工具',keys.every(k=>!!h(k))&&!q('.vig-ps-layer-session'));
    const maskedBefore=snap(),oldHistory=history(),layer=await gesture('move',12,6);await layer.up();
    const maskedAfter=snap();ck('图层与局部蒙版同时移动，底图不动，蒙版外无像素泄漏',col(1,1)===blue&&col(31,23)===blue&&col(50,33)===red&&col(60,33)===blue&&maskedAfter!==maskedBefore&&history()===oldHistory+1);
    await undo();ck('一次撤销恢复完整蒙版合成，重做按钮可用',snap()===maskedBefore&&!q('.vig-toolbar [title="重做"]').disabled);
    await click(q('.vig-toolbar [title="重做"]'));ck('重做逐像素恢复图层和蒙版的平移结果',snap()===maskedAfter);
    await mount('warp',make('blue','red'),{tool:'warp'});const cv=view();const box=cv.getBoundingClientRect();for(const [fx,fy] of [[.25,.25],[.75,.25],[.75,.75],[.25,.75]])await fire(cv,'pointerdown',box.left+fx*box.width,box.top+fy*box.height);
    const confirm=q('[data-warp-confirm]');if(!confirm||confirm.disabled)throw Error('could not create warp session');await click(confirm);w=view().width;ht=view().height;await enter();
    const before=snap(),hist=history(),session=await gesture('move',8,0);await session.up();ck('透视矫正结果的单层会话可直接拖动，保留图层并只提交一次',!!q('.vig-ps-layer-session')&&all('.vig-ps-chip:not(.is-base):not(.is-add)').length===1&&col(2,5)===clear&&snap()!==before&&history()===hist+1);
    await undo();ck('撤销变换恢复矫正结果，不退出编辑会话',snap()===before&&!!q('.vig-ps-layer-session'));
  } catch(e) {check('九锚点专项执行完整',false,String(e.stack||e));}
}
