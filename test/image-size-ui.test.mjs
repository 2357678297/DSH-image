// node tools/viewer-check.mjs --query audit=imagesize
// Serialized into the existing real Chrome/React fixture. No live provider or user session.
export async function auditImageSizeUI({host,check,wait,waitFor,flushSync,posts}) {
  const get=s=>host.querySelector(s), all=s=>Array.from(host.querySelectorAll(s));
  const need=(node,label)=>{if(!node)throw Error('缺少控件：'+label);return node;};
  const click=node=>flushSync(()=>need(node,'click').click());
  const set=(node,value)=>flushSync(()=>{
    need(node,'value');
    const proto=node.tagName==='SELECT' ? HTMLSelectElement.prototype : node.tagName==='INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(node,String(value));
    node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));
  });
  const until=async(predicate,label)=>{const hit=await waitFor(predicate,2000);if(!hit)throw Error('等待超时：'+label);return hit;};
  const imageSize=()=>get('select[data-image-size="1"]'), endpoint=()=>get('select.vig-endpoint');
  const composer=()=>get('.vig-composer textarea.vig-input'), sends=()=>posts.filter(p=>p.path==='/generate');
  const noRatio=body=>body && !Object.hasOwn(body,'aspect_ratio') && !Object.hasOwn(body,'aspectRatio');
  const isAuto=body=>body?.size==='auto' && noRatio(body);
  const bodyDetail=body=>JSON.stringify({size:body?.size,ratio:body?.aspect_ratio,camel:body?.aspectRatio,endpoint:body?.endpoint,mode:body?.mode,provider:body?.providerId,n:body?.n,refs:body?.referenceUrls});
  const menu=()=>Array.from(need(imageSize(),'普通图片尺寸').options);
  const tools=()=>{const button=need(get('[data-tools-toggle]'),'参数展开');if(button.getAttribute('aria-expanded')!=='true')click(button);};
  const pickSize=async(value)=>{set(imageSize(),value);await until(()=>imageSize()?.value===value,'尺寸 '+value);await wait(25);};
  const pickEndpoint=async(value)=>{set(endpoint(),value);await until(()=>endpoint()?.value===value,'协议 '+value);await wait(50);tools();};
  const openJson=async()=>{click(get('[data-json-body]'));return until(()=>get('[data-json-editor]'),'JSON 编辑器');};
  const parseJson=()=>JSON.parse(need(get('[data-json-editor]'),'JSON 编辑器').value);
  const applyJson=async()=>{click(get('[data-json-apply]'));await until(()=>!get('[data-json-editor]'),'应用 JSON');};
  const closeJson=()=>click(all('.vig-json-modal button').find(n=>n.textContent==='关闭'));
  const submit=async(prompt)=>{
    if(prompt!=null)set(composer(),prompt);
    const n=sends().length;click(get('[data-force-generate]'));
    await until(()=>sends().length===n+1,'单次生成请求');await wait(20);
    return sends()[n].body;
  };
  const history=(prompt,label)=>{
    const author=all('article.is-user').find(n=>n.textContent.includes(prompt));
    return need(author?.nextElementSibling?.querySelector('button[aria-label="'+label+'"]'),prompt+' / '+label);
  };
  const retry=async(prompt)=>{const n=sends().length;click(history(prompt,'重试'));await until(()=>sends().length===n+1,'历史重试');return sends()[n].body;};
  const chooseModel=async(id)=>{
    const picker=need(get('.vig-tools-pop .vig-picker'),'模型选择');click(picker.querySelector('.vig-pick'));
    click(Array.from(picker.querySelectorAll('.vig-pop-item')).find(n=>n.querySelector('.vig-pop-item-text')?.textContent===id));
    await until(()=>get('.vig-tools-pop .vig-pick-text')?.textContent===id,'模型 '+id);await wait(40);
  };
  const assertNarrow=async(label)=>{
    const previousDraft=composer().value, layoutDraft=!previousDraft.trim();
    if(layoutDraft)set(composer(),'imagesize narrow layout draft');
    tools();await wait(100);
    const root=get('.vig-root'), main=get('.vig-main'), pop=get('.vig-tools-pop'), compose=get('.vig-composer');
    const bounds=host.getBoundingClientRect(), controls=[imageSize(),get('[data-tools-toggle]'),get('[data-force-generate]')].filter(Boolean);
    const rects=controls.map(n=>n.getBoundingClientRect());
    const noSpill=[root,main,pop,compose].every(n=>n && n.scrollWidth<=n.clientWidth+1);
    const inside=rects.every(r=>r.width>0&&r.height>0&&r.left>=bounds.left-1&&r.right<=bounds.right+1);
    const actionable=controls.every(n=>{const r=n.getBoundingClientRect();return !n.disabled&&n.checkVisibility()&&n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});
    check('375px '+label+'：参数和发送按钮可见可命中，无横向溢出',noSpill&&inside&&actionable,JSON.stringify({host:bounds.width,noSpill,inside,actionable,widths:[root,main,pop,compose].map(n=>n&&[n.clientWidth,n.scrollWidth]),rects:rects.map(r=>[r.left,r.right,r.width,r.height])}));
    if(layoutDraft)set(composer(),previousDraft);
  };
  const originalConfirm=window.confirm;
  try {
    window.confirm=()=>true;
    host.style.width='375px';host.style.height='780px';tools();await wait(120);
    const options=menu(), auto=options.filter(o=>o.value==='auto');
    check('普通图片固定初值也始终提供唯一自动选项，文案说明不指定尺寸/比例',imageSize().value==='1024x1024'&&options[0]?.value==='auto'&&auto.length===1&&auto[0].text==='自动'&&/不指定/.test(auto[0].title),JSON.stringify(options.slice(0,3).map(o=>[o.value,o.text,o.title])));
    const triples=[['1K','1152x1536','1152×1536'],['2K','2304x3072','2304×3072'],['4K','4608x6144','4608×6144']];
    for(const [tier,size,pixels] of triples){
      const option=options.find(o=>o.value===size);
      check('3:4 '+tier+' 菜单显示准确像素',option?.text==='3:4 · '+tier+' · '+pixels&&option.title===option.text,option?.text);
      await pickSize(size);const configPost=posts.filter(p=>p.path==='/config'&&p.body.defaultSize===size).at(-1);
      check('3:4 '+tier+' 真选择写回配置且选项仍含自动',configPost?.body.defaultSize===size&&menu().filter(o=>o.value==='auto').length===1,imageSize().value);
    }
    await assertNarrow('3:4 4K');

    // A JSON fixed size/ratio override must not defeat the next native menu selection.
    await pickSize('1024x1024');set(composer(),'imagesize JSON snake override');
    let editor=await openJson(), preview=parseJson();
    set(editor,JSON.stringify({...preview,size:'4K',aspect_ratio:'16:9',quality:'HIGH'}));await applyJson();
    editor=await openJson();preview=parseJson();
    check('先应用固定 JSON：4K/16:9 覆盖确实生效',preview.size==='4K'&&preview.aspect_ratio==='16:9'&&preview.quality==='HIGH',bodyDetail(preview));closeJson();
    await pickSize('auto');editor=await openJson();preview=parseJson();
    check('菜单改自动清除已应用固定 size/比例覆盖，保留其它 JSON 字段',isAuto(preview)&&preview.quality==='HIGH',bodyDetail(preview));
    check('自动选中时原生 select 与悬停提示均可发现',imageSize().value==='auto'&&imageSize().selectedOptions[0].text==='自动'&&/不指定/.test(imageSize().title),imageSize().title);
    const raw=need(get('[data-size-raw]'),'原样 size 开关'), start=raw.checked;
    check('普通自动尺寸仍可操作 raw 开关',!raw.disabled);
    click(raw);preview=parseJson();check('自动 raw 切换一次仍只有 size:auto',raw.checked!==start&&isAuto(preview),bodyDetail(preview));
    click(raw);preview=parseJson();check('自动 raw 切回仍只有 size:auto',raw.checked===start&&isAuto(preview),bodyDetail(preview));
    await applyJson();let body=await submit();
    check('自动文生图实际发送 size:auto，不发两种比例字段',isAuto(body)&&body.endpoint==='images_generations'&&body.mode==='generate'&&body.providerId==='pv_gpt'&&body.quality==='HIGH'&&!body.referenceUrls?.length,bodyDetail(body));

    // Repeat using the accepted camelCase alias, exercising a second independent override path.
    await pickSize('1152x1536');set(composer(),'imagesize JSON camel override');
    editor=await openJson();preview=parseJson();delete preview.aspect_ratio;
    set(editor,JSON.stringify({...preview,size:'2K',aspectRatio:'21:9',quality:'HIGH'}));await applyJson();
    editor=await openJson();preview=parseJson();
    check('camelCase 比例覆盖也确实应用为固定 2K/21:9',preview.size==='2K'&&preview.aspect_ratio==='21:9',bodyDetail(preview));closeJson();
    await pickSize('auto');body=await submit();
    check('菜单自动也清除旧 aspectRatio JSON 覆盖',isAuto(body)&&body.quality==='HIGH',bodyDetail(body));

    await pickEndpoint('images_edits');click(history('Images auto retry fixture','编辑提示词（填回输入框）'));
    await until(()=>all('.vig-composer .vig-ref').length===2,'恢复两张历史参考图');
    check('编辑历史提示词只恢复原参考图，不把当前自动尺寸改回固定',imageSize().value==='auto'&&all('.vig-composer .vig-ref img').length===2&&composer().value==='Images auto retry fixture');
    body=await submit('imagesize auto reference edit');
    check('自动参考图编辑保留两张 URL、当前供应商和 images_edits',isAuto(body)&&body.endpoint==='images_edits'&&body.mode==='edit'&&body.providerId==='pv_gpt'&&body.referenceUrl?.endsWith('up_1.png')&&body.referenceUrls?.length===2&&body.referenceUrls[1].endsWith('up_2.png'),bodyDetail(body));

    // Same-model providers are intentional: current pv_gpt must not replace historical pv_grok.
    await pickSize('4608x6144');body=await retry('Images auto retry fixture');
    check('历史 auto 在当前固定4K时仍是 auto，保留原供应商、双参考和会话',isAuto(body)&&body.providerId==='pv_grok'&&body.endpoint==='images_edits'&&body.mode==='edit'&&body.n===1&&body.conversationId==='conv_default'&&body.referenceUrls?.length===2&&body.referenceUrls[1].endsWith('up_2.png'),bodyDetail(body));
    await pickSize('auto');body=await retry('Images fixed retry fixture');
    check('历史固定 3:4 不受当前自动影响，保留2304x3072及原供应商/参考',body?.size==='2304x3072'&&body.aspect_ratio==='3:4'&&body.providerId==='pv_grok'&&body.endpoint==='images_edits'&&body.referenceUrls?.length===2,bodyDetail(body));
    await assertNarrow('自动');

    // Protocol isolation: inspect and operate actual dedicated selects, not helpers.
    await pickEndpoint('gemini_generate');await chooseModel('Nano-Banana-2');
    const geminiSize=get('[data-gemini-size]'), geminiRatio=get('[data-gemini-ratio]');
    check('切 Gemini 后仅显示原生1K/2K/4K和11个比例，不串普通像素菜单',!imageSize()&&Array.from(geminiSize?.options||[]).map(o=>o.value).join(',')==='1K,2K,4K'&&geminiRatio?.options.length===11&&Array.from(geminiRatio.options).filter(o=>o.value==='auto').length===1&&!!get('[data-gemini-count]'));
    set(geminiSize,'2K');set(geminiRatio,'auto');editor=await openJson();preview=parseJson();
    check('Gemini 自动仍为 size:2K + aspect_ratio:auto，raw锁定，不退成普通auto',preview.endpoint==='gemini_generate'&&preview.size==='2K'&&preview.aspect_ratio==='auto'&&preview.n===1&&get('[data-size-raw]').disabled,bodyDetail(preview));closeJson();
    await pickEndpoint('images_generations');await chooseModel('omni-flash');
    await until(()=>endpoint()?.value==='videos_generations','视频模型对应视频协议');
    const videoSelects=all('.vig-tools-pop select').filter(n=>!n.classList.contains('vig-endpoint'));
    const ratio=videoSelects.find(n=>Array.from(n.options).map(o=>o.value).join(',')==='16:9,9:16,1:1,4:3,3:4,21:9');
    const resolution=videoSelects.find(n=>Array.from(n.options).map(o=>o.value).join(',')==='480p,720p,1080p');
    const seconds=videoSelects.find(n=>Array.from(n.options).map(o=>o.value).join(',')==='4,6,8,10,12');
    check('切视频后保留独立比例/480p-1080p/时长菜单，不注入auto或图片像素',!imageSize()&&!get('[data-gemini-size]')&&!!ratio&&!!resolution&&!!seconds&&videoSelects.every(n=>!Array.from(n.options).some(o=>o.value==='auto'||o.value==='1152x1536')));
    set(ratio,'3:4');set(resolution,'1080p');editor=await openJson();preview=parseJson();
    check('视频3:4仍生成1080x1440与独立时长，不沿用图片auto',preview.endpoint==='videos_generations'&&preview.size==='1080x1440'&&preview.seconds==='4'&&noRatio(preview),bodyDetail(preview));closeJson();
    await chooseModel('gpt-image-2.5-c');await until(()=>endpoint()?.value==='images_generations'&&imageSize(),'图片模型返回普通图片菜单');
    check('从Gemini/视频返回普通images，自动选择和3:4三档完整保留',imageSize()?.value==='auto'&&['auto',...triples.map(t=>t[1])].every(value=>menu().some(o=>o.value===value)));
    await assertNarrow('协议往返');
    check('全流程只使用假宿主配置/生成，未走聊天或真实宿主写入',!posts.some(p=>p.path.startsWith('/chat/')||p.path==='/conversations/delete'||p.path==='/conversations/rename'));
  } catch(error) {
    check('普通图片尺寸完整交互执行完成',false,String(error.stack||error)+'; refs='+all('.vig-composer .vig-ref').length+'; draft='+composer()?.value+'; selected='+imageSize()?.value);
  } finally {window.confirm=originalConfirm;}
}
