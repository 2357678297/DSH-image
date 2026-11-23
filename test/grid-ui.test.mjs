// node tools/viewer-check.mjs --query audit=grid (localhost fixture, real Chrome/React; no live relay).
// This function is serialized into the fixture page: keep all helpers local.
export async function auditGridUI({host, check, wait, flushSync, posts}) {
  const W = 360, H = 144, cols = 3, rows = 2, target = 4;
  const cw = W / cols, ch = H / rows, x0 = target % cols * cw, y0 = Math.floor(target / cols) * ch;
  const resultUrl = '/api/velapi-image-go/asset/grid-qa-candidate.png';
  const q = (sel) => host.querySelector(sel), ctrl = key => q('[data-grid-'+key+']');
  const until = async (predicate, label, timeout=5000) => {
    const end=Date.now()+timeout;
    while(Date.now()<end) { const value=predicate(); if(value) return value; await wait(30); }
    throw Error('宫格测试超时：'+label);
  };
  const click = node => { if(!node) throw Error('缺少宫格控件'); flushSync(()=>node.click()); };
  const setValue = (node,value) => flushSync(()=>{
    if(!node) throw Error('找不到要修改的宫格控件');
    const proto = node.tagName==='SELECT' ? HTMLSelectElement.prototype : node.tagName==='INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(node,String(value));
    node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));
  });
  const canvas = (w,h) => {const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  const samples = c => new Uint32Array(c.getContext('2d').getImageData(0,0,c.width,c.height).data.buffer);
  const toBlob = c => new Promise((ok,fail)=>c.toBlob(b=>b?ok(b):fail(Error('PNG 编码失败')),'image/png'));
  const orig=canvas(W,H), g=orig.getContext('2d'), rgb=g.createImageData(W,H);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
    const i=4*(y*W+x);rgb.data[i]=x%251;rgb.data[i+1]=y;rgb.data[i+2]=(x+3*y)%251;rgb.data[i+3]=255;
  }
  g.putImageData(rgb,0,0);
  const replacement=canvas(96,160), paint=replacement.getContext('2d');paint.fillStyle='#fe11b4';paint.fillRect(0,0,96,160);
  const [sourceBlob,candidateBlob]=await Promise.all([toBlob(orig),toBlob(replacement)]);
  const before=samples(orig), pink=samples(replacement)[0];
  const isWorkingSheet = (c, applied=false) => {
    if(!c || c.width!==W || c.height!==H) return false;
    return samples(c).every((v,i)=>v===(applied && i%W>=x0 && i%W<x0+cw && Math.floor(i/W)>=y0 && Math.floor(i/W)<y0+ch ? pink : before[i]));
  };
  const decode = async (url) => {const img=new Image();img.src=url; await img.decode();const c=canvas(img.naturalWidth,img.naturalHeight);c.getContext('2d').drawImage(img,0,0);return c;};
  const origFetch=window.fetch, origConfirm=window.confirm;
  const origCreate=URL.createObjectURL, origRevoke=URL.revokeObjectURL, origClick=HTMLAnchorElement.prototype.click;
  const objects=new Map(), downloads=[], calls=[], polls=[], writes=[];
  let delayPoll=false, release=null, sourceRead=0, candidateRead=0, failNext=false;
  const uploads=[], refUrls=[];
  const resp = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const png = b=>new Response(b,{headers:{'content-type':'image/png'}});
  const getDownload = async (control,ext) => {
    const n=downloads.length;click(ctrl(control));await until(()=>downloads[n],'生成独立 '+ext+' 下载');
    const d=downloads[n]; if(!d.blob || !d.name.toLowerCase().endsWith('.'+ext)) throw Error('下载不是 '+ext+' 文件：'+d.name);
    return d;
  };
  const decodedFile = async (d) => {
    if(d.blob.type!=='image/png') throw Error('下载 MIME 不是 image/png');
    const url=origCreate.call(URL,d.blob);try{return await decode(url);}finally{origRevoke.call(URL,url);}
  };
  let opener;
  const open = async () => {opener=await until(()=>q('.vig-shot [data-grid-open]'),'结果卡编辑入口');opener.focus({preventScroll:true});click(opener);await until(()=>ctrl('editor') && ctrl('canvas')?.width===W && ctrl('canvas')?.height===H,'按原图实际尺寸载入');};
  try {
    window.confirm=()=>true;
    // Capture the actual Blob before download URLs are revoked; never write to the user's downloads directory.
    URL.createObjectURL=function(blob){const url=origCreate.call(URL,blob);objects.set(url,blob);return url;};
    URL.revokeObjectURL=function(url){objects.delete(url);return origRevoke.call(URL,url);};
    HTMLAnchorElement.prototype.click=function(){if(this.download){downloads.push({name:this.download,blob:objects.get(this.href)});return;}return origClick.call(this);};
    window.fetch=async(input,init={})=>{
      const raw=typeof input==='string'?input:input.url||String(input), u=new URL(raw,location.href), route=u.pathname.replace(/^.*?\/api\/velapi-image-go/,'');
      if(u.pathname===resultUrl){candidateRead++;return png(candidateBlob);}
      if(/^data:image\/svg/i.test(raw) || route.startsWith('/asset/') && !init.body){sourceRead++;return png(sourceBlob);}
      if(route==='/upload' && init.method==='POST') {
        const body=JSON.parse(init.body);uploads.push(body);const url='/api/velapi-image-go/upload/grid-qa-'+uploads.length+'.png';refUrls.push(url);
        return resp({ok:true,item:{url,name:body.name}});
      }
      if(route==='/generate'){
        const body=JSON.parse(init.body);calls.push(body);const id='grid_qa_job_'+calls.length;
        if(failNext){failNext=false;return resp({ok:false,error:'fixture：服务暂时不可用'},503);}
        return resp({ok:true,queue:1,job:{id,conversationId:'conv_default',status:'queued',images:[]}});
      }
      const id=u.searchParams.get('id');
      if(route==='/job' && id?.startsWith('grid_qa_job_')) {
        polls.push(id);
        if(delayPoll){await new Promise(resolve=>{release=resolve;});}
        return resp({ok:true,job:{id,conversationId:'conv_default',status:'succeeded',images:[{id:'grid_qa_output',assetId:'grid_qa_output',name:'candidate.png',url:resultUrl,width:96,height:160}]}});
      }
      if((init.method||'GET').toUpperCase()!=='GET') writes.push(route);
      return origFetch(input,init); // original is already viewer-check's local mock, not network fetch.
    };
    await open();
    check('宫格从结果卡打开，使用解码像素而不是任务元数据',sourceRead>0 && isWorkingSheet(ctrl('canvas')) && !ctrl('candidate'));
    setValue(ctrl('rows'),rows);setValue(ctrl('cols'),cols);await until(()=>host.querySelectorAll('[data-grid-cell]').length===6,'2 行 3 列');
    click(q('[data-grid-cell="4"]'));setValue(ctrl('prompt'),'把第二行中间一格改成洋红色');
    const generate=ctrl('generate');flushSync(()=>{generate.click();generate.click();});
    await until(()=>ctrl('candidate')?.naturalWidth,'候选实际解码完成',6500);
    const body=calls[0];
    const preview=await until(()=>q('.vig-grid-stage img')?.naturalWidth && q('.vig-grid-stage img'),'候选覆盖层解码'), overlay=preview.getBoundingClientRect(), cellBox=q('[data-grid-cell="4"]').getBoundingClientRect();
    check('候选只在所选格原位预览，像素画布尚未变化', ['left','top','right','bottom'].every(k=>Math.abs(overlay[k]-cellBox[k])<1) && isWorkingSheet(ctrl('canvas')));

    check('快速双击只提交一次，轮询并显示候选后不自动覆盖',calls.length===1 && polls.includes('grid_qa_job_1') && candidateRead>0 && isWorkingSheet(ctrl('canvas')));
    check('局部重绘保留提示词和当前生图设置，发送单格且不重复图字节',body?.prompt==='把第二行中间一格改成洋红色' && body.model==='gpt-image-2.5-c' && body.providerId==='pv_gpt' && body.conversationId==='conv_default' && body.quality==='LOW' && body.n===1 && body.endpoint==='images_edits' && body.mode==='edit' && !body.images?.length && !body.image && body.referenceUrl===refUrls[0] && body.referenceUrls?.length===1 && body.referenceUrls[0]===refUrls[0] && uploads.length===1 && /^data:image\/png;base64,/.test(uploads[0]?.data),JSON.stringify({model:body?.model,mode:body?.mode,n:body?.n,endpoint:body?.endpoint}));
    const cut=await decode(uploads[0].data);
    check('提交的 PNG 就是所选格：原生尺寸和所有像素都匹配',cut.width===cw && cut.height===ch && samples(cut).every((v,i)=>v===before[(y0+Math.floor(i/cw))*W+x0+i%cw]));
    check('候选尚未处理时不能切格/重分布局',ctrl('rows').disabled && ctrl('cols').disabled && q('[data-grid-cell="0"]').disabled);
    click(ctrl('apply'));await until(()=>!ctrl('candidate'),'应用候选并退出预览');
    check('填回只修改目标矩形，整张工作稿其它像素逐点不变',isWorkingSheet(ctrl('canvas'),true));
    window.confirm=()=>false;click(ctrl('close'));check('取消关闭会保留工作稿',!!ctrl('editor') && isWorkingSheet(ctrl('canvas'),true));
    window.confirm=()=>true;
    const cell=await getDownload('export-cell','png'), cellPng=await decodedFile(cell);
    check('导出的单格是已填回的真 PNG，而非完整原图',cellPng.width===cw && cellPng.height===ch && samples(cellPng).every(v=>v===pink));
    const sheet=await getDownload('export-sheet','png'), sheetPng=await decodedFile(sheet);
    check('合成整图导出为不同文件，源尺寸与非目标内容均保留',sheet.name!==cell.name && !['cat.png','dog.png'].includes(sheet.name) && isWorkingSheet(sheetPng,true));
    // Repartition after patching, then reconstruct the current sheet using only PNGs inside the ZIP.
    setValue(ctrl('rows'),5);setValue(ctrl('cols'),4);
    await until(()=>host.querySelectorAll('[data-grid-cell]').length===20,'改为 5 行 4 列');
    check('调整行列不清工作稿，重新选择第一格',isWorkingSheet(ctrl('canvas'),true) && q('[data-grid-cell="0"]').getAttribute('aria-pressed')==='true');
    const zip=await getDownload('export-all','zip'), bytes=await zip.blob.arrayBuffer(), dv=new DataView(bytes);
    const end=bytes.byteLength-22, count=dv.getUint16(end+10,true);let dir=dv.getUint32(end+16,true), valid=count===20 && dv.getUint32(end,true)===0x06054b50, total=0;
    const seen=new Set(), stitched=canvas(W,H), ctx=stitched.getContext('2d');
    const crc32=buf=>{let v=-1;for(const n of buf){v^=n;for(let i=0;i<8;i++) v=(v>>>1)^((v&1)?0xedb88320:0);}return ~v>>>0;};
    for(let n=0; n<count && valid; n++) {
      if(dv.getUint32(dir,true)!==0x02014b50){valid=false;break;}
      const size=dv.getUint32(dir+20,true), nl=dv.getUint16(dir+28,true), at=dv.getUint32(dir+42,true), checksum=dv.getUint32(dir+16,true);
      const name=new TextDecoder().decode(new Uint8Array(bytes,dir+46,nl)), parts=/^r(\d+)-c(\d+)\.png$/.exec(name);
      if(!parts||seen.has(name)||dv.getUint32(at,true)!==0x04034b50||dv.getUint16(at+8,true)!==0){valid=false;break;}
      const r=Number(parts[1])-1,c=Number(parts[2])-1;
      const left=Math.round(c*W/4),right=Math.round((c+1)*W/4),top=Math.round(r*H/5),bottom=Math.round((r+1)*H/5);
      const pos=at+30+dv.getUint16(at+26,true)+dv.getUint16(at+28,true), data=new Uint8Array(bytes,pos,size);
      const img=await decodedFile({blob:new Blob([data],{type:'image/png'})});
      valid &&= r>=0 && r<5 && c>=0 && c<4 && img.width===right-left && img.height===bottom-top && crc32(data)===checksum;
      seen.add(name);ctx.drawImage(img,left,top);total+=img.width*img.height;
      dir+=46+nl+dv.getUint16(dir+30,true)+dv.getUint16(dir+32,true);
    }
    check('实际 ZIP 包的20个 PNG 均可解码，坐标、CRC、余数尺寸正确；拼回覆盖全部像素',valid && dir===end && total===W*H && isWorkingSheet(stitched,true),JSON.stringify({count,files:seen.size,covered:total,expected:W*H}));
    setValue(ctrl('mode'),'generate');setValue(ctrl('prompt'),'重新生成一格紫色海报');click(ctrl('generate'));
    await until(()=>ctrl('candidate')?.naturalWidth,'纯文生图返回候选',6500);
    const text=calls[1];check('纯文生图不上传且不带参考图，仅预览待确认',uploads.length===1 && text?.n===1 && text.prompt==='重新生成一格紫色海报' && text.mode==='generate' && text.endpoint!=='images_edits' && !text.image && !text.images?.length && !text.referenceUrls?.length);
    click(ctrl('discard'));check('弃用只清掉候选，不还原已填回的像素',!ctrl('candidate') && isWorkingSheet(ctrl('canvas'),true));
    window.confirm=()=>true;click(ctrl('close'));await until(()=>!ctrl('editor'),'关闭工作稿');
    const focusReturned=document.activeElement===opener;
    // A 320×360 embedded right pane. The modal must remain inside its panel and the scrollable form must expose its footer.
    host.style.width='320px';host.style.height='360px';await wait(100);await open();
    const editor=ctrl('editor'), panel=editor.closest('dialog'), bounds=host.getBoundingClientRect(), box=panel.getBoundingClientRect();
    const focusEntered=editor.contains(document.activeElement); const reach=node=>{node.scrollIntoView({block:'nearest',inline:'nearest'});const rect=node.getBoundingClientRect();return rect.width>15 && rect.height>15 && rect.left>=box.left-1 && rect.right<=box.right+1 && rect.top>=box.top-1 && rect.bottom<=box.bottom+1 && node.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));};
    const canReachRows=reach(ctrl('rows'));const canReachPrompt=reach(ctrl('prompt')); const canReachClose=reach(ctrl('close')); const canReachGenerate=reach(ctrl('generate'));
    check('320×360 窄面板：模态焦点进入/归还，首尾控件能通过滚动完整到达',panel.matches(':modal') && box.width<=bounds.width+1 && box.height<=bounds.height+1 && focusEntered && focusReturned && canReachRows && canReachPrompt && canReachClose && canReachGenerate,JSON.stringify({focusEntered,focusReturned,canReachRows,canReachPrompt,canReachClose,canReachGenerate,box:box.toJSON(),host:bounds.toJSON()}));
    setValue(ctrl('mode'),'generate');setValue(ctrl('prompt'),'保留失败以后重试这段文字');failNext=true;click(ctrl('generate'));await until(()=>editor.querySelector('[role=alert]') && !ctrl('generate').disabled,'提交失败后解锁');
    check('提交失败有错误反馈：原图与提示词不变，仍可重试',editor.querySelector('[role=alert]').textContent.includes('服务暂时不可用') && isWorkingSheet(ctrl('canvas')) && ctrl('prompt').value==='保留失败以后重试这段文字' && !ctrl('candidate'));
    click(ctrl('generate'));await until(()=>ctrl('candidate')?.naturalWidth,'失败后手动重试返回候选',6500);check('重试仅产生一个新任务，必须再确认才填回',calls.length===4 && isWorkingSheet(ctrl('canvas')) && !!ctrl('apply'));click(ctrl('discard'));
    check('重新打开仍是原图，之前的工作稿没有覆盖原件',isWorkingSheet(ctrl('canvas')));
    setValue(ctrl('prompt'),'关闭后不接受这个迟回候选');delayPoll=true;click(ctrl('generate'));await until(()=>release,'有一个轮询正等待返回',6500);
    check('轮询期间布局和目标已锁定，生成按钮阻止重复请求',ctrl('generate').disabled && ctrl('rows').disabled && ctrl('cols').disabled);
    click(ctrl('close'));await until(()=>!ctrl('editor'),'关闭等待中的编辑器');await open();
    delayPoll=false;release();release=null;await wait(180);
    check('旧弹窗迟回结果不进入重开的编辑器，无下载外的隐式写入',!ctrl('candidate') && isWorkingSheet(ctrl('canvas')) && !writes.some(path=>/library\/(import|delete|rename)|asset\/export/.test(path)) && !posts.some(p=>p.path==='/library/import'));
    click(ctrl('close'));
  } catch (error) {
    check('宫格端到端场景执行完毕',false, String(error.stack || error)+'; editor='+(ctrl('editor')?.textContent || 'closed').slice(-420));
  } finally {
    delayPoll=false;release?.();window.fetch=origFetch;window.confirm=origConfirm;
    URL.createObjectURL=origCreate;URL.revokeObjectURL=origRevoke;HTMLAnchorElement.prototype.click=origClick;
  }
}

