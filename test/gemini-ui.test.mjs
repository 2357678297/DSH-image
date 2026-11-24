// Runs only in the viewer fixture. No requests are sent to a provider.
export async function auditGeminiUI({host,check,wait,waitFor,flushSync,posts,remount}) {
  const get=s=>host.querySelector(s), all=s=>Array.from(host.querySelectorAll(s)), click=e=>flushSync(()=>e.click());
  const ep=()=>get('select.vig-endpoint'), sends=()=>posts.filter(p=>p.path==='/generate'), last=()=>sends().at(-1)?.body;
  const set=(el,v)=>flushSync(()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));});
  const text=()=>get('.vig-composer textarea.vig-input');
  try {
    host.style.width='375px'; click(get('[data-tools-toggle]'));
    check('Gemini 原生选项可见，现代宿主可选', [...ep().options].some(o=>o.value==='gemini_generate'&&o.text==='Gemini 原生'&&!o.disabled));
    set(ep(),'gemini_generate'); await wait(60);
    const size=get('[data-gemini-size]'), ratio=get('[data-gemini-ratio]');
    check('8K 宽像素预设转 4K · 21:9，10 个比例，张数固定',size?.value==='4K' && ratio?.value==='21:9' && ratio.options.length===10 && size.options.length===3 && !!get('[data-gemini-count]'));
    set(size,'2K'); set(ratio,'3:4'); set(text(),'gemini text fixture'); click(get('[data-json-body]'));
    const editor=get('[data-json-editor]'), expected=JSON.parse(editor.value);
    check('JSON 反映实际参数且无质量或时长',expected.endpoint==='gemini_generate' && expected.size==='2K' && expected.aspect_ratio==='3:4' && expected.model==='Nano-Banana-2' && expected.n===1 && !('quality' in expected) && !('seconds' in expected) && get('[data-size-raw]').disabled);
    set(editor,JSON.stringify({...expected,size:'8K'}));click(get('[data-json-apply]'));await wait(30);
    check('JSON 8K 无法应用，具体错误可见',!!get('[data-json-editor]') && host.textContent.includes('每次仅生成 1 张'));
    set(editor,JSON.stringify(expected));click(get('[data-json-apply]'));click(get('[data-force-generate]'));await waitFor(()=>sends().length===1,1500);
    check('Nano-Banana-2 的文本请求不走 images_generations', last()?.endpoint==='gemini_generate' && last().mode==='generate' && Object.keys(expected).every(k=>JSON.stringify(expected[k])===JSON.stringify(last()[k])));
    const historyAuthor=all('article.is-user').find(n=>n.textContent.includes('Gemini retry fixture'));
    const historyAction=(name)=>historyAuthor?.nextElementSibling?.querySelector('button[aria-label="'+name+'"]');
    click(historyAction('编辑提示词（填回输入框）')); await waitFor(()=>get('.vig-ref img'),1000);click(get('[data-force-generate]'));await waitFor(()=>sends().length===2,1500);
    check('带参考图仍使用原生协议，保留本地参考 URL',last()?.endpoint==='gemini_generate' && last().mode==='edit' && last().referenceUrls?.[0]?.endsWith('up_1.png'));
    click(historyAction('重试'));await waitFor(()=>sends().length===3,1500);
    check('重试沿用原供应商、协议、参考图和比例，不带旧质量或时长', last()?.providerId==='pv_gpt' && last().endpoint==='gemini_generate' && last().size==='2K' && last().aspect_ratio==='4:3' && last().n===1 && !!last().referenceUrls.length && !('quality' in last()) && !('seconds' in last()));
    for (const kind of ['chat','']) {
      await remount(kind); const n=sends().length;
      const msg=get('[data-gemini-unavailable]'); const oldHistory=all('article.is-user').find(e=>e.textContent.includes('Gemini retry fixture'));
      set(text(),'old host draft'); const key=new KeyboardEvent('keydown',{bubbles:true,key:'Enter'});flushSync(()=>text().dispatchEvent(key));
      click(oldHistory.nextElementSibling.querySelector('button[aria-label="重试"]'));await wait(40);
      check('旧宿主（'+(kind||'缺失')+'）：会话保留 Gemini；按键和重试均零请求',ep()?.value==='gemini_generate' && ep().selectedOptions[0]?.disabled && !!msg?.textContent.includes('重启 DSH') && get('[data-force-generate]').disabled && text().value==='old host draft' && sends().length===n);
    }
  } catch (e) {check('Gemini 浏览器流程执行完成',false,String(e.message));}
}
