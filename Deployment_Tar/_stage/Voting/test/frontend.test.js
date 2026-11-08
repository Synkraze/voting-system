const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'public');

function page(name, request = async () => ({ ok: false, data: { error: 'Offline' }, uncertain: true })) {
  const html = fs.readFileSync(path.join(root, name + '.html'), 'utf8');
  const elements = new Map();
  class Element {
    constructor(id) { this.id=id;this.value='';this.disabled=false;this.hidden=false;this.style={};this.children=[];this.attributes={};this.textContent='';this.className='';this.files=[];this.events={};this.checked=false;this.innerHTML=''; }
    setAttribute(k,v) {this.attributes[k]=v;}
    getAttribute(k) {return this.attributes[k];}
    append(el) {this.children.push(el);}
    replaceChildren(...els) {this.children=els;this.innerHTML='';}
    focus() {this.focused=true;}
    close() {this.open=false;}
    showModal() {this.open=true;}
    addEventListener(type,fn) {this.events[type]=fn;}
    querySelector(selector) {
      if(selector === '[aria-pressed="true"]') return this.children.find(c=>c.attributes['aria-pressed']==='true');
      if(selector==='button') return this.children[0] || new Element();
      if(selector==='.selection-label') return this.label ||= new Element();
      return null;
    }
    querySelectorAll() { return []; }
  }
  for(const m of html.matchAll(/\bid="([^"]+)"/g)) {assert.ok(!elements.has(m[1]),'Duplicate ID '+m[1]);elements.set(m[1],new Element(m[1]));}
  if(elements.has('resetMode'))elements.get('resetMode').value='practice';
  const storage=new Map(),intervals=[];
  const context=vm.createContext({console,window:{matchMedia:()=>({matches:false})},document:{hidden:false,getElementById:id=>{assert.ok(elements.has(id),'Missing element '+id);return elements.get(id);},createElement:()=>new Element(),addEventListener(){},querySelectorAll:()=>[]},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},UI:{request,escape:v=>String(v??''),portrait:c=>'<portrait>'+c.name+'</portrait>',photoData:async()=>null,download(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},setTimeout,URLSearchParams,Blob,confirm:()=>true,prompt:()=>null,fetch:async()=>({json:async()=>({})})});
  const source=fs.readFileSync(path.join(root,name+'.js'),'utf8');
  for(const m of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(elements.has(m[1]),'Missing '+name+' element '+m[1]);
  vm.runInContext(source,context,{filename:name+'.js'});
  return {context,elements,storage,intervals,run:code=>vm.runInContext(code,context)};
}

test('all page scripts reference existing controls and initialize', async()=>{
  page('admin');page('vote');page('results');
});

test('admin sign-out clears the session token and private roster state',()=>{
  const p=page('admin');
  p.run("TOKEN='test-token';sessionStorage.setItem('admintoken',TOKEN);reviewedCsv='S1,One'");
  p.elements.get('roster').value='S1,One';
  p.run('signOut()');
  assert.equal(p.storage.has('admintoken'),false);
  assert.equal(p.elements.get('console').style.display,'none');
  assert.equal(p.elements.get('roster').value,'');
  assert.equal(p.run('TOKEN'),'');
});

test('reset requires acknowledgement and exact typed confirmation before any request',async()=>{
  let requests=0;const p=page('admin',async()=>{requests++;return {ok:false,data:{error:'No'}};});
  p.run("TOKEN='valid'");
  await p.run('performReset()');assert.equal(requests,0);
  p.elements.get('backupAcknowledged').checked=true;p.elements.get('resetPhrase').value='wrong';
  await p.run('performReset()');assert.equal(requests,0);
});

test('admin stats 401 clears the session and stops repeated requests', async () => {
  let requests=0;const p=page('admin',async()=>{requests++;return {ok:false,status:401,data:{error:'unauthorized'}};});
  p.run("TOKEN='stale';sessionStorage.setItem('admintoken',TOKEN);timer=1");p.elements.get('auto').checked=true;
  await p.run('refresh()');
  assert.equal(p.run('TOKEN'),'');assert.equal(p.run('timer'),null);assert.equal(p.storage.has('admintoken'),false);
  assert.equal(p.elements.get('auto').checked,false);assert.equal(p.elements.get('gate').style.display,'block');
  assert.match(p.elements.get('gatemsg').textContent,/expired|invalid/);
  await p.run('refresh()');assert.equal(requests,1);
});

test('empty sign-in does not call login; attempted sign-in restores its button', async () => {
  let logins=0;const p=page('admin',async()=>({ok:false,status:401,data:{error:'unauthorized'}}));
  const orig=p.context.UI.request;
  p.context.UI.request=async(url,opts)=>{if(url==='/admin/login')logins++;return orig(url,opts);};
  await p.run('signIn()');assert.equal(logins,0); // empty username/password
  p.elements.get('username').value='a';p.elements.get('password').value='b';
  await p.run('signIn()');
  assert.equal(logins,1);assert.equal(p.elements.get('signInBtn').disabled,false);
});

test('closed elections disable setup controls and block edits without an HTTP request', async () => {
  let requests=0;const p=page('admin',async()=>{requests++;return {ok:true,data:{}};});
  p.run("TOKEN='valid';applyElectionStatus('closed')");
  for(const id of ['setupFields','positionFields','candidateFields','rosterFields','editFields','closeVotingBtn'])assert.equal(p.elements.get(id).disabled,true);
  assert.equal(p.elements.get('closedNotice').hidden,false);
  await p.run('saveSchedule()');await p.run('toggleActive(1,false)');await p.run('delCandidate(1)');await p.run('addPosition()');
  assert.equal(requests,0);
  p.run("applyElectionStatus('open')");assert.equal(p.elements.get('setupFields').disabled,false);assert.equal(p.elements.get('closedNotice').hidden,true);
});

test('admin hold and resume controls follow election status', () => {
  const p = page('admin');
  p.run("applyElectionStatus('held')");
  assert.equal(p.elements.get('holdVotingBtn').hidden, true);
  assert.equal(p.elements.get('resumeVotingBtn').hidden, false);
  assert.equal(p.elements.get('candidateFields').disabled, false);
  assert.match(p.elements.get('adminState').textContent, /hold/);
  p.run("applyElectionStatus('open')");
  assert.equal(p.elements.get('holdVotingBtn').hidden, false);
  assert.equal(p.elements.get('resumeVotingBtn').hidden, true);
  p.run("applyElectionStatus('closed')");
  assert.equal(p.elements.get('holdVotingBtn').hidden, true);
  assert.equal(p.elements.get('resumeVotingBtn').hidden, true);
});

test('held ballot keeps its unused session for retry after resume', async () => {
  const p = page('vote', async () => ({ ok: false, data: { code: 'HELD', error: 'Voting is on hold.' } }));
  p.run("token='unused'; positions=[{position_id:1}]; selections={1:7}");
  await p.run('vote()');
  assert.equal(p.run('token'), 'unused');
  assert.match(p.elements.get('ballotMsg').textContent, /on hold/);
});

test('result polling renders per-position results after closure without a reload',async()=>{
  let closed=false;
  const closedData={status:'closed',election_id:'test',title:'Test',approved_by:null,approved_at:null,root:'GENESIS',verify:{ok:true,count:0},tally:{total:0,positions:[{position_id:1,title:'President',results:[],not_interested:0,total:0,status:'no_votes',winner:null}]}};
  const p=page('results',async()=>({ok:true,data:closed?closedData:{status:'open'}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(p.elements.get('content').innerHTML,/Voting is in progress/);
  closed=true;await p.run('load()');
  assert.match(p.elements.get('content').innerHTML,/President/);
  assert.match(p.elements.get('content').innerHTML,/Download CSV/);
});
