// Browser acceptance scenario, invoked by the viewer-check local HTTP fixture (?audit=gallery).
export async function auditGallery({ host, check, wait, flushSync }) {
  const q = (sel) => host.querySelector(sel);
  const all = (sel) => [...host.querySelectorAll(sel)];
  const click = (el) => { if (!el) throw Error('图库缺少预期控件'); flushSync(() => el.click()); };
  const fill = (el, value) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = (el, key) => {
    const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
    flushSync(() => el.dispatchEvent(event));
    return event;
  };
  const until = async (test) => { for (let i=0;i<60;i++){ if(test()) return; await wait(35); } throw Error('图库操作超时'); };
  const response = (payload, status=200) => new Response(JSON.stringify(payload), {status});
  const originalFetch = window.fetch, originalConfirm = window.confirm;
  const seed = (await (await originalFetch('/api/velapi-image-go/library?limit=200')).json()).items;
  // Mirror the actual publicAsset shape, not job.images' assetId alias.
  let library = seed.slice(0, 2).map(({assetId, ...row}) => row);
  const [a,b] = library, deletes = [], masks = [];
  let failDelete = true, finishMask;
  try {
    window.confirm = () => true;
    window.fetch = async (url, init) => {
      const path = String(url).split('/api/velapi-image-go').at(-1).split('?')[0];
      if (path === '/library') return response({ok:true, items:library});
      if (path === '/library/delete') {
        const {ids} = JSON.parse(init.body); deletes.push(ids); await wait(90);
        if (failDelete) return response({ok:false,error:'模拟删除失败'}, 503);
        library = library.filter(row => !ids.includes(row.id));
        return response({ok:true, removed:ids.length, items:library});
      }
      if (path === '/generate') {
        masks.push(JSON.parse(init.body)); await new Promise(end => {finishMask=end;});
      }
      return originalFetch(url, init);
    };
    click(all('.vig-nav-item').find(n => n.textContent.includes('图片管理')));
    await until(() => q('.vig-viewmode-btn'));
    click(q('.vig-toolbar button:last-child')); await wait(100);
    click(all('.vig-viewmode-btn')[1]); await until(()=>q('.vig-stage-img')?.naturalWidth);
    const brush = () => click(q('.vig-stage-acts [title="画笔"]'));
    brush();
    check('画笔图像不再触发原生拖图', !q('.vig-stage-img').draggable);
    const input = q('.vig-mask-input'); fill(input, 'paint A'); press(input,'Enter'); await wait(80);
    check('空笔迹的点击和 Enter 均不发请求',q('.vig-mask-send').disabled && masks.length===0);
    const img=q('.vig-stage-img'); const r=img.getBoundingClientRect();
    for(const type of ['pointerdown','pointerup']) flushSync(()=>img.dispatchEvent(new PointerEvent(type,{pointerId:12,button:0,bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})));
    press(input,'Enter'); press(input,'Enter'); await until(()=>finishMask);
    check('画笔双 Enter 只提交一次，带原图和 PNG 蒙版',masks.length===1 && masks[0].images?.length===1 && masks[0].mask?.startsWith('data:image/png') && masks[0].prompt==='paint A');
    const strip = () => all('.vig-strip-item'); click(strip()[1]); brush(); fill(q('.vig-mask-input'),'B 草稿');
    finishMask(); await wait(220);
    check('A 的延迟成功不跳页也不改 B 的草稿',q('.vig-strip-item.is-on')?.title===b.name && q('.vig-mask-input')?.value==='B 草稿');
    click(all('.vig-viewmode-btn')[0]); await wait(50);
    // Upload preview is deliberately not a library asset.
    const opener = q('.vig-tile-acts button'); opener.focus(); click(opener);
    await until(()=>q('.vig-viewer-stage img')?.naturalWidth);
    const modal = q('dialog.vig-viewer:modal'), viewport=document.documentElement;
    const box=modal?.getBoundingClientRect();
    check('原生模态查看器覆盖整个视口而非工作台', modal?.open && Math.abs(box.left)<2 && Math.abs(box.top)<2 && Math.abs(box.width-viewport.clientWidth)<2 && Math.abs(box.height-viewport.clientHeight)<2,JSON.stringify({box:box?.toJSON(),w:viewport.clientWidth,h:viewport.clientHeight}));
    check('id-only 图库项提供删除',Boolean(q('.vig-viewer-foot .is-danger')));
    click(q('.vig-viewer-head [title*="四点变形"]')); await until(()=>q('.vig-viewer-quad'));
    click(q('.vig-viewer-foot .is-primary')); await until(()=>!q('.vig-viewer-quad') && !q('.vig-viewer-foot .is-danger'));
    check('四点变形的临时上传预览无图库删除',Boolean(q('.vig-viewer'))&&!q('.vig-viewer-foot .is-danger'));
    press(q('dialog.vig-viewer:modal'),'Escape'); await until(()=>!q('.vig-viewer'));
    check('关闭查看器焦点回到打开它的图库控件',document.activeElement===opener);
    click(all('.vig-tile-meta')[0]); click(all('.vig-tile-meta')[1]);
    fill(q('.vig-toolbar input'), b.name); await wait(40);
    const del = q('.vig-toolbar .is-danger'); click(del); click(del); await wait(160);
    check('批删失败：只请求可见项，失败后保留选中状态',deletes.length===1 && deletes[0].join()===b.id && Boolean(q('.vig-tile.is-on')) && !q('.vig-toolbar .is-danger').disabled,JSON.stringify(deletes));
    fill(q('.vig-toolbar input'),'');await wait(40);
    check('恢复筛选不会恢复刚才被隐藏的勾选',all('.vig-tile.is-on').length===1 && q('.vig-tile.is-on img').alt===b.name);
    failDelete=false;
    click(q('.vig-tile img')); await until(()=>q('.vig-viewer-foot .is-danger'));
    click(q('.vig-viewer-foot .is-danger'));click(q('.vig-viewer-nav.is-next'));await wait(160);
    check('查看器以 publicAsset.id 删除 A，延迟回包不关闭正在看的 B',deletes.length===2 && deletes[1].join()===a.id && Boolean(q('.vig-viewer')) && !q('.vig-viewer-nav.is-next') && library.length===1 && library[0].id===b.id,JSON.stringify(deletes));
  } finally {
    finishMask?.(); window.fetch=originalFetch; window.confirm=originalConfirm;
  }
}
