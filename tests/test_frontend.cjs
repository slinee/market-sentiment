const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
const base={workspace:{id:'default',name:'My workspace'},totals:{records:0,tickers:0,news:0,social:0,updated:null,score:null,risk:null},signals:[],watchlist:[],history:[],evidence:[]};
function harness(){
  const elements=new Map(),handlers=new Map(),calls=[];
  function get(key){if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',hidden:true,disabled:false,isConnected:true,files:[],style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},focus(){},setSelectionRange(){},addEventListener(){},querySelectorAll(){return[]}});return elements.get(key);}
  class Fields{constructor(form){this.data=form.fields}get(name){return this.data[name]??null}has(name){return name in this.data}}
  const context=vm.createContext({document:{querySelector:get,querySelectorAll:()=>[],addEventListener:(event,handler)=>handlers.set(event,handler),body:get('body'),createElement:()=>({click(){}})},window:{scrollTo(){},addEventListener(){}},location:{hash:''},history:{replaceState(){}},localStorage:{getItem(){return null},setItem(){}},navigator:{clipboard:{writeText:async()=>{}}},fetch:()=>new Promise(()=>{}),setTimeout(){},clearTimeout(){},console,URL,Blob,FormData:Fields});
  vm.runInContext(script,context);
  const run=code=>vm.runInContext(code,context);
  run(`data=${JSON.stringify(base)};profile={name:'Researcher',role:'Analyst'};status={engine:'vader',news_configured:false};workspaces=[{id:'default',name:'My workspace',archived:false,records:0}];`);
  function respond(fn){context.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>fn(url,options)}}}
  return{run,get,context,handlers,calls,respond};
}
test('every literal visible action and form has a matching handler',()=>{
  const {run}=harness();
  const actions=[...new Set([...`${html}\n${script}`.matchAll(/data-action="([a-z-]+)"/g)].map(match=>match[1]))];
  for(const action of actions)assert.equal(run(`typeof actions[${JSON.stringify(action)}]`),'function',action);
  for(const page of ['overview','watchlist','news','pipeline','backtest'])assert.equal(run(`typeof pages.${page}`),'object');
  for(const form of [...`${html}\n${script}`.matchAll(/data-form="([a-z-]+)"/g)])assert.ok(script.includes(`type==='${form[1]}'`),form[1]);
});
test('fresh overview has an intentional empty state and no fabricated signals',()=>{
  const {run}=harness();const result=run('overview()');
  assert.ok(result.includes('Start with your evidence.'));
  assert.ok(result.includes('No timeline yet'));
  for(const fake of ['NVDA','15,000','Cautiously bullish','Sample workspace','68 /'])assert.ok(!result.includes(fake));
});
test('page selector and header profile are functional delegated controls',async()=>{
  const {handlers,run,get}=harness();
  await handlers.get('click')({target:{closest:()=>({dataset:{action:'pages'}})},preventDefault(){}});
  assert.ok(get('#modalContent').innerHTML.includes('Open a page'));
  await handlers.get('click')({target:{closest:()=>({dataset:{action:'profile'}})},preventDefault(){}});
  assert.ok(get('#modalContent').innerHTML.includes('data-form="profile"'));
  await handlers.get('click')({target:{closest:()=>({dataset:{page:'pipeline'}})},preventDefault(){}});
  assert.equal(run('current'),'pipeline');assert.ok(get('#page').innerHTML.includes('Import CSV'));
});
test('workspace selector fetches real workspaces and renders switching controls',async()=>{
  const h=harness();h.respond(()=>[{id:'default',name:'Main',archived:false,records:0},{id:'second',name:'Second',archived:false,records:5}]);
  await h.run('workspaceModal()');
  assert.equal(h.calls[0].url,'/api/workspaces');
  assert.ok(h.get('#modalContent').innerHTML.includes('data-id="second"'));
  assert.ok(h.get('#modalContent').innerHTML.includes('5 records'));
});
test('imported evidence and user names are escaped in rendered HTML',()=>{
  const {run}=harness();
  run(`data.workspace.name='<script>alert(1)</script>';data.evidence=[{id:'x',ticker:'ABC',source:'<img src=x>',text:'<script>alert(1)</script>',published_at:'2026-10-10',created:'2026-10-10',sentiment:0,kind:'news'}]`);
  const result=run('evidenceItem(data.evidence[0])');assert.ok(result.includes('&lt;script&gt;'));assert.ok(!result.includes('<script>'));assert.ok(!result.includes('<img'));
});
test('unmeasured watchlist tickers show no fabricated score',()=>{
  const {run}=harness();run(`data.watchlist=[{ticker:'ABC',name:'Actual Company',sector:'Tech',score:null,risk:null,mentions:0,followed:true}]`);
  const result=run('table(true)');assert.ok(result.includes('No evidence'));assert.ok(result.includes('Actual Company'));assert.ok(result.includes('data-action="unfollow"'));
});
test('normal navigation clears sector filters; collection navigation applies its sector',()=>{
  const {run}=harness();run(`sector='Technology';go('overview')`);assert.equal(run('sector'),'');
  run(`actions.collection({dataset:{sector:'Energy'}})`);assert.equal(run('current'),'watchlist');assert.equal(run('sector'),'Energy');
});
test('simulation page never runs a request automatically',()=>{
  const h=harness();h.run(`go('backtest')`);assert.equal(h.calls.length,0);
  assert.ok(h.get('#page').innerHTML.includes('No simulation has been run'));
});
test('CSV export quotes commas and neutralizes formula prefixes',()=>{
  const {run}=harness();assert.equal(run(`csvCell('=SUM(A1)')`),'"\'=SUM(A1)"');assert.equal(run(`csvCell('a,b')`),'"a,b"');
});
test('timeline does not fabricate missing dates and supports one point',()=>{
  const {run}=harness();run(`data.history=[{day:'2026-10-01',score:65,count:1}]`);
  const result=run('chart()');assert.ok(result.includes('1 measured dates'));assert.ok(result.includes('10-01'));assert.ok(!result.includes('NaN'));
});
test('modal makes background inert, traps Tab and restores trigger focus',()=>{
  const h=harness();let restored=false,firstFocused=false,lastFocused=false,prevented=false;
  h.context.document.activeElement={isConnected:true,focus(){restored=true}};
  h.run(`modal('<h2>Profile</h2>')`);assert.equal(h.get('#mainContent').inert,true);
  const first={focus(){firstFocused=true}},last={focus(){lastFocused=true}};
  h.get('#modal').querySelectorAll=()=>[first,last];h.context.document.activeElement=last;
  h.handlers.get('keydown')({key:'Tab',preventDefault(){prevented=true}});assert.ok(firstFocused&&prevented);
  h.context.document.activeElement=first;h.handlers.get('keydown')({key:'Tab',shiftKey:true,preventDefault(){}});assert.ok(lastFocused);
  h.run('closeModal()');assert.ok(restored);assert.equal(h.get('#mainContent').inert,false);
});
test('profile form saves identity through the API',async()=>{
  const h=harness();h.respond(()=>({name:'Ava',role:'Research'}));
  const button={disabled:false},error={innerHTML:'',isConnected:true};
  h.context.testForm={dataset:{form:'profile'},fields:{name:'Ava',role:'Research'},querySelector:selector=>selector==='button[type=submit]'?button:error};
  await h.run('submitForm(testForm)');assert.equal(h.calls[0].url,'/api/profile');assert.equal(h.calls[0].options.method,'PATCH');assert.equal(h.run('profile.name'),'Ava');
});
