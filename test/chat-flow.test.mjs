// Browser scenario for tools/viewer-check.mjs --query audit=chatflow. No production writes.
export async function auditChatFlow({host, check, wait, flushSync, posts, remount}) {
  const el = sel => host.querySelector(sel);
  const area = () => el('.vig-composer textarea');
  const click = node => flushSync(() => node.click());
  const type = (node, value) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input',{bubbles:true}));
  });
  const tab = async id => { click(el('[data-conv="'+id+'"]')); await wait(60); };
  const until = async f => {for (let i=0; i<60; i++) {if (f()) return; await wait(35);} throw Error('chat condition timed out: '+f);};
  const key = (details) => flushSync(()=>area().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...details})));
  const orig=window.fetch, confirm=window.confirm;
  const wire=[]; let release,failNext=true;
  window.fetch=async(url,init)=>{
    if(String(url).endsWith('/generate')) {
      const body=JSON.parse(init.body);wire.push(body);
      if(failNext){failNext=false; await new Promise(resolve=>{release=resolve;});return new Response(JSON.stringify({ok:false,error:'测试：回执不可用'}),{status:503});}
    }
    return orig(url,init);
  };
  try {
    await until(()=>el('[data-conv="conv_default"]'));
    const originalText='A：蓝色背景\n第二行'; type(area(),originalText);
    click(el('.vig-side .vig-btn')); await until(()=>el('.vig-modal .vig-tile'));click(el('.vig-modal .vig-tile'));await until(()=>el('.vig-composer .vig-ref'));
    await tab('conv_old'); check('另一会话不会继承 A 的文字或参考图',area().value==='' && !el('.vig-composer .vig-ref'));
    type(area(),'B：这段不能被覆盖'); await tab('conv_default');
    check('A→B→A 恢复多行文字和参考图',area().value===originalText && !!el('.vig-composer .vig-ref'));
    await remount();await until(()=>el('[data-conv="conv_old"]'));check('重新挂载从标签页存储恢复文字和已上传参考图',area().value===originalText && !!el('.vig-composer .vig-ref img[src^="/api/"]'), JSON.stringify([area().value,el('.vig-composer .vig-ref img')?.getAttribute('src')?.slice(0,90),sessionStorage.getItem('dsh.velapi-image-go.draft.conv_default')]));
    const stored=sessionStorage.getItem('dsh.velapi-image-go.draft.conv_default');check('不把原图字节写入草稿存储',stored && !stored.includes('data:') && stored.includes('/upload/'),JSON.stringify([stored,posts.filter(x=>x.path==='/upload').length]));
    const edit=el('.vig-turn-acts button[title*="编辑"]');const previousCount=wire.length;
    window.confirm=()=>false;click(edit);check('编辑历史时取消保留草稿和参考图',area().value===originalText && !!el('.vig-ref'));
    window.confirm=()=>true;click(edit);await wait(80);check('确认历史编辑只填草稿，光标在末尾',area().value!==originalText && !!area().value && document.activeElement===area() && area().selectionEnd===area().value.length && wire.length===previousCount);
    // Restore the known reference after editing a historical text-only turn.
    if (!el('.vig-composer .vig-ref')) {click(el('.vig-side .vig-btn'));await until(()=>el('.vig-modal .vig-tile'));click(el('.vig-modal .vig-tile'));await until(()=>el('.vig-composer .vig-ref'));}
    type(area(),'猫');key({isComposing:true});key({keyCode:229});key({repeat:true});key({shiftKey:true});key({altKey:true});await wait(60);
    check('选词确认、按住回车和换行均不触发生图',wire.length===0&&area().value==='猫');
    key({});await until(()=>release);type(area(),'A：发送后的新文字');await tab('conv_old');release();await wait(140);
    check('A 提交失败不打扰 B，也不自动重发',area().value==='B：这段不能被覆盖' && !el('[data-recover-prompt]') && wire.length===1);
    await tab('conv_default');await until(()=>el('[data-recover-prompt]'));
    check('返回 A 后仍可取回原话，当前草稿保持原样',area().value==='A：发送后的新文字');
    window.confirm=()=>false;click(el('[data-recover-prompt]'));check('取消取回不覆盖下一条，也不丢失败提示',area().value==='A：发送后的新文字'&&!!el('[data-recover-prompt]'));
    window.confirm=()=>true;click(el('[data-recover-prompt]'));check('取回只填词并归还焦点，不自动生成',area().value==='猫'&&document.activeElement===area()&&wire.length===1);
    click(el('.vig-send'));await until(()=>wire.length===2);check('再次明确发送才生成，且仍在 A 会话',wire[0].prompt==='猫'&&wire[1].prompt==='猫'&&wire[1].conversationId==='conv_default'&&wire[1].referenceUrls.length===1&&!posts.some(p=>p.path.startsWith('/chat/')),JSON.stringify([wire[1].conversationId,wire[1].referenceUrls]));
    await tab('conv_old'); check('成功发送也不会清空其他会话草稿',area().value==='B：这段不能被覆盖');
    host.style.width='320px';await wait(180);
    const b=el('.vig-send').getBoundingClientRect(),h=host.getBoundingClientRect();check('320px 面板只有一个生成入口且未越界',host.querySelectorAll('.vig-send,[data-force-generate]').length===1 && b.width>=24 && b.left>=h.left-1 && b.right<=h.right+1);
  } finally {release?.();window.fetch=orig;window.confirm=confirm;}
}
