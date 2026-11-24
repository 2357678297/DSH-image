// Browser-only acceptance driver; the injected host handles /config entirely in memory.
export async function auditStorageMove({ host, check, flushSync, waitFor, posts, current, target, setMoveReply }) {
  const find = hook => host.querySelector(`[data-storage-${hook}]`);
  const open = find('move') || [...host.querySelectorAll('button')].find(b => b.textContent.trim() === '迁移到…');
  const block = open?.closest('.vig-block');
  const writes = () => posts.filter(x => x.path === '/config' && typeof x.body?.stateDir === 'string');
  const count = () => writes().length;
  const startCount = count();
  const click = el => { if (!el) throw Error('missing migration control'); flushSync(() => el.click()); };
  const type = value => {
    const el = find('target');
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const readDir = path => block && ([...block.querySelectorAll('input')].some(el => el.value === path) || block.textContent.includes(path));
  const err = '测试：目标目录不可写，请更换目录后重试';
  const prompt = window.prompt, hostWidth = host.style.width;
  let promptCalls = 0, complete = null;
  window.prompt = () => { promptCalls++; throw new Error('Electron: prompt() is not supported'); };
  try {
    check('素材目录有可发现的迁移按钮', !!open);
    if (!open) return;
    host.style.width = '375px';
    open.focus(); click(open);
    const panel = find('dialog'), dialog = panel?.closest('dialog, [role="dialog"]');
    check('桌面禁用 prompt 时点击即见迁移面板，尚未写配置', !!panel?.getClientRects().length && promptCalls === 0 && count() === startCount,
      JSON.stringify({visible:!!panel?.getClientRects().length, promptCalls, posts:count()-startCount}));
    if (!panel) return; // The --before client stops at the prompt error, which is intentionally a failing assertion.
    check('迁移弹窗及目标输入具备可访问名称，焦点留在弹窗', !!dialog && !!(dialog.getAttribute('aria-label') || dialog.getAttribute('aria-labelledby')) &&
      !!(find('target')?.labels?.length || find('target')?.getAttribute('aria-label') || find('target')?.getAttribute('aria-labelledby')) && dialog.contains(document.activeElement));
    const dialogRect = panel.getBoundingClientRect(), hostRect = host.getBoundingClientRect();
    check('弹窗不越过当前工作台的水平边界，当前目录可核对', dialogRect.width > 0 && dialogRect.left >= hostRect.left-1 && dialogRect.right <= hostRect.right+1 && panel.textContent.includes(current));
    const invalid = ['   ', 'relative-folder', current, current.toUpperCase().replaceAll('\\','/')+'/'];
    const blocked = invalid.map(value => { type(value); const disabled = find('confirm').disabled; click(find('confirm')); return disabled && count() === startCount && !!find('dialog'); });
    check('空白、相对路径和同一 Windows 目录（含大小写/分隔符）不提交', blocked.every(Boolean), JSON.stringify(blocked));
    type(target); click(find('cancel'));
    check('输入后取消不写配置，当前目录不变，焦点返回入口', !find('dialog') && readDir(current) && count() === startCount && document.activeElement === open);
    click(open); type(target);
    flushSync(() => find('target').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })));
    check('Esc 可离开未提交的弹窗', !find('dialog') && count() === startCount);
    click(open); type(target);
    setMoveReply(() => new Promise(resolve => { complete = resolve; }));
    const confirm = find('confirm');
    flushSync(() => { confirm.click(); confirm.click(); });
    await waitFor(() => complete, 1000);
    const busyStatus = find('dialog')?.querySelector('[role="status"]');
    flushSync(() => find('dialog').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })));
    check('连点确认只提交一次，进行中可读且 Esc 不会误关闭', count() === startCount+1 && writes().at(-1)?.body.stateDir === target && !!find('confirm')?.disabled && !!busyStatus?.textContent.trim());
    if (!complete) throw Error('no stateDir write to release');
    complete(new Response(JSON.stringify({ok:false,code:'state_dir_failed',error:err}), {status:400,headers:{'content-type':'application/json'}}));
    await waitFor(() => find('dialog') && !find('confirm')?.disabled, 1500);
    const errorNode = find('dialog')?.querySelector('[role="alert"], [aria-live]');
    check('保存失败：保留草稿、显示可读错误、当前目录不变，允许重试', find('target')?.value === target && !!errorNode?.textContent.includes(err) && !!errorNode?.getClientRects().length && !find('confirm')?.disabled && readDir(current),
      find('dialog')?.textContent.trim());
    setMoveReply(null); click(find('confirm'));
    await waitFor(() => !find('dialog'), 1800);
    check('重试成功：新目录生效，弹窗关闭且没有额外提交', count() === startCount+2 && writes().at(-1)?.body.stateDir === target && !find('dialog') && readDir(target) && promptCalls === 0,
      JSON.stringify({writes:writes().slice(startCount).map(x=>x.body),shown:readDir(target)}));
    const fetchMock = window.fetch;
    let refreshFailures = 0;
    try {
      window.fetch = (url, init) => {
        if (String(url).includes('/api/velapi-image-go/library?')) {
          refreshFailures++; return Promise.resolve(new Response(JSON.stringify({ok:false,error:'fixture index unavailable'}), {status:503}));
        }
        return fetchMock(url, init);
      };
      click(open); type(current); click(find('confirm'));
      await waitFor(() => !find('dialog'), 1800);
      const status = block?.querySelector('[role="status"]');
      check('宿主已迁移但图库刷新失败：当前目录仍切换，只提示刷新图库', refreshFailures === 1 && !find('dialog') && readDir(current) && count() === startCount+3 && status?.textContent.includes('刷新') && status.textContent.includes('2 个文件'), status?.textContent);
    } finally { window.fetch = fetchMock; }
  } finally {
    setMoveReply(null); window.prompt = prompt; host.style.width = hostWidth;
  }
}
