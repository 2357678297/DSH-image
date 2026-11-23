#!/usr/bin/env node
// Maintainer-only local CLI. Never register this module as a plugin or an HTTP route.
// Requests: one JSON object on stdin. Responses: one JSON object on stdout.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile), root = fileURLToPath(new URL('../',import.meta.url));
const verb = process.argv[2] || 'status';
const actions = ['status','save','prepare','reopen','verify','publish'];
const ensure = (v,message) => { if(!v) throw Error(message); };
const sha = data => createHash('sha256').update(data).digest('hex');
const fixed = ['package.json','client.js'];
const versionRE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function higher(next,current) {
  if(typeof next!=='string' || typeof current!=='string' || next.length>35 || current.length>35 || !versionRE.test(next) || !versionRE.test(current)) return false;
  const a=next.split('.').map(BigInt), b=current.split('.').map(BigInt);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return false;
}
const redact = s => String(s).replace(/(https?:\/\/)[^\s/@]+@/gi,'$1***@').replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi,'$1');
async function run(binary,args,timeout=15000) {
  try {return (await exec(binary,args,{cwd:root,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},windowsHide:true,timeout,maxBuffer:12*1024*1024,encoding:'utf8'})).stdout;}
  catch(e){throw Error(redact((e.stderr || e.stdout || e.message || '命令失败').trim().slice(-2400)));}
}
const git = async (...args) => (await run('git',args)).trimEnd();
const exists = async p=>{try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const absolute = file => path.join(root,file);
const currentHead = ()=>git('rev-parse','HEAD');
const branch = ()=>git('rev-parse','--abbrev-ref','HEAD');
async function porcelain(){const z=(await run('git',['status','--porcelain=v1','-z','--untracked-files=all','--no-renames'])).split('\0');return z.filter(Boolean);}
const notesFile = v=>`docs/releases/v${v}.md`;
const paths = d => [...fixed,notesFile(d.version)];
const metadata = async ()=>{const m=JSON.parse(await fs.readFile(absolute('package.json'),'utf8'));ensure(m.name==='dsh-plugin-velapi-image-go','不是本工作台的维护仓库');return m;};
const remoteUrl = async ()=>{const r=await git('remote','get-url','--push','--all','origin');ensure(r && !/[\r\n]/.test(r),'需要唯一的 origin 推送目标');return r;};
let dir, stateFile, lockPath, d=null;
const revision = () => sha(JSON.stringify(d));
async function persist(){
  if(!d){await fs.rm(stateFile,{force:true});return;}
  const tmp=stateFile+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(d,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,stateFile);}finally{await fs.rm(tmp,{force:true});}
}
async function cleanMain(){
  ensure(await branch()==='main','仅允许在 main 分支执行此操作');
  for(const mark of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_START','rebase-apply','rebase-merge','sequencer']) ensure(!await exists(path.join(dir,mark)),'请先完成正在进行的 Git 操作');
}
async function noLocalTag(tag){ensure(!(await git('tag','--list',tag)),`本地已存在 ${tag}，不会覆盖`);}
async function unchangedBase(){
  await cleanMain();ensure(d && await currentHead()===d.base,'草稿绑定的 HEAD 已变化，请重新核对改动、保存草稿');
  ensure(d.remoteHash===sha(await remoteUrl()),'origin 推送目标已改变，不能沿用原有草稿或校验');
}
async function safeFile(file){
  let p=root;for(const part of file.split('/')){p=path.join(p,part);try{const st=await fs.lstat(p);ensure(!st.isSymbolicLink() && (p===absolute(file) ? st.isFile() && st.nlink===1 : st.isDirectory()),`不允许通过链接或特殊文件写入 ${file}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return absolute(file);
}
async function writeTracked(file,text){await safeFile(file);await fs.writeFile(absolute(file),text,'utf8');}
function versioned(file,source,from,to){
  const re=file==='package.json' ? /^(\s*"version"\s*:\s*")([^"\r\n]+)(",?\s*)$/gm : /^(\s*const PLUGIN_VERSION = ")([^"\r\n]+)(";)/gm;
  const matches=[...source.matchAll(re)].filter(m=>m[2]===from);
  ensure(matches.length===1 && (file!=='package.json' || JSON.parse(source).version===from),`版本未同步或声明不唯一：${file}`);
  const m=matches[0];return source.slice(0,m.index)+m[1]+to+m[3]+source.slice(m.index+m[0].length);
}
async function filesMatch(phase='after'){
  for(const file of paths(d)){const p=await safeFile(file),actual=(await exists(p)) ? sha(await fs.readFile(p)) : null;ensure(actual===d[phase]?.[file],`${file} 与守卫记录不一致；为保留你的编辑已停止。`);}
}
async function exactWorkspace(){
  await unchangedBase();const allowed=paths(d);const rows=await porcelain();
  ensure(rows.every(r=>allowed.includes(r.slice(3))) && rows.length===allowed.length,'准备后的变更不止版本文件和发布说明，或文件未变更；请先返回编辑并整理工作区');
  await filesMatch();
}
async function status(){
  const head=await currentHead(), current=await branch();let last='';try{last=await git('describe','--tags','--abbrev=0','--match','v[0-9]*',head);}catch{};
  const log=await git('log','-50','--oneline',last?`${last}..${head}`:head);
  let remote='';try{remote=redact(await remoteUrl());}catch{remote='（未配置唯一的 origin）';}
  return {revision:revision(),version:(await metadata()).version,head,branch:current,files:await porcelain(),commits:log?log.split('\n'):[],remote,
    draft:d?{version:d.version,notes:d.notes,base:d.base}:null,phase:d?.phase==='committing'?'pendingPush':(d?.phase || 'editing'),target:d?'v'+d.version:'',notesPath:d?notesFile(d.version):'',verifiedSha:d?.verified || ''};
}
async function save(input){
  await cleanMain();ensure(!d || d.phase==='editing','先返回编辑，再修改发布草稿');
  const {version,notes}=input, cur=(await metadata()).version;
  ensure(higher(version,cur),`请输入高于 ${cur} 的正式版本（例如 0.2.1，不带 v）`);
  ensure(typeof notes==='string' && notes.trim() && notes.length<=16000 && !notes.includes('\0'),'请填写发布说明，最多 16000 字');
  await noLocalTag('v'+version);d={phase:'editing',base:await currentHead(),from:cur,version,notes:notes.trim().replace(/\r\n?/g,'\n'),remoteHash:sha(await remoteUrl())};await persist();
}
async function prepare(){
  ensure(d?.phase==='editing','先保存草稿，再准备发布');await unchangedBase();await noLocalTag('v'+d.version);
  ensure(!(await porcelain()).length,'请先审查并手动提交功能改动（包括未跟踪文件），守卫不会 git add -A');
  ensure(higher(d.version,(await metadata()).version),'目标版本不高于当前包');
  const outputs={},before={},after={};
  for(const f of fixed){const old=await fs.readFile(await safeFile(f),'utf8');before[f]=sha(old);outputs[f]=versioned(f,old,d.from,d.version);}
  const nf=notesFile(d.version);ensure(!await exists(await safeFile(nf)),'同名发布说明已存在，不会覆盖');before[nf]=null;outputs[nf]=`# v${d.version}\n\n${d.notes}\n`;
  for(const [f,text] of Object.entries(outputs)) after[f]=sha(text);
  // Write the recovery journal first. reopen accepts either side of a partially completed prepare.
  Object.assign(d,{phase:'prepared',before,after});await persist();
  await fs.mkdir(path.dirname(absolute(nf)),{recursive:true});
  for(const f of fixed) await writeTracked(f,outputs[f]);await fs.writeFile(await safeFile(nf),outputs[nf],{flag:'wx'});
  await exactWorkspace();
}
async function reopen(){
  ensure(['prepared','verified'].includes(d?.phase),'只能撤回未提交的发布准备');await cleanMain();
  ensure(!(await git('diff','--name-only',d.base,'HEAD','--',...paths(d))),'新提交已修改发布文件，请手动核对；不会撤销其他提交');
  ensure(!(await git('diff','--cached','--name-only','--',...paths(d))),'版本文件已暂存，请先手动取消这些文件的暂存');
  const restore=[];for(const f of paths(d)){
    const p=await safeFile(f), text=(await exists(p))?await fs.readFile(p,'utf8'):null, digest=text===null?null:sha(text);
    if(digest===d.before[f])continue;ensure(digest===d.after[f],`${f} 被手动修改，拒绝覆盖。请先备份并核对该文件。`);
    const old=fixed.includes(f)?versioned(f,text,d.version,d.from):null;ensure((old===null?null:sha(old))===d.before[f],'无法无损撤销版本号');restore.push([f,old]);
  }
  for(const [f,old] of restore){if(old===null)await fs.unlink(await safeFile(f));else await writeTracked(f,old);}
  d.phase='editing';delete d.verified;delete d.blobs;await persist();
}
async function verify(){
  ensure(['prepared','verified'].includes(d?.phase),'先准备发布，再校验');d.phase='prepared';delete d.verified;await persist();
  await exactWorkspace();await noLocalTag('v'+d.version);await git('-c','core.whitespace=cr-at-eol','diff','--check',d.base,'--',...paths(d));
  const checks=['tools/package-version.mjs','test/host.test.mjs','test/client.test.mjs'];
  // The isolated guard fixtures only contain the minimal host/client suites, so this does not recurse.
  if(await exists(absolute('test/release-guard.test.mjs'))) checks.push('test/release-guard.test.mjs');
  for(const file of checks) await run(process.execPath,[file],file.endsWith('release-guard.test.mjs')?420000:180000);
  await exactWorkspace();d.blobs={};for(const f of paths(d))d.blobs[f]=await git('hash-object',`--path=${f}`,'--',f);
  d.verified=d.base;d.phase='verified';await persist();
}
const tagName=()=>`v${d.version}`;
async function verifyReleaseCommit(head){
  ensure((await git('rev-list','--parents','-1',head))===`${head} ${d.verified}`,'HEAD 不是基于已校验提交产生的发布提交');
  const touched=(await git('diff-tree','--no-commit-id','--name-only','-r','--no-renames',d.base,head)).split('\n').sort();
  ensure(JSON.stringify(touched)===JSON.stringify(paths(d).sort()),'发布提交包含额外文件或缺少版本文件');
  for(const f of paths(d)){const tree=await git('ls-tree',head,'--',f);ensure(tree===`100644 blob ${d.blobs[f]}\t${f}`,`发布提交中的 ${f} 与通过校验的快照不符`);}
}
async function remoteState(localRelease){
  const url=await remoteUrl();ensure(sha(url)===d.remoteHash,'origin 推送目标已变化，已阻止推送');
  const tag=`refs/tags/${tagName()}`, main='refs/heads/main';
  const listing=await run('git',['ls-remote','--',url,main,tag,tag+'^{}'],45000);
  const refs=new Map(listing.trim().split('\n').filter(Boolean).map(l=>{const [id,r]=l.split(/\s+/);return [r,id];}));
  ensure(refs.has(main),'远端 main 不存在，拒绝从编辑器创建或覆盖分支');
  if(refs.has(tag)){
    ensure(localRelease && (refs.get(tag+'^{}') || refs.get(tag))===localRelease && refs.get(main)===localRelease && refs.get(tag)===await git('rev-parse',tag),'远端同名标签已存在，拒绝覆盖');return true;
  }
  try{await git('merge-base','--is-ancestor',refs.get(main),localRelease || d.base);}catch{throw Error('远端 main 不在已审核历史中。请先核对远端变更；不会强推。');}return false;
}
async function publish(input){
  ensure(d && input.confirm===tagName(), '发布需要再次输入完整目标标签，例如 v0.2.1');
  ensure(d.verified && ['verified','committing','pendingPush'].includes(d.phase),'当前草稿未通过校验，不能发布');await cleanMain();
  let head=await currentHead();
  if(d.phase==='verified' || (d.phase==='committing' && head===d.base)){
    await exactWorkspace();await noLocalTag(tagName());await remoteState(null);await exactWorkspace();
    d.phase='committing';await persist();
    try{
      await git('add','--',...paths(d));await git('commit','--only','-m',`release: ${tagName()}`,'--',...paths(d));
    }catch(e){if(await currentHead()===d.base){d.phase='prepared';delete d.verified;await persist();}throw e;}
    head=await currentHead();
  }
  ensure(!d.release || d.release===head,'待推送提交已变化，拒绝改推新的 HEAD');await verifyReleaseCommit(head);
  d.release=head;d.phase='pendingPush';await persist();ensure(!(await porcelain()).length,'发布提交后工作区已变化；保留待推送状态，不推送其他内容');
  const tag=tagName();if(await git('tag','--list',tag))ensure((await git('rev-parse',`refs/tags/${tag}^{commit}`))===head,'本地同名标签指向其他提交，拒绝覆盖');
  else await git('tag','-a',tag,'-m',tag,head);
  if(!await remoteState(head)){
    const pinnedUrl=await remoteUrl(), tagOid=await git('rev-parse',`refs/tags/${tag}`);
    ensure(sha(pinnedUrl)===d.remoteHash && (await git('rev-parse',`${tagOid}^{commit}`))===head,'目标或版本标签已变化，取消推送');
    try {
      await run('git',['push','--atomic','--no-follow-tags','--',pinnedUrl,`${head}:refs/heads/main`,`${tagOid}:refs/tags/${tag}`],90000);
    } catch (e) {
      // 某些 receive.hideRefs/服务端实现会报告失败但已经移动了一个 ref。不要自动回滚。
      let observed='未核实';
      try {const r=await run('git',['ls-remote','--',pinnedUrl,'refs/heads/main',`refs/tags/${tag}`,`refs/tags/${tag}^{}`],12000);
        const refs=new Map(r.trim().split('\n').filter(Boolean).map(l=>{const [id,key]=l.split(/\s+/);return [key,id];}));
        observed=`main=${refs.get('refs/heads/main')?.slice(0,10)||'未列出'}，标签=${refs.has(`refs/tags/${tag}`)?'已列出':'未列出'}`;
      }catch{}
      throw Error(`推送失败或未获完整回执；远端：${observed}。保留本地发布提交 ${head.slice(0,10)}，未回滚。解决远端问题后重新确认同一标签。\n${e.message}`);
    }
    ensure(await remoteState(head),'远端未确认分支和标签同时到位。已保留本地发布提交，请核对后重试。');
  }
  d=null;await persist();
}
async function main(){
  ensure(verb!=='npm-version','直接 npm version 已停用；请运行 npm run release:editor 走校验和明确确认。');
  ensure(actions.includes(verb),'未知操作：'+verb);
  ensure((await fs.realpath(root))===await fs.realpath(await git('rev-parse','--show-toplevel')),'请从插件源码仓库使用发布守卫');await metadata();
  dir=await git('rev-parse','--absolute-git-dir');stateFile=path.join(dir,'vig-release-draft.json');lockPath=path.join(dir,'vig-release.lock');
  let lock;try{
    if(verb!=='status'){
      try{lock=await fs.open(lockPath,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;throw Error('另一个发布操作正在运行；如上次意外退出，先核对 .git/vig-release.lock 内的 PID。');}
      await lock.writeFile(JSON.stringify({pid:process.pid,action:verb,at:new Date().toISOString()}));
    }
    if(await exists(stateFile)){
      d=JSON.parse(await fs.readFile(stateFile,'utf8'));
      ensure(d && ['editing','prepared','verified','committing','pendingPush'].includes(d.phase) && higher(d.version,d.from)
        && /^[0-9a-f]{40,64}$/.test(d.base) && /^[0-9a-f]{64}$/.test(d.remoteHash) && typeof d.notes==='string',
        '本地草稿记录不完整；请先备份并人工核对，未修改任何发布文件。');
    }
    if(verb!=='status'){let raw='';process.stdin.setEncoding('utf8');for await(const b of process.stdin){raw+=b;ensure(raw.length<=100000,'输入内容过长');}const input=JSON.parse(raw.replace(/^\uFEFF/,'').trim()||'{}');
      ensure(input && typeof input==='object' && !Array.isArray(input),'请求必须为 JSON 对象');
      ensure(input.expected===undefined || input.expected===revision(),'其他窗口已修改草稿或发布状态，请刷新后重新核对');
      await ({save,prepare,reopen,verify,publish})[verb](input);}
    return await status();
  }finally{if(lock){await lock.close();await fs.unlink(lockPath);}}
}
try{console.log(JSON.stringify({ok:true,state:await main()}));}catch(e){console.log(JSON.stringify({ok:false,error:redact(e.message)}));process.exitCode=1;}
