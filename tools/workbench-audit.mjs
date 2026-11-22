// In-browser acceptance suite. All requests go to the viewer-check fixture.
export async function auditWorkbench({ host, check, wait, flushSync, posts }) {
  const q = (sel, parent = host) => parent.querySelector(sel);
  const all = (sel, parent = host) => Array.from(parent.querySelectorAll(sel));
  const click = (el) => { if (!el) throw new Error('missing control'); flushSync(() => el.click()); };
  const fill = (el, val) => flushSync(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, val); el.dispatchEvent(new Event('input', {bubbles:true})); });
  const btn = (label, parent = host) => all('button', parent).find(b => b.textContent.trim() === label || b.title === label);
  const nav = async (name) => { click(all('.vig-nav-item').find(n=>n.textContent.includes(name))); await wait(75); };
  const key = (el, k) => { const e = new KeyboardEvent('keydown', {key:k,cancelable:true,bubbles:true}); flushSync(()=>el.dispatchEvent(e)); return e; };
  const bound = (el, ref=host) => { if(!el) return false; const r=el.getBoundingClientRect(), b=ref.getBoundingClientRect(); return r.width>1 && r.left>=b.left-1 && r.right<=b.right+1; };
  const close = () => { const d=q('.vig-modal-mask'); if(d) click(d.querySelector('.vig-icon-btn') || btn('关闭',d)); };
  const run = async (name, f) => { try {await f();}catch(e){check(name,false,e.message); close();} };
  const preset = {id:'pre_one',title:'样张',prompt:'蓝色产品',image:'',tags:[]};
  const original = window.fetch;
  let failProvider=true, releaseTest;
  const writes=[];
  window.fetch = async (url, init) => {
    const route=String(url).split('/api/velapi-image-go').pop();
    if(route==='/providers/test'){await new Promise(resolve=>{releaseTest=resolve;});return new Response(JSON.stringify({ok:true,models:['audit-model'],elapsedMs:1}));}
    if (init?.method==='POST' && (route==='/providers'||route==='/notes'||route==='/presets')) {
      const body=JSON.parse(init.body);writes.push({route,body});await wait(110);
      if(route==='/providers'&&failProvider) return new Response(JSON.stringify({ok:false,error:'测试：保存失败'}),{status:503});
      return new Response(JSON.stringify({ok:true,items:[{...body,id:body.id||'new'}]}));
    }
    if(route==='/presets')return new Response(JSON.stringify({ok:true,items:[preset]}));
    return original(url,init);
  };
  const setSize=async(w,h)=>{host.style.width=w+'px';host.style.height=h+'px';await wait(100);};
  await run('页面布局矩阵',async()=>{
    for(const name of ['对话生图','图片管理','信息管理','供应商管理','图片处理']) {
      await nav(name);
      for(const [w,h] of [[320,360],[660,420],[1024,720],[375,520]]) {
        await setSize(w,h);const panel=q('.vig-main'), toolbar=panel?.querySelector('.vig-toolbar,.vig-main-head');
        const bad=toolbar ? all('button',toolbar).filter(b=>b.getBoundingClientRect().width&&!bound(b,panel)) : [];
        check(`${name} ${w}×${h} 主区与工具按钮不越界`,bound(panel)&&!bad.length, bad.length ? JSON.stringify({compact:q('.vig-root').dataset.compact,panel:panel.clientWidth,outer:q('.vig-root').clientWidth,buttons:bad.map(b=>[b.title,Math.round(b.getBoundingClientRect().right)])}) : '');
      }
    }
  });
  await run('供应商表单',async()=>{
    await nav('供应商管理'); click(q('.vig-prov-acts button[title="编辑"]') || btn('编辑',q('.vig-prov')));
    click(q('[data-provider-test]'));await wait(35);close();click(btn('编辑',all('.vig-prov')[1]));releaseTest();await wait(100);
    check('关闭 A 供应商测试、打开 B：迟回结果不会写到 B 草稿', !q('.vig-prov-test') && q('[data-provider-editor] input')?.value===all('.vig-prov-name')[1]?.firstChild?.textContent);
    close();click(btn('编辑',q('.vig-prov')));
    const d=q('.vig-modal'); check('供应商弹窗按宿主宽度，而不是桌面视口',bound(d));
    const reach = (el) => { el.scrollIntoView({block:'nearest',inline:'nearest'}); const b=el.getBoundingClientRect(); const hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2); return hit === el || el.contains(hit); };
    for (const h of [620,300]) { await setSize(375,h); await wait(140); const button=q('[data-provider-save]',d); check('375×'+h+' 弹窗不超过宿主，滚动后保存按钮实际可点击', d.clientHeight<=h && reach(button), JSON.stringify([d.clientHeight,h,button?.getBoundingClientRect().bottom])); }
    const values=all('label input',d); const models=q('[data-provider-models]',d); fill(models,'test-a,'); check('模型列表保留正在输入的分隔符',models.value.endsWith(','));fill(models,'test-a， test-b, test-a');
    const pass=values.find(el=>el.type==='password');fill(pass,'discard-me');fill(pass,'');
    const save=btn('保存',d); click(save);click(save);await wait(280);
    check('失败保留供应商草稿且连点只提交一次',q('.vig-modal')===d && writes.filter(e=>e.route==='/providers').length===1);
    if(q('.vig-modal')){failProvider=false;click(save);await wait(240);}
    const payload=writes.filter(e=>e.route==='/providers').at(-1)?.body;
    check('供应商字段提交时去重，清空未保存密钥不切换凭据',payload?.models?.join(',')==='test-a,test-b' && payload.useRuntimeKey!==true);
    close();
  });
  await run('信息卡编辑',async()=>{
    await nav('信息管理');const open=q('.vig-toolbar button');open.focus();click(open);const d=q('.vig-modal');
    const inputs=all('input',d);fill(inputs[0],'审计样例');fill(inputs.at(-1),'甲,');check('信息卡标签可逐字输入多个值',inputs.at(-1).value.endsWith(','));fill(inputs.at(-1),'甲，乙,甲');
    const save=btn('保存',d);click(save);click(save);await wait(250);
    const notes=writes.filter(e=>e.route==='/notes');check('信息卡只保存一次并正确提交两项标签',notes.length===1 && notes[0].body.tags.join(',')==='甲,乙');
    open.focus();click(open);const dialog=q('.vig-modal-mask');key(dialog,'Escape');await wait(60);check('Escape 关闭编辑并归还焦点',!q('.vig-modal-mask')&&document.activeElement===open);close();
  });
  await run('图库操作边界',async()=>{
    await nav('图片管理');click(q('.vig-tile-meta'));const search=q('.vig-toolbar input');fill(search,'dog.png');await wait(50);
    check('过滤掉已选图后，不会批量删除隐藏图片',!q('.vig-toolbar .is-danger'));fill(search,'');
    click(all('.vig-viewmode-btn')[1]);await wait(100);const before=q('.vig-strip-item.is-on')?.title;
    search.focus();const e=key(search,'ArrowRight');await wait(80);check('搜索框左右键编辑文字，不在后台切图',!e.defaultPrevented && q('.vig-strip-item.is-on')?.title===before);
    const brush=q('.vig-stage-acts [title*="画笔"]');click(brush);const prompt=q('.vig-mask-input');fill(prompt,'指令仅属于 A');key(prompt,'Enter');await wait(150);check('没有选区，Enter 不提交局部改图',!posts.some(p=>p.path==='/generate' && p.body.mask));
    const stage=q('.vig-stage-main');stage.focus();key(stage,'ArrowRight');await wait(100);
    check('切图不携带旧图的蒙版指令',q('.vig-strip-item.is-on')?.title!==before && (!q('.vig-mask-input') || q('.vig-mask-input').value===''));
    check('窄栏大图工具和输入控件均在主区内',all('.vig-stage-bar button,.vig-mask-pill button,.vig-mask-input').every(el=>bound(el,q('.vig-main'))));
  });
  await run('检查器与选图',async()=>{
    await nav('对话生图');click(q('.vig-side-head button'));click(q('[data-tools-toggle]'));click(q('.vig-tools-pop [title="从图库选择"]'));await wait(100);
    check('收起检查器，输入区仍能独立打开图库选择器',!!q('.vig-modal .vig-tile'));
    if(q('.vig-modal .vig-tile')){click(q('.vig-modal .vig-tile'));await wait(160);check('选图后只附加一张参考图且保持检查器收起',!!q('.vig-side.is-collapsed')&&all('.vig-composer .vig-ref').length===1);}
    close();click(q('.vig-side-open'));
    for(let i=0;i<4;i++){click(btn('从图库选择',q('.vig-side')));click(q('.vig-modal .vig-tile'));await wait(130);}
    check('第五张参考图不会加入或发起上传，超限提示在当前弹窗可见',all('.vig-composer .vig-ref').length===4 && !!q('.vig-modal-mask .vig-toast.is-err') && posts.filter(p=>p.path==='/upload').length===4);close();
    click(btn('新建预设')||q('.vig-side .vig-btn.is-primary'));const d=q('.vig-modal');check('预设编辑器按实际宿主宽度伸缩',bound(d));close();
  });
  window.fetch=original;
}
