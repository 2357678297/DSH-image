// node tools/viewer-check.mjs --query audit=attachment
// The existing bounded runGridPage mounts the real Workbench in Chrome. All APIs below
// are controlled local mocks; source PNGs are decoded by Chrome and pixels are read back.
// Keyboard events exercise production handlers/focus, NOT native Tab/default activation.
export async function auditAttachmentUI({host,check,wait,waitFor,flushSync}) {
  const q=s=>host.querySelector(s), all=s=>Array.from(host.querySelectorAll(s));
  const ctrl=(key)=>q('[data-attachment-'+key+']'), chip=i=>all('.vig-composer .vig-ref')[i];
  const opener=i=>q('[data-ref-open="'+i+'"]'), composer=()=>q('.vig-composer textarea.vig-input');
  const need=(n,label)=>{if(!n)throw Error('附件缺少控件：'+label);return n;};
  const click=n=>flushSync(()=>need(n,'click').click());
  const set=(n,value)=>flushSync(()=>{
    need(n,'value');const proto=n.tagName==='SELECT'?HTMLSelectElement.prototype:n.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(n,String(value));
    n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));
  });
  const until=async(fn,label,ms=2500)=>{const hit=await waitFor(fn,ms);if(!hit)throw Error('附件等待超时：'+label);return hit;};
  const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  const pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const equal=(a,b)=>a?.length===b?.length&&a.every((v,i)=>v===b[i]);
  const decode=async url=>{const image=new Image();image.src=url;await image.decode();const c=canvas(image.naturalWidth,image.naturalHeight);c.getContext('2d').drawImage(image,0,0);return c;};
  const dataBlob=url=>{const [head,body]=url.split(',');return new Blob([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],{type:head.match(/^data:([^;]+)/)?.[1]||'image/png'});};
  const rgbAt=(c,x,y)=>Array.from(c.getContext('2d').getImageData(x,y,1,1).data);
  const source=canvas(320,160), ctx=source.getContext('2d'), rgba=ctx.createImageData(320,160);
  for(let y=0;y<160;y++)for(let x=0;x<320;x++){
    const i=(y*320+x)*4;if(x>=288&&y<32)continue;
    rgba.data.set(x<160?[220,x%97,y%131,255]:[x%151,210,y%131,x>=256&&x<288&&y<32?128:255],i);
  }
  ctx.putImageData(rgba,0,0);const original=source.toDataURL('image/png'), originalPixels=pixels(source);
  const siteURL='/api/velapi-image-go/asset/grid-qa-source.png', site=canvas(360,144), siteCtx=site.getContext('2d'), siteRGBA=siteCtx.createImageData(360,144);
  for(let y=0;y<144;y++)for(let x=0;x<360;x++)siteRGBA.data.set([x%251,y,(x+3*y)%251,255],(y*360+x)*4);
  siteCtx.putImageData(siteRGBA,0,0);const siteData=site.toDataURL('image/png');
  const originalFetch=window.fetch, originalConfirm=window.confirm, uploads=[], sends=[], otherWrites=[], plans=[], held=new Set(), urlData=new Map();
  let sequence=0, reads=0, lastOpener=null, holdHydration=false, manualRequests=0;
  const clickGenerate=()=>{manualRequests++;click(q('[data-force-generate]'));};
  const hydrationReleases=[];
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const enqueue=plan=>{plans.push(plan);return plan;};
  const settle=async(record,ok=true)=>{need(record?.release,'受控上传');record.release(ok);await until(()=>record.settled,'受控上传结束');await wait(35);};
  const snapshot=()=>all('.vig-composer .vig-ref img').map(n=>n.getAttribute('src'));
  const refPNG=async i=>{const src=need(chip(i)?.querySelector('img'),'附件缩略图').getAttribute('src');return decode(urlData.get(src)||src);};
  const clear=async()=>{if(ctrl('editor'))click(ctrl('cancel'));while(chip(0))click(chip(0).querySelector('.vig-ref-x'));await wait(20);};
  const attach=async(name='same.png',data=original,plan=null)=>{
    const n=all('.vig-composer .vig-ref').length, u=uploads.length;if(plan)enqueue(plan);
    const dt=new DataTransfer(),blob=dataBlob(data);dt.items.add(new File([blob],name,{type:blob.type}));
    flushSync(()=>q('.vig-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt})));
    await until(()=>all('.vig-composer .vig-ref').length===n+1&&uploads.length>u,'真实文件拖入');await wait(20);return uploads[u];
  };
  const open=async(i=0)=>{
    lastOpener=need(opener(i),'预览入口 '+i);lastOpener.focus({preventScroll:true});click(lastOpener);
    await until(()=>ctrl('canvas')?.width>1&&!ctrl('error'),'原始像素载入');await wait(15);return ctrl('canvas');
  };
  const close=async key=>{click(ctrl(key||'cancel'));await until(()=>!ctrl('editor'),'关闭附件');await wait(15);};
  const pointer=(kind,x,y,id=17)=>{
    const c=need(ctrl('canvas'),'画布'),r=c.getBoundingClientRect();
    // dispatchEvent is not a trusted active pointer; exercise the real handlers without
    // asking Chrome to capture a nonexistent device pointer. Native capture is not claimed.
    const capture=c.setPointerCapture,release=c.releasePointerCapture;
    c.setPointerCapture=()=>{};c.releasePointerCapture=()=>{};
    try {flushSync(()=>c.dispatchEvent(new PointerEvent(kind,{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',isPrimary:true,button:0,buttons:kind==='pointerup'||kind==='pointercancel'?0:1,clientX:r.left+x/c.width*r.width,clientY:r.top+y/c.height*r.height})));}
    finally {c.setPointerCapture=capture;c.releasePointerCapture=release;}
  };
  const draw=async(color='#ff00ff',from=[65,75],to=[230,75])=>{
    click(q('[data-attachment-tool="draw"]'));set(ctrl('color'),color);set(ctrl('width'),12);
    pointer('pointerdown',...from);pointer('pointermove',...to);pointer('pointerup',...to);await wait(15);
  };
  const save=async(plan=null)=>{const n=uploads.length;if(plan)enqueue(plan);const button=need(ctrl('save'),'保存按钮');flushSync(()=>{button.click();button.click();});await until(()=>!ctrl('editor'),'PNG保存关窗');await until(()=>uploads.length>n,'新PNG上传');await wait(25);check('快速双击保存只编码上传一次',uploads.length===n+1);return uploads[n];};
  const tool=k=>q('[data-attachment-tool="'+k+'"]');
  const switchTo=async id=>{
    let node=q('[data-conv="'+id+'"]');
    if(!node){const toggle=q('[data-side-toggle]')||all('button').find(n=>n.getAttribute('aria-label')==='展开侧栏');if(toggle)click(toggle);node=await until(()=>q('[data-conv="'+id+'"]'),'会话导航 '+id);}
    click(node);await until(()=>q('[data-conv="'+id+'"][aria-current="true"]'),'切换会话完成 '+id);await wait(35);
  };
  const suite=async(name,run)=>{try{await run();}catch(e){check(name+' 完整执行',false,String(e.stack||e)+'; editor='+(ctrl('editor')?.textContent||'closed').slice(-250));}finally{
    if(ctrl('editor'))click(ctrl('cancel'));
    for(const record of [...held])record.release(false);
    plans.length=0;holdHydration=false;hydrationReleases.splice(0).forEach(release=>release());await wait(20);
  }};
  try {
    window.confirm=()=>true;
    window.fetch=async(input,init={})=>{
      const raw=typeof input==='string'?input:input.url||String(input),u=new URL(raw,location.href),route=u.pathname.replace(/^.*?\/api\/velapi-image-go/,'');
      if(raw.startsWith('data:image/png;base64,'))return new Response(dataBlob(raw));
      if(u.pathname===siteURL){reads++;if(holdHydration)await new Promise(resolve=>{hydrationReleases.push(resolve);});return new Response(dataBlob(siteData));}
      if(urlData.has(u.pathname))return new Response(dataBlob(urlData.get(u.pathname)));
      if(route==='/upload'&&(init.method||'GET').toUpperCase()==='POST'){
        const body=JSON.parse(init.body),plan=plans.shift()||{},id=++sequence,url='/api/velapi-image-go/upload/attachment-qa-'+id+'.png';
        const record={body,url,settled:false,plan};uploads.push(record);
        let ok=!plan.fail;if(plan.hold)ok=await new Promise(resolve=>{record.release=resolve;held.add(record);});
        record.settled=true;held.delete(record);if(ok){urlData.set(url,body.data);return response({ok:true,item:{url,name:body.name}});}
        return response({ok:false,error:'fixture upload failure — edited PNG retained'},503);
      }
      if(route==='/generate'){
        const body=JSON.parse(init.body);sends.push(body);return response({ok:true,queue:0,job:{id:'attachment-qa-job-'+sends.length,conversationId:body.conversationId,status:'succeeded',images:[],prompt:body.prompt}});
      }
      if(route==='/job'&&u.searchParams.get('id')?.startsWith('attachment-qa-job-'))return response({ok:true,job:{id:u.searchParams.get('id'),status:'succeeded',images:[]}});
      if((init.method||'GET').toUpperCase()!=='GET')otherWrites.push({route,body:typeof init.body==='string'?JSON.parse(init.body):null});
      return originalFetch(input,init);
    };
    check('附件专项仍在原Workbench+原runGridPage本机HTTP夹具，不接触用户会话',location.hostname==='127.0.0.1'&&!!q('.vig-root')&&!!composer());
    check('夹具启动没有预置composer附件，后续均经真实drop/历史恢复路径添加',!chip(0));

    await suite('查看/键盘/取消/透明像素',async()=>{
      await clear();set(composer(),'附件编辑保留 prompt');await attach();
      check('dataURL附件缩略图提供可聚焦button与可访问名称',opener(0) instanceof HTMLButtonElement&&opener(0).tabIndex===0&&!!(opener(0).getAttribute('aria-label')||opener(0).textContent)?.trim());
      const before=snapshot(),u=uploads.length,writes=otherWrites.length;
      let c=await open();check('点击默认仅查看，实际PNG尺寸/全部RGBA与原附件相同',c.width===320&&c.height===160&&equal(pixels(c),originalPixels)&&tool('view')?.getAttribute('aria-pressed')==='true'&&ctrl('save').disabled);
      check('原图含真实半透明与全透明像素，解码alpha分别保持128/0',rgbAt(c,270,10)[3]===128&&rgbAt(c,300,10)[3]===0);
      pointer('pointerdown',40,40);pointer('pointermove',100,90);pointer('pointerup',100,90);
      check('查看模式拖动零落笔，原透明区域alpha仍0',equal(pixels(ctrl('canvas')),originalPixels)&&rgbAt(ctrl('canvas'),300,10)[3]===0);
      const dt=new DataTransfer();dt.items.add(new File([dataBlob(original)],'pasted.png',{type:'image/png'}));
      flushSync(()=>ctrl('editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt})));await wait(50);
      check('dialog内粘图不冒泡给composer，零新增附件/上传',all('.vig-composer .vig-ref').length===1&&uploads.length===u);
      await close('cancel');check('取消查看不改原图、不上传，焦点回原入口',equal(snapshot(),before)&&uploads.length===u&&document.activeElement===lastOpener);
      lastOpener=opener(0);lastOpener.focus();flushSync(()=>lastOpener.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})));
      // Synthetic KeyboardEvent does not invoke Chrome's native button activation. If there is no
      // explicit handler, click the same native button and report only the actual focus contract.
      const explicitEnter=!!ctrl('editor');if(!explicitEnter)click(lastOpener);await until(()=>ctrl('canvas')?.width===320,'键盘入口查看');
      check('键盘入口是原生button且可focus；原生Tab/Enter未实测',document.activeElement!==document.body&&!!ctrl('editor'),JSON.stringify({explicitEnterHandler:explicitEnter,nativeTabEnter:'not exercised; synthetic events only; native activation fallback is click()'}));
      flushSync(()=>ctrl('editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true})));await until(()=>!ctrl('editor'),'Escape关闭');await wait(15);
      check('生产Escape关闭并回焦，prompt/原图/零生成保留',document.activeElement===lastOpener&&composer().value==='附件编辑保留 prompt'&&equal(snapshot(),before)&&sends.length===0&&otherWrites.length===writes);
      await open();await draw();const painted=pixels(ctrl('canvas'));check('涂鸦改变实际像素且透明角保持alpha0',!equal(painted,originalPixels)&&rgbAt(ctrl('canvas'),140,75).join(',')==='255,0,255,255'&&rgbAt(ctrl('canvas'),300,10)[3]===0);
      check('涂鸦后半透明区RGBA保持原样，原source画布从未被编辑',rgbAt(ctrl('canvas'),270,10).join(',')===rgbAt(source,270,10).join(',')&&equal(pixels(source),originalPixels));
      click(ctrl('undo'));check('涂鸦undo逐像素还原',equal(pixels(ctrl('canvas')),originalPixels));click(ctrl('redo'));check('涂鸦redo逐像素重现',equal(pixels(ctrl('canvas')),painted));
      click(ctrl('reset'));check('reset回到编辑前原图并清掉可重做编辑',equal(pixels(ctrl('canvas')),originalPixels)&&ctrl('redo').disabled);
      const c2=ctrl('canvas');c2.style.width='160px';c2.style.height='80px';await wait(25);await draw('#00ffff',[30,110],[210,110]);
      check('CSS画布缩到原图一半，笔迹仍命中原像素坐标',Math.abs(c2.getBoundingClientRect().width-160)<1&&rgbAt(ctrl('canvas'),120,110).join(',')==='0,255,255,255'&&rgbAt(ctrl('canvas'),60,55).join(',')===rgbAt(source,60,55).join(','),JSON.stringify({css:c2.getBoundingClientRect().width,bitmap:c2.width,at:[120,110]}));
      click(ctrl('reset'));const historyBeforeCancel={undo:ctrl('undo').disabled,redo:ctrl('redo').disabled};pointer('pointerdown',40,80);pointer('pointermove',200,80);pointer('pointercancel',200,80);await wait(20);
      check('pointercancel回滚整笔，不产生历史/脏图',equal(pixels(ctrl('canvas')),originalPixels)&&ctrl('undo').disabled===historyBeforeCancel.undo&&ctrl('redo').disabled===historyBeforeCancel.redo);
      pointer('pointerdown',60,60);pointer('pointermove',220,60);flushSync(()=>ctrl('canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
      check('手势中Escape只回滚当前笔并保持窗口，已确认历史不变',!!ctrl('editor')&&equal(pixels(ctrl('canvas')),originalPixels));
      await draw();await close('close');check('关闭编辑丢弃涂鸦，原附件字节/上传数不变',equal(snapshot(),before)&&uploads.length===u&&sends.length===0);
    });

    await suite('裁切真实PNG与历史',async()=>{
      await clear();await attach();await open();click(tool('crop'));
      // Numeric rectangle is the non-dragging alternative; also test a pointer rectangle
      // in the actual contain-fit canvas and compare its visible overlay geometry.
      click(tool('crop'));pointer('pointerdown',30,20);pointer('pointermove',180,100);pointer('pointerup',180,100);await wait(20);
      const overlay=ctrl('crop-rect')?.getBoundingClientRect(),box=ctrl('canvas').getBoundingClientRect();
      check('拖动裁切框按原像素映射，覆盖框与真实画布坐标对齐',!!overlay&&Math.abs(overlay.left-(box.left+30/320*box.width))<1.5&&Math.abs(overlay.top-(box.top+20/160*box.height))<1.5&&Math.abs(overlay.width-150/320*box.width)<1.5&&Math.abs(overlay.height-80/160*box.height)<1.5,JSON.stringify({overlay:overlay&&[overlay.left,overlay.top,overlay.width,overlay.height],canvas:[box.left,box.top,box.width,box.height]}));
      const rectBefore=Array.from(['x','y','width','height'],key=>ctrl('crop-'+key).value).join(',');pointer('pointerdown',50,30);pointer('pointermove',140,90);pointer('pointercancel',140,90);await wait(20);
      check('裁切pointercancel还原先前选框而非提交新crop',Array.from(['x','y','width','height'],key=>ctrl('crop-'+key).value).join(',')===rectBefore&&equal(pixels(ctrl('canvas')),originalPixels));
      for(const [key,value]of [['x',80],['y',40],['width',160],['height',96]])set(ctrl('crop-'+key),value);
      click(ctrl('crop-apply'));await wait(20);let c=ctrl('canvas'),cropPixels=pixels(c),expected=source.getContext('2d').getImageData(80,40,160,96).data;
      check('crop数值框实际截取160×96，所有RGBA等于原区域且丢弃非裁区',c.width===160&&c.height===96&&equal(cropPixels,expected),JSON.stringify({w:c.width,h:c.height}));
      click(ctrl('undo'));check('crop undo恢复原尺寸与全部原像素',ctrl('canvas').width===320&&ctrl('canvas').height===160&&equal(pixels(ctrl('canvas')),originalPixels));
      click(ctrl('redo'));check('crop redo恢复裁切真实尺寸及像素',ctrl('canvas').width===160&&ctrl('canvas').height===96&&equal(pixels(ctrl('canvas')),cropPixels));
      const upload=await save(),saved=await decode(upload.body.data);
      check('保存上传真实image/png，IHDR尺寸与裁切区域逐像素一致',/^data:image\/png;base64,/.test(upload.body.data)&&saved.width===160&&saved.height===96&&equal(pixels(saved),expected)&&equal(pixels(await refPNG(0)),expected));
      await open();click(ctrl('reset'));check('后续编辑reset以已保存裁图为原件，不回最初320图',ctrl('canvas').width===160&&ctrl('canvas').height===96&&equal(pixels(ctrl('canvas')),expected));await close();
      check('所有查看/涂鸦/裁切/撤重/保存只上传附件，不生图不写图库',sends.length===0&&!otherWrites.some(p=>/^\/(generate|chat\/|library|asset\/export|config)/.test(p.route)),otherWrites.map(p=>p.route).join(','));
    });

    await suite('未确认crop与撤重边界',async()=>{
      await clear();await attach();await open();await draw();const committed=pixels(ctrl('canvas')),n=uploads.length;click(tool('crop'));
      pointer('pointerdown',20,20);pointer('pointermove',170,120);pointer('pointerup',170,120);
      check('已有涂鸦再画待确认crop，Save禁用且点击不上传不关窗',ctrl('save').disabled&&!!ctrl('crop-rect'));
      click(ctrl('save'));await wait(25);check('待确认裁切不能被Save绕过',!!ctrl('editor')&&uploads.length===n&&equal(pixels(ctrl('canvas')),committed));
      click(tool('view'));check('切查看丢弃待确认crop后恢复Save，保留已确认涂鸦',!ctrl('crop-rect')&&!ctrl('save').disabled&&equal(pixels(ctrl('canvas')),committed));
      const undo=ctrl('undo');flushSync(()=>{undo.click();undo.click();undo.click();});
      check('连续undo停在历史起点，不越界写空图',ctrl('undo').disabled&&equal(pixels(ctrl('canvas')),originalPixels));
      const redo=ctrl('redo');flushSync(()=>{redo.click();redo.click();redo.click();});
      check('连续redo停在历史终点，精确回已确认像素',ctrl('redo').disabled&&equal(pixels(ctrl('canvas')),committed));await close();
    });

    await suite('重复附件、初始与后续上传错序',async()=>{
      await clear();const first=await attach('duplicate.png',original,{hold:true});const second=await attach('duplicate.png',original,{hold:true});
      const before=snapshot();await open(1);await draw();const one=await save({hold:true}),firstEdit=one.body.data;
      check('重复同名同字节附件保存只替换目标，旧URL立即清除',snapshot()[0]===before[0]&&snapshot()[1]===firstEdit&&firstEdit!==before[1]&&all('.vig-composer .vig-ref').length===2);
      await settle(second);await settle(first);check('旧initial upload晚于save返回，不能覆盖目标新dataURL',snapshot()[0]===before[0]&&snapshot()[1]===firstEdit);
      await open(1);await draw('#00ffff',[50,115],[250,115]);const two=await save({hold:true}),newest=two.body.data;
      await settle(two);await settle(one);check('后续两次编辑save上传倒序，最新字节及URL不会被旧revision覆盖',newest!==firstEdit&&snapshot()[1]===newest&&snapshot()[0]===before[0]);
      // Inspect the actual outgoing request; a stable thumbnail alone cannot prove URL ownership.
      set(composer(),'manual latest duplicate');const n=sends.length;clickGenerate();await until(()=>sends.length===n+1,'手动发送最新附件');const body=sends.at(-1);
      check('手动生成确用最新save URL，另一个重复附件引用与prompt保留',body.prompt==='manual latest duplicate'&&body.referenceUrls?.length===2&&body.referenceUrls[0]===first.url&&body.referenceUrls[1]===two.url&&!body.referenceUrls.includes(one.url)&&body.conversationId==='conv_default',JSON.stringify({prompt:body.prompt,urls:body.referenceUrls}));
      check('最新URL映射的实际PNG字节就是二次涂鸦，不是旧原件',urlData.get(body.referenceUrls?.[1])===newest&&urlData.get(body.referenceUrls?.[0])===original);
    });

    await suite('删除与会话ownership',async()=>{
      await clear();await attach();await attach('keep.png');await open(0);await draw();const deleted=await save({hold:true});click(chip(0).querySelector('.vig-ref-x'));const survivor=snapshot()[0];await settle(deleted);
      check('保存上传中删除目标，旧响应不复活附件或改写相邻附件',all('.vig-composer .vig-ref').length===1&&snapshot()[0]===survivor);
      await clear();await attach();set(composer(),'A parked draft');await open();await draw();const parked=await save({hold:true}),edited=parked.body.data;await switchTo('conv_old');
      check('保存期间切换会话关闭窗口且B无A附件/草稿',!ctrl('editor')&&all('.vig-composer .vig-ref').length===0&&composer().value!=='A parked draft');
      await attach('B.png');const b=snapshot()[0];set(composer(),'B isolated draft');await settle(parked);check('A保存上传晚回不写B当前附件或文本',snapshot().length===1&&snapshot()[0]===b&&composer().value==='B isolated draft');
      await switchTo('conv_default');check('返回A保留自己的新字节与草稿，不回旧图',snapshot().length===1&&snapshot()[0]===edited&&composer().value==='A parked draft');
      await open();await draw();await switchTo('conv_old');const restoredB=await refPNG(0);check('编辑未保存时切会话不泄漏modal或未确认像素',!ctrl('editor')&&equal(pixels(restoredB),originalPixels)&&composer().value==='B isolated draft',JSON.stringify({modal:!!ctrl('editor'),refs:snapshot().map(s=>s.slice(0,60)),draft:composer().value,active:q('[data-conv][aria-current="true"]')?.getAttribute('data-conv')}));await switchTo('conv_default');const resumed=await refPNG(0),storedVersion=await decode(edited);check('回A仍为已保存版本而非未确认笔迹，宿主链接对应同一 PNG',snapshot()[0]===parked.url&&urlData.get(parked.url)===edited&&equal(pixels(resumed),pixels(storedVersion)));
    });

    await suite('上传失败保留并重发新字节',async()=>{
      await clear();const initial=await attach();set(composer(),'failed save retry prompt');await open();await draw();const failed=await save({fail:true});await until(()=>failed.settled,'上传模拟失败');
      check('保存上传失败保留新dataURL，不回旧图，并给可读失败反馈',snapshot()[0]===failed.body.data&&snapshot()[0]!==original&&!!q('.vig-toasts')?.textContent.trim(),q('.vig-toasts')?.textContent);
      const n=uploads.length,g=sends.length;clickGenerate();await until(()=>sends.length===g+1,'失败后显式发送');const retry=uploads[n],body=sends.at(-1);
      check('后续手动发送重新上传最新dataURL并使用新URL，不发旧initial URL',uploads.length===n+1&&retry?.body.data===failed.body.data&&body.referenceUrls?.[0]===retry.url&&body.referenceUrls?.[0]!==initial.url&&body.prompt==='failed save retry prompt',JSON.stringify({uploads:uploads.length-n,urls:body.referenceUrls}));
      const sent=await decode(urlData.get(body.referenceUrls?.[0]));check('重传PNG实际带新涂鸦且透明保持',rgbAt(sent,140,75).join(',')==='255,0,255,255'&&rgbAt(sent,300,10)[3]===0);
    });

    await suite('本站URL直读、重复URL与过期水合',async()=>{
      await clear();holdHydration=true;
      const turn=all('article.is-user').find(n=>n.textContent.includes('Attachment duplicate URL fixture'));
      click(turn?.nextElementSibling?.querySelector('button[aria-label="编辑提示词（填回输入框）"]'));
      await until(()=>opener(1)&&hydrationReleases.length===2,'重复URL附件与待回包水合');
      check('两个完全同URL附件仍是独立预览入口',snapshot().length===2&&snapshot()[0]===siteURL&&snapshot()[1]===siteURL&&opener(0)!==opener(1));
      await open(1);check('水合尚未返回也能直接解码本站HTTP PNG原图',ctrl('canvas').width===360&&ctrl('canvas').height===144&&equal(pixels(ctrl('canvas')),pixels(site)));
      await draw();const uploaded=await save({hold:true}),newData=uploaded.body.data;
      holdHydration=false;hydrationReleases.splice(0).forEach(release=>release());await wait(80);
      check('旧URL水合在保存后晚回，仅补未改附件、不覆盖目标新像素',snapshot().length===2&&snapshot()[1]===newData&&snapshot()[0]!==newData&&equal(pixels(await refPNG(0)),pixels(site)));
      await settle(uploaded);set(composer(),'same URL target only');const g=sends.length;clickGenerate();await until(()=>sends.length===g+1,'重复URL编辑后发送');const body=sends.at(-1);
      check('同URL重复附件编辑后发送只换目标，其余仍原URL',body.referenceUrls?.length===2&&body.referenceUrls[0]===siteURL&&body.referenceUrls[1]===uploaded.url,JSON.stringify(body.referenceUrls));
    });

    await suite('本站URL与旧JSON引用覆盖',async()=>{
      await clear();const turn=all('article.is-user').find(n=>n.textContent.includes('Attachment URL fixture')),button=turn?.nextElementSibling?.querySelector('button[aria-label="编辑提示词（填回输入框）"]');click(button);await until(()=>opener(0),'URL附件恢复');
      await open();check('本站URL附件由Chrome解码，尺寸/全部像素对应真实HTTP PNG',ctrl('canvas').width===360&&ctrl('canvas').height===144&&equal(pixels(ctrl('canvas')),pixels(site))&&reads>0);await close();
      // JSON may hold references that pre-date the edit; save must invalidate only image fields.
      set(composer(),'JSON refs edited prompt');click(q('[data-json-body]'));const editor=await until(()=>q('[data-json-editor]'),'JSON覆盖编辑');const previous=JSON.parse(editor.value);
      set(editor,JSON.stringify({...previous,referenceUrl:siteURL,referenceUrls:[siteURL],image:siteData,images:[siteData],quality:'HIGH',prompt:'JSON refs edited prompt'}));click(q('[data-json-apply]'));await until(()=>!q('[data-json-editor]'),'JSON覆盖应用');
      await open();await draw();const uploaded=await save();const g=sends.length;clickGenerate();await until(()=>sends.length===g+1,'JSON旧引用后手动发送');const body=sends.at(-1);
      const refs=[body.referenceUrl,...(body.referenceUrls||[])].filter(Boolean),byteFields=[body.image,...(body.images||[])].filter(Boolean);
      check('编辑保存清除JSON里的旧referenceUrl/referenceUrls/image/images，不覆回旧图',refs.length>0&&refs.every(u=>u===uploaded.url)&&byteFields.every(value=>value===uploaded.body.data)&&!refs.includes(siteURL),JSON.stringify({refs,byteFields:byteFields.map(x=>typeof x==='string'?x.slice(0,32):typeof x)}));
      check('清旧引用不丢其它JSON设置和prompt',body.quality==='HIGH'&&body.prompt==='JSON refs edited prompt'&&body.providerId==='pv_gpt',JSON.stringify({quality:body.quality,prompt:body.prompt,provider:body.providerId}));
    });

    await suite('375窄栏与短高焦点',async()=>{
      await clear();await attach();
      // Keep a real product toast alive when the narrow dialog opens; do not let its
      // auto-dismiss timer accidentally hide the previously reproduced hit-target bug.
      click(q('[data-json-body]'));await until(()=>q('[data-json-editor]'),'窄栏前JSON反馈');click(q('[data-json-apply]'));await until(()=>!q('[data-json-editor]'),'窄栏前JSON应用');
      host.style.width='375px';host.style.height='560px';await wait(80);await open();click(tool('crop'));await wait(50);
      check('附件dialog内真实toast仍可读但不截获裁切/工具点击',!!q('dialog .vig-toast')&&all('dialog .vig-toast').every(n=>getComputedStyle(n).pointerEvents==='none'));
      const ed=ctrl('editor'),dialog=ed.closest('dialog'),nodes=[ed,dialog,ctrl('canvas')],controls=['save','cancel','crop-apply','crop-x','crop-y','crop-width','crop-height'].map(ctrl);
      for(const height of [560,360]){
        host.style.height=height+'px';await wait(65);const bounds=host.getBoundingClientRect();
        const noSpill=nodes.every(n=>n.scrollWidth<=n.clientWidth+1),inside=nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=bounds.left-1&&r.right<=bounds.right+1;});
        const hitDetails=controls.map(n=>{if(!n)return {missing:true};n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),D=dialog.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {key:n.getAttributeNames().find(k=>k.startsWith('data-attachment-')),rect:[r.left,r.top,r.width,r.height],dialog:[D.left,D.top,D.width,D.height],hit:hit?.outerHTML.slice(0,120),ok:r.width>=16&&r.height>=16&&r.left>=D.left-1&&r.right<=D.right+1&&r.top>=D.top-1&&r.bottom<=D.bottom+1&&n.contains(hit)};});
        const reachable=hitDetails.every(d=>d.ok);
        check('375×'+height+'实际host下无横向溢出，裁切数字与保存取消可命中',bounds.width===375&&noSpill&&inside&&reachable,JSON.stringify({host:[bounds.width,bounds.height],noSpill,inside,reachable,sizes:nodes.map(n=>[n.clientWidth,n.scrollWidth]),dialog:[dialog.clientWidth,dialog.clientHeight],misses:hitDetails.filter(d=>!d.ok)}));
      }
      check('裁切存在非拖动键盘数值替代且工具button状态可访问',controls.slice(3).every(n=>n instanceof HTMLInputElement&&n.type==='number'&&!!(n.getAttribute('aria-label')||n.labels?.[0]?.textContent.trim()))&&tool('crop').getAttribute('aria-pressed')==='true');
      const openerBefore=lastOpener;await close('cancel');check('窄栏取消后回同一预览button，可继续键盘编辑输入',document.activeElement===openerBefore&&openerBefore.isConnected);host.style.width='1020px';host.style.height='780px';
    });
    await suite('超限源原生只读预览',async()=>{
      // SVG declares the real native dimensions while remaining tiny. Do not allocate a
      // giant test canvas or read tens of megapixels merely to verify a readonly branch.
      for(const [w,h,label]of [[4608,6144,'3:4·4K超24MP'],[8200,2,'超过8192边长']]){
        await clear();const svg='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="#1a9d6f"/></svg>');
        await attach('readonly-'+w+'x'+h+'.svg',svg);const before=snapshot(),u=uploads.length,g=sends.length;lastOpener=opener(0);lastOpener.focus({preventScroll:true});click(lastOpener);
        const image=await until(()=>ctrl('editor')?.getAttribute('data-attachment-readonly')==='1'&&q('[data-attachment-preview] img')?.naturalWidth&&q('[data-attachment-preview] img'),'超限native预览 '+label);
        await wait(35);const c=ctrl('canvas'),r=image.getBoundingClientRect(),stage=image.parentElement.getBoundingClientRect();
        const visible=image.checkVisibility()&&r.width>0&&r.height>0&&r.left>=stage.left-1&&r.right<=stage.right+1&&r.top>=stage.top-1&&r.bottom<=stage.bottom+1;
        check(label+'原生img实际natural尺寸可见contain，不分配超限canvas',image.naturalWidth===w&&image.naturalHeight===h&&visible&&getComputedStyle(image).objectFit==='contain'&&c.width<=300&&c.height<=150&&!c.checkVisibility(),JSON.stringify({natural:[image.naturalWidth,image.naturalHeight],canvas:[c.width,c.height],rect:[r.width,r.height],visible}));
        check(label+'只读说明可见，draw/crop/save/撤重禁用，查看不上传不生成',tool('draw').disabled&&tool('crop').disabled&&ctrl('save').disabled&&ctrl('undo').disabled&&ctrl('redo').disabled&&!!ctrl('error')?.textContent.trim()&&!ctrl('retry')&&uploads.length===u&&sends.length===g,ctrl('error')?.textContent);
        click(tool('draw'));click(tool('crop'));click(ctrl('save'));check(label+'禁用编辑不能改附件或误保存',ctrl('editor')?.getAttribute('data-attachment-readonly')==='1'&&equal(snapshot(),before)&&uploads.length===u&&sends.length===g);
        await close('cancel');check(label+'取消仍保留原附件并回焦，零附加upload/generate',equal(snapshot(),before)&&document.activeElement===lastOpener&&uploads.length===u&&sends.length===g);
      }
    });

    check('原图字节及本站图fixture始终未被改写',equal(pixels(source),originalPixels)&&equal(pixels(site),siteRGBA.data)&&urlData.get(uploads[0].url)===original);
    check('附件编辑没有聊天/图库/原图导出写入，全部生成只来自显式按钮',sends.length===manualRequests&&!otherWrites.some(p=>/^\/(chat\/|library|asset\/export|job\/delete|conversations\/delete)/.test(p.route)),JSON.stringify({uploads:uploads.length,manualClicks:manualRequests,generateRequests:sends.length,writes:otherWrites.map(p=>p.route)}));
  } finally {
    for(const r of held)r.release(false);hydrationReleases.splice(0).forEach(release=>release());
    window.fetch=originalFetch;window.confirm=originalConfirm;
    host.style.width='1020px';host.style.height='780px';
  }
}
