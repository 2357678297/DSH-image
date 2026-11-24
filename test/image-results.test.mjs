// Browser acceptance for chat result image sizing and responsive multi-image layout.
export async function auditImageResults({host, check, waitFor, wait, flushSync}) {
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
    const ratio = frames[0] && getComputedStyle(frames[0]).aspectRatio;
    const compact = width < 660 || eight.parentElement.clientWidth <= 450;
    check(`${width}px 单张竖图限制在 360×420 且不溢出`, !!singleRect && singleRect.width <= 361 && singleRect.height <= 421 && overflow(one) === 0,
      JSON.stringify(singleRect?.toJSON()));
    check(`${width}px 两张保持双列、三张按栏宽排布`, columns(two) === 2 && columns(three) === (compact ? 2 : 3) && overflow(two) === 0 && overflow(three) === 0,
      JSON.stringify({two:columns(two),three:columns(three),compact}));
    check(`${width}px 八张最多四列、统一 4:3 contain 格，网格无横向溢出`, columns(eight) === (compact ? 2 : 4) && ratio === '4 / 3' && overflow(eight) === 0 && frames.every(el => getComputedStyle(el.querySelector('img')).objectFit === 'contain'),
      JSON.stringify({columns:columns(eight),ratio,overflow:overflow(eight)}));
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
}