// Chrome --dump-dom plus virtual time can race native PNG encoders and image.decode(). For this
// suite alone, let that same compiled fixture run on wall clock and report its existing result node.
export async function runGridPage(pagePath, chrome, query) {
  const [{createServer},{spawn},fs,os,path,{randomUUID}] = await Promise.all([
    import('node:http'),import('node:child_process'),import('node:fs/promises'),import('node:os'),import('node:path'),import('node:crypto')
  ]);
  const reportRoute='/result/'+randomUUID(), original=await fs.readFile(pagePath,'utf8');
  const capture = `<script>(()=>{const send=window.fetch.bind(window);let done=false;const report=payload=>{if(done)return;done=true;void send(${JSON.stringify(reportRoute)},{method:'POST',body:payload});};const observe=()=>{const pre=document.getElementById('vig-viewer-out');if(pre?.textContent)report(pre.textContent);};new MutationObserver(observe).observe(document,{childList:true,subtree:true});setTimeout(()=>report(JSON.stringify({results:[{name:'宫格浏览器驱动超时',pass:false,detail:document.querySelector('[data-grid-editor]')?.textContent||'未打开宫格窗口'}],debug:[]})),40000);})();</script>`;
  const html=original.replace('<head>','<head>'+capture);
  if(html===original) throw Error('宫格测试页缺少 head');
  let finish,fail;const result=new Promise((r,j)=>{finish=r;fail=j;});
  const server=createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://127.0.0.1');
      if(u.pathname===reportRoute && req.method==='POST'){
        let text='';for await(const part of req){text+=part;if(text.length>1024*1024)throw Error('结果节点过长');}
        const payload=JSON.parse(text);if(!Array.isArray(payload.results))throw Error('结果节点不是测试结果');
        res.writeHead(200);res.end('ok');finish('<pre id="vig-viewer-out">'+text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</pre>');
      } else if(u.pathname==='/viewer.html' && req.method==='GET'){res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(html);}
      else{res.writeHead(404);res.end();}
    } catch(error){res.destroy();fail(error);}
  });
  const tmp=path.resolve(os.tmpdir()), profile=await fs.mkdtemp(path.join(tmp,'vig-grid-qa-'));
  let child,exited,timer;
  try {
    await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
    child=spawn(chrome,['--headless=new','--no-first-run','--disable-gpu','--disable-sync','--disable-background-networking','--window-size=1440,1000','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/viewer.html?${query}`],{stdio:'ignore',windowsHide:true});
    exited=new Promise(r=>{child.once('error',e=>{fail(e);r();});child.once('exit',code=>{fail(Error('Chrome 提前退出 '+code));r();});});
    timer=setTimeout(()=>fail(Error('Chrome 宫格场景 50 秒内没有回传结果')),50000);
    return await result;
  } finally {
    clearTimeout(timer);if(child){child.kill();await exited;}
    if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}
    if(path.dirname(profile)===tmp && path.basename(profile).startsWith('vig-grid-qa-'))await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  }
}
