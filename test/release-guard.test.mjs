// End-to-end CLI contract. Uses only disposable working clones and local bare origins.
// `node test/release-guard.test.mjs`; no service is started, no real upstream can be contacted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../',import.meta.url));
const stamp=fs.mkdtempSync(path.join(os.tmpdir(),'vig-guard-qa-')), home=path.join(stamp,'home');
fs.mkdirSync(home);const emptyConfig=path.join(home,'empty.gitconfig');fs.writeFileSync(emptyConfig,'');
const env={...process.env};
for(const k of Object.keys(env))if(/^(GIT_|SSH_|GCM_|NODE_OPTIONS$|DSH_)/i.test(k))delete env[k];
Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home,APPDATA:home,LOCALAPPDATA:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'});
const P='0.2.1', V='v'+P, notes='修复编辑器保存。\n保留选中区域与当前草稿。', releaseDoc='docs/releases/'+V+'.md';
const call=(cwd,cmd,args,options={})=>{
  const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8',input:'',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024,...options});
  if(r.error)throw r.error;if(r.signal)throw Error(`${cmd} ${args} interrupted: ${r.signal}`);return r;
};
const git=(cwd,...args)=>{const r=call(cwd,'git',args);assert.equal(r.status,0,`git ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const file=(cwd,name)=>path.join(cwd,name);
const put=(cwd,name,text)=>{const f=file(cwd,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);};
const read=(cwd,name)=>fs.readFileSync(file(cwd,name),'utf8');
const bareRefs=f=>git(f.origin,'for-each-ref','--format=%(refname):%(objectname)');
const mainSHA=cwd=>git(cwd,'rev-parse','refs/heads/main');
const tagSHA=(cwd,tag)=>git(cwd,'rev-parse','refs/tags/'+tag+'^{commit}');
const head=cwd=>git(cwd,'rev-parse','HEAD');
const initLocal=cwd=>{git(cwd,'config','user.name','Release Guard Fixture');git(cwd,'config','user.email','release-guard@example.invalid');git(cwd,'config','core.autocrlf','false');};
const expect=(f,action,input={},pass=true)=>{
  const r=call(f.work,process.execPath,[file(f.work,'tools/release-guard.mjs'),action],{input:JSON.stringify(input),env:{...env,GUARD_FIXTURE_OUT:f.evidence,GUARD_FIXTURE_FAIL:f.fail}});
  let v;try{v=JSON.parse(r.stdout.trim());}catch{throw Error(`${action} did not return JSON: exit=${r.status}; stdout=${r.stdout.slice(-1200)} stderr=${r.stderr.slice(-1600)}`);}
  assert.equal(v.ok,pass,`${action} unexpected response: ${JSON.stringify(v).slice(-1800)} stderr=${r.stderr.slice(-500)}`);
  if(pass){assert.equal(r.status,0);assert.ok(v.state && typeof v.state==='object',`${action}: missing state`);}
  else{assert.notEqual(r.status,0);assert.ok(v.error,`${action}: missing failure reason`);}
  return v;
};
const reject=(f,action,input={})=>{const refs=bareRefs(f);const val=expect(f,action,input,false);assert.equal(bareRefs(f),refs,`${action} changed remote refs on rejection`);return val;};
const save=f=>expect(f,'save',{version:P,notes});
const prepare=f=>{save(f);expect(f,'prepare');};
const verified=f=>{prepare(f);expect(f,'verify');};
const checkedFiles=(f,from)=>[...new Set([...git(f.work,'diff','--name-only',from,'--').split('\n'),...git(f.work,'ls-files','--others','--exclude-standard').split('\n')].filter(Boolean))].sort();
const stages=[];
const run=(name,fn)=>{fn();stages.push(name);console.log('PASS '+name);};

try {
  // Fail early without initializing a partial set of fixtures if the in-development CLI is absent.
  for(const tool of ['tools/release-guard.mjs','tools/package-version.mjs'])assert.ok(fs.existsSync(file(source,tool)),`missing implementation: ${tool}`);
  const seed=path.join(stamp,'seed');fs.mkdirSync(seed);git(seed,'init','-b','main');initLocal(seed);
  for(const tool of ['tools/release-guard.mjs','tools/package-version.mjs'])put(seed,tool,fs.readFileSync(file(source,tool)));
  const manifest={name:'dsh-plugin-velapi-image-go',version:'0.2.0',type:'module',description:'test fixture',scripts:{test:'node tools/package-version.mjs && node test/host.test.mjs && node test/client.test.mjs'}};
  const originalManifest=JSON.stringify(manifest,null,2)+'\n',originalClient='// generated version; preserve surrounding code\nconst PLUGIN_VERSION = "0.2.0";\nexport default PLUGIN_VERSION;\n';
  put(seed,'package.json',originalManifest);put(seed,'client.js',originalClient);put(seed,'README.md','fixture base\n');
  // Stand-ins for long host/client suites. Their proof-of-run and injected failure live outside the working tree.
  for(const suite of ['host','client'])put(seed,`test/${suite}.test.mjs`,`import fs from 'node:fs';\nfs.appendFileSync(process.env.GUARD_FIXTURE_OUT, '${suite}\\n');\nif(fs.existsSync(process.env.GUARD_FIXTURE_FAIL)) throw Error('intentional regression');\n`);
  git(seed,'add','.');git(seed,'commit','-m','initial v0.2.0 fixture');git(seed,'tag','-a','v0.2.0','-m','v0.2.0');
  let sequence=0;
  const fixture=()=>{
    const stage=path.join(stamp,'isolated release '+(++sequence));fs.mkdirSync(stage);
    const origin=path.join(stage,'origin.git'), work=path.join(stage,'work');git(stage,'clone','--bare',seed,origin);git(stage,'clone',origin,work);initLocal(work);
    const f={origin,work,evidence:path.join(stage,'ran-tests'),fail:path.join(stage,'fail-test'),base:head(work)};
    // Do not share any remote beyond this local test's bare database, not even the local seed.
    git(origin,'remote','remove','origin');assert.equal(git(work,'remote','get-url','origin').replaceAll('\\','/'),origin.replaceAll('\\','/'));
    put(work,'feature.txt','local improvement\n');git(work,'add','--','feature.txt');git(work,'commit','-m','add feature for next release');f.code=head(work);return f;
  };
  run('读取状态和保存草稿不改提交、工作树或远端；不能重发同版本或降级',()=>{
    const f=fixture(), refs=bareRefs(f);expect(f,'status');save(f);
    assert.equal(head(f.work),f.code);assert.equal(git(f.work,'status','--porcelain'),'');assert.equal(read(f.work,'package.json'),originalManifest);assert.equal(read(f.work,'client.js'),originalClient);assert.equal(bareRefs(f),refs);
    reject(f,'save',{version:'0.2.0',notes});reject(f,'save',{version:'0.1.9',notes});assert.equal(head(f.work),f.code);
  });
  run('过期窗口不能覆盖较新的草稿，也不能用旧批准继续发布',()=>{
    const f=fixture();const revision=expect(f,'status').state.revision;assert.ok(revision);
    const first=expect(f,'save',{version:P,notes,expected:revision}).state;
    const latest=expect(f,'save',{version:P,notes:notes+'\n第二窗口的补充',expected:first.revision}).state;
    assert.notEqual(first.revision,latest.revision);reject(f,'prepare',{expected:first.revision});reject(f,'save',{version:P,notes:'过期窗口',expected:first.revision});
    const current=expect(f,'status').state;assert.equal(current.revision,latest.revision);assert.equal(current.draft.notes,latest.draft.notes);assert.equal(head(f.work),f.code);
    expect(f,'prepare',{expected:current.revision});assert.ok(read(f.work,releaseDoc).includes('第二窗口的补充'));
  });
  run('非 main、未提交改动均不能准备发布，不会擅自暂存或丢掉用户的修改',()=>{
    const f=fixture();save(f);git(f.work,'switch','-c','fix/other-branch');reject(f,'prepare');assert.equal(read(f.work,'package.json'),originalManifest);git(f.work,'switch','main');
    put(f.work,'README.md','draft not yet staged\n');put(f.work,'new user file.md','important\n');reject(f,'prepare');assert.equal(read(f.work,'README.md'),'draft not yet staged\n');assert.equal(read(f.work,'new user file.md'),'important\n');assert.equal(git(f.work,'diff','--cached','--name-only'),'');assert.equal(head(f.work),f.code);
  });
  run('准备只改版本与发布说明；禁止绕过验证、失败验证、错误确认以及验证后的未提交变动',()=>{
    const f=fixture(), refs=bareRefs(f);prepare(f);assert.deepEqual(checkedFiles(f,f.code),['client.js',releaseDoc,'package.json'].sort());
    assert.deepEqual(JSON.parse(read(f.work,'package.json')),{...manifest,version:P});assert.equal(read(f.work,'client.js'),originalClient.replace('0.2.0',P));assert.ok(read(f.work,releaseDoc).includes('修复编辑器保存。')&&read(f.work,releaseDoc).includes('保留选中区域与当前草稿。'));assert.equal(bareRefs(f),refs);
    reject(f,'publish',{confirm:V});fs.writeFileSync(f.fail,'fail');reject(f,'verify');reject(f,'publish',{confirm:V});fs.unlinkSync(f.fail);
    expect(f,'verify');const evidence=read(path.dirname(f.evidence),path.basename(f.evidence));assert.ok(evidence.includes('host\n')&&evidence.includes('client\n'),'verify did not run both suites');
    reject(f,'publish',{confirm:P});reject(f,'publish',{confirm:'v9.9.9'});reject(f,'publish',{confirm:''});
    fs.appendFileSync(file(f.work,'client.js'),'// unexpected user change\n');reject(f,'publish',{confirm:V});assert.ok(read(f.work,'client.js').endsWith('// unexpected user change\n'));
  });
  run('验证之后增加其他提交，拒绝旧的发布批准而不推任何 refs',()=>{
    const f=fixture();verified(f);put(f.work,'later.txt','not approved\n');git(f.work,'add','--','later.txt');git(f.work,'commit','-m','unreviewed work','--only','--','later.txt');const newHead=head(f.work);reject(f,'publish',{confirm:V});assert.equal(head(f.work),newHead);
  });
  run('本地或远端已存在同名标签时均不覆盖，也不单独提前推 main',()=>{
    for(const place of ['local','remote']){
      const f=fixture();verified(f);const where=place==='local'?f.work:f.origin;git(where,'tag',V,f.base);const pinned=tagSHA(where,V);reject(f,'publish',{confirm:V});assert.equal(tagSHA(where,V),pinned);assert.equal(mainSHA(f.origin),f.base);
    }
  });
  run('准备前已有同版本发布说明时不覆盖；撤回只撤销本工具产生的文件',()=>{
    const f=fixture();put(f.work,releaseDoc,'pre-existing release notes\n');git(f.work,'add','--',releaseDoc);git(f.work,'commit','-m','keep earlier release notes');save(f);reject(f,'prepare');assert.equal(read(f.work,releaseDoc),'pre-existing release notes\n');
    const fresh=fixture();prepare(fresh);const before=head(fresh.work);assert.equal(before,fresh.code,'prepare created a release commit');const modified=read(fresh.work,'client.js')+'// manually edited\n';put(fresh.work,'client.js',modified);
    reject(fresh,'reopen');assert.equal(read(fresh.work,'client.js'),modified);put(fresh.work,'client.js',originalClient.replace('0.2.0',P));expect(fresh,'reopen');assert.equal(head(fresh.work),before);assert.equal(git(fresh.work,'status','--porcelain'),'');assert.equal(read(fresh.work,'package.json'),originalManifest);assert.equal(fs.existsSync(file(fresh.work,releaseDoc)),false);
    expect(fresh,'prepare');assert.ok(read(fresh.work,releaseDoc).includes('修复编辑器保存。'),'reopen lost the draft notes');
  });
  run('服务端标签钩子拒绝时 main 和标签都不变；解除后同一提交和标签对象可重新发布',()=>{
    for(const name of ['update','pre-receive']){
      const f=fixture();verified(f);const hook=file(f.origin,'hooks/'+name);
      // Ref-specific update hook is the negative control: pushing main and tag separately would advance main.
      const content=name==='update'?'[ "$1" != "refs/tags/v0.2.1" ]':'while read old new ref; do [ "$ref" != "refs/tags/v0.2.1" ] || exit 1; done';
      fs.writeFileSync(hook,'#!/bin/sh\n'+content+'\n',{mode:0o755});
      reject(f,'publish',{confirm:V});assert.equal(mainSHA(f.origin),f.base);assert.equal(git(f.origin,'tag','--list',V),'');
      const localRelease=head(f.work), localTag=git(f.work,'rev-parse','refs/tags/'+V);
      assert.equal(expect(f,'status').state.phase,'pendingPush');fs.unlinkSync(hook);expect(f,'publish',{confirm:V});
      assert.equal(head(f.work),localRelease);assert.equal(mainSHA(f.origin),localRelease);assert.equal(git(f.origin,'rev-parse','refs/tags/'+V),localTag);
    }
  });
  run('隐藏引用的服务端返回拒绝时不声称成功；不强制回滚，解除后续推同一提交和标签',()=>{
    const f=fixture();verified(f);git(f.origin,'config','receive.hideRefs','refs/tags/'+V);const failure=expect(f,'publish',{confirm:V},false);
    const localRelease=head(f.work), localTag=git(f.work,'rev-parse','refs/tags/'+V), remoteAfter=mainSHA(f.origin);
    // Git 2.54.0.windows.1 can report "deny updating a hidden ref" but leave main advanced even with --atomic.
    // Record that behavior; never hide it behind a hook-only fixture or ask the guard to roll back a remote ref.
    assert.ok([f.base,localRelease].includes(remoteAfter));assert.ok(failure.error.includes(remoteAfter.slice(0,10)) && failure.error.includes('标签=未列出'),'remote-ref facts missing from failure: '+failure.error);assert.equal(git(f.origin,'tag','--list',V),'');assert.equal(expect(f,'status').state.phase,'pendingPush');
    console.log(`  receive.hideRefs: ${git(f.work,'--version')}; main=${remoteAfter===localRelease?'already at verified release':'unchanged'}; tag absent; publication reported failure`);
    git(f.origin,'config','--unset-all','receive.hideRefs');expect(f,'publish',{confirm:V});assert.equal(head(f.work),localRelease);assert.equal(mainSHA(f.origin),localRelease);assert.equal(git(f.origin,'rev-parse','refs/tags/'+V),localTag);
  });
  run('远端 main 已前进时不能强推，也不能把标签留在错误提交',()=>{
    const f=fixture();verified(f);const stage=path.dirname(f.work),other=path.join(stage,'other');git(stage,'clone',f.origin,other);initLocal(other);put(other,'extern.txt','concurrent change\n');git(other,'add','.');git(other,'commit','-m','concurrent remote change');git(other,'push','origin','main');const protectedSHA=mainSHA(f.origin);
    reject(f,'publish',{confirm:V});assert.equal(mainSHA(f.origin),protectedSHA);assert.equal(git(f.origin,'tag','--list',V),'');
  });
  run('精确确认后，main 与新版本标签一起指向包含已核验内容的发布提交',()=>{
    const f=fixture();verified(f);expect(f,'publish',{confirm:V});const remoteHead=mainSHA(f.origin);
    assert.equal(remoteHead,head(f.work));assert.equal(tagSHA(f.origin,V),remoteHead);assert.equal(tagSHA(f.origin,'v0.2.0'),f.base);assert.notEqual(remoteHead,f.code);
    assert.equal(git(f.origin,'show',`${remoteHead}:client.js`),originalClient.replace('0.2.0',P).trim());assert.equal(JSON.parse(git(f.origin,'show',`${remoteHead}:package.json`)).version,P);assert.match(git(f.origin,'show',`${remoteHead}:${releaseDoc}`),/修复编辑器保存/);
    assert.equal(git(f.origin,'show',`${remoteHead}:feature.txt`),'local improvement');assert.equal(git(f.work,'status','--porcelain'),'');assert.deepEqual(git(f.origin,'for-each-ref','--format=%(refname)').split('\n').sort(),['refs/heads/main','refs/tags/v0.2.0','refs/tags/'+V].sort());
  });
  console.log(`${stages.length}/${stages.length} release-guard scenarios passed; file://-only, no production remote used`);
} finally {
  assert.equal(path.dirname(path.resolve(stamp)),path.resolve(os.tmpdir()));assert.ok(path.basename(stamp).startsWith('vig-guard-qa-'));fs.rmSync(stamp,{recursive:true,force:true,maxRetries:3,retryDelay:120});
}
