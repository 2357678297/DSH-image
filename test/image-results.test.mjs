// Browser acceptance for chat result image sizing and responsive multi-image layout.
export async function auditImageResults({host, check, waitFor, wait, flushSync, posts}) {
  const grids = () => [...host.querySelectorAll('.vig-grid')];
  const byCount = count => grids().find(grid => grid.dataset.count === String(count));
  const columns = grid => {
    if (!grid) return 0;
    const xs = [...grid.querySelectorAll('.vig-shot-img')].map(el => Math.round(el.getBoundingClientRect().left));
    return new Set(xs).size;
  };
  const overflow = grid => {
    if (!grid) return Infinity;
    const a = grid.getBoundingClientRect(), b = host.getBoundingClientRect();
    return Math.max(0, b.left-a.left, a.right-b.right, host.scrollWidth-host.clientWidth);
  };
  await waitFor(() => byCount(8), 3000);
  for (const width of [1200, 660, 640, 375, 320, 280]) {
    host.style.width = `${width}px`;
    await wait(120);
    const one = byCount(1), two = byCount(2), three = byCount(3), eight = byCount(8);
    const singleRect = one?.querySelector('.vig-shot-img')?.getBoundingClientRect();
    const frames = [...(eight?.querySelectorAll('.vig-shot-img') || [])];
    const frameMetrics = frames.map(el => {
      const box=el.getBoundingClientRect(), image=el.querySelector('img');
      const original=Number(image.naturalWidth)/Number(image.naturalHeight), shown=box.width/box.height;
      return {shown,original,width:box.width,height:box.height,declared:el.parentElement.style.getPropertyValue('--vig-image-ratio'),fit:getComputedStyle(image).objectFit};
    });
    const ratioMatches = rows => rows.every(item => Number.isFinite(item.original) && Math.abs(item.shown-item.original)<.025 && Math.abs(Number(item.declared)-item.original)<.01);
    const compact = width < 660 || eight.parentElement.clientWidth <= 450;
    check(`${width}px 单张竖图限制在 360×420 且不溢出`, !!singleRect && singleRect.width <= 361 && singleRect.height <= 421 && overflow(one) === 0,
      JSON.stringify(singleRect?.toJSON()));
    check(`${width}px 两张保持双列、三张按栏宽排布`, columns(two) === 2 && columns(three) === (compact ? 2 : 3) && overflow(two) === 0 && overflow(three) === 0,
      JSON.stringify({two:columns(two),three:columns(three),compact}));
    check(`${width}px 八张按原图比例填框，无 4:3 留白且无横向溢出`, columns(eight) === (compact ? 2 : 4) && ratioMatches(frameMetrics) && frameMetrics.every(item=>item.fit==='contain') && overflow(eight) === 0,
      JSON.stringify({columns:columns(eight),frames:frameMetrics,overflow:overflow(eight)}));
  }
  host.style.width = '1200px';
  await wait(120);
  const opener = byCount(1)?.querySelector('.vig-shot-img');
  flushSync(() => opener?.click());
  const dialog = host.querySelector('dialog.vig-viewer');
  check('紧凑预览仍有明确的原图入口，点击可打开查看器', opener?.getAttribute('aria-label')?.includes('打开原图') && !!dialog?.open,
    opener?.getAttribute('aria-label'));
  flushSync(() => dialog?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  await wait(40);
  check('关闭查看器后返回对话，不改变缩略网格', !host.querySelector('dialog.vig-viewer')?.open && !!byCount(8));
  const remove=byCount(1)?.querySelector('[data-shot-delete]'), prior=posts.filter(item=>item.path==='/job/delete').length;
  let confirmation='';const originalConfirm=window.confirm;window.confirm=message=>{confirmation=String(message);return true;};
  try {
    check('每轮图片工具栏显示有独立语义的删除动作',!!remove&&remove.getAttribute('aria-label')?.includes('删除本轮所有结果')&&remove.getAttribute('aria-label')?.includes('图库素材保留'));
    flushSync(()=>remove?.click());await waitFor(()=>posts.filter(item=>item.path==='/job/delete').length===prior+1,2000);
    const deletion=posts.filter(item=>item.path==='/job/delete').at(-1);
    await waitFor(()=>!host.querySelector('[data-count="1"]'),2000);
    check('确认后删除本轮对话结果、图库素材仍不调用删除',confirmation.includes('图库里的图不受影响')&&deletion?.body?.ids?.length===1&&!posts.some(item=>item.path==='/library/delete'));
  } finally {window.confirm=originalConfirm;}
}
