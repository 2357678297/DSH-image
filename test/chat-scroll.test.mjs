// Browser-only fixture for tools/viewer-check.mjs (?audit=chatscroll): real ChatView, no upstream or user history.
export async function auditChatScroll({ host, check, wait, flushSync, ui, React, createRoot }) {
  const h = React.createElement;
  const fixture = document.createElement('section');
  fixture.style.cssText = 'position:fixed;z-index:999;inset:0 auto auto 0;background:white';
  document.body.append(fixture);
  const root = createRoot(fixture);
  const actions = new Proxy({}, {get:() => () => {}});
  const make = (id, prompt, fields = {}) => ({id, prompt, userText:prompt, status:'succeeded', model:'demo', size:'1024x1024', images:[], ...fields});
  const history = Array.from({length:20}, (_,i) => make('past_'+(20-i), '历史 '+(20-i)));
  const state = {config:{defaultSize:'1024x1024',defaultModel:'demo',defaultCount:1,defaultEndpoint:'auto'}, providers:[], conversations:[], notes:[], protocols:[], references:[], draft:'', busyJobIds:[], ready:true};
  function render(width, conversationId, jobs) {
    const height = width === 320 ? 460 : 680;
    fixture.style.width = width+'px'; fixture.style.height = height+'px';
    flushSync(() => root.render(h('div', {className:'vig-root', 'data-compact': width===320?'1':'0', style:{height:'100%', '--vig-host-height':height+'px'}},
      h('div',{className:'vig-shell'}, h('div',{className:'vig-col', style:{flex:1}}, h(ui.ChatView,{state:{...state,conversationId,jobs},actions}))))));
  }
  const find = selector => fixture.querySelector(selector);
  const count = () => Number(find('.vig-bottom-jump-count')?.textContent || 0);
  const labels = () => [...fixture.querySelectorAll('.vig-me')].map(el => el.textContent);
  const gap = el => el.scrollHeight-el.clientHeight-el.scrollTop;
  const scroll = (box, y) => flushSync(() => { box.scrollTop=y; box.dispatchEvent(new Event('scroll')); });
  try {
    for (const width of [1020,320]) {
      const owner='A'+width; render(width, owner, history); await wait(160);
      const box=find('.vig-main-body');
      check(width+'px 首次进入：独立阅读区停在最后一条',box.clientHeight>80 && box.scrollHeight>box.clientHeight+300 && gap(box)<3, [box.clientHeight,box.scrollHeight,gap(box)]);
      scroll(box,60);await wait(50);
      const anchor=box.scrollTop;
      const pending=make('pending_1','本地生成',{kind:'pending',status:'running',clientSeq:1});
      render(width, owner, [pending,...history]); await wait(120);
      const jump=find('.vig-bottom-jump');
      const jr=jump?.getBoundingClientRect(), br=box.getBoundingClientRect();
      check(width+'px 追加占位不移动阅读位置，未读浮标在可点击区域',Math.abs(box.scrollTop-anchor)<=2 && count()===1 && jr && jr.top>=br.top-1 && jr.bottom<=br.bottom+1 && jump.contains(document.elementFromPoint(jr.x+jr.width/2,jr.y+jr.height/2)),JSON.stringify({anchor,after:box.scrollTop,count:count(),jump:jr?.toJSON(),box:br.toJSON()}));
      check(width+'px 插入本地消息不反转旧对话',labels()[0]==='历史 1' && labels().at(-2)==='历史 20' && labels().at(-1)==='本地生成');
      const accepted=make('real_1','本地生成',{status:'running',clientSeq:1});
      render(width, owner, [accepted,...history]);await wait(40);
      render(width, owner, [make('real_1','本地生成'),...history]);await wait(40);
      check(width+'px 占位受理及轮询刷新不重复计未读',count()===1 && Math.abs(box.scrollTop-anchor)<=2);
      const external=make('external','外部新增');
      render(width, owner, [external,accepted,...history]);await wait(40);
      check(width+'px 外部新增仍排在时间线末尾',labels().at(-1)==='外部新增' && count()===2 && Math.abs(box.scrollTop-anchor)<=2);
      const image=document.createElement('img');box.firstElementChild.append(image);image.dispatchEvent(new Event('load'));image.remove();
      render(width, owner, [external,...history]);await wait(40);
      check(width+'px 图片完成、删除未读不抢焦点，计数跟随位于历史中的实际轮次',count()===1 && Math.abs(box.scrollTop-anchor)<=2);
      flushSync(()=>find('.vig-bottom-jump')?.click());
      await wait(50);check(width+'px 回到底部恢复跟随，并清除未读',gap(box)<3 && !find('.vig-bottom-jump'));
      render(width,owner,[make('after','后续更新'),external,...history]);await wait(50);
      check(width+'px 贴底时新内容仍自动跟随',gap(box)<3 && !find('.vig-bottom-jump'));
      scroll(box,32); render(width,owner,[make('extra','新轮次'),external,...history]);
      render(width,'B'+width,[]);await wait(40);
      check(width+'px 空会话不显示上一段未读',!!find('.vig-empty') && !find('.vig-bottom-jump'));
      render(width,'B'+width,history);await wait(80);
      check(width+'px 切换后的异步历史从最新一条开始',gap(box)<3 && !find('.vig-bottom-jump'));
    }
  } finally {flushSync(()=>root.unmount());fixture.remove();}
}
