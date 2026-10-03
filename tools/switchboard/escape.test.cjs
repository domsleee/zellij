const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/bridge.js','utf8');
function harness(){
 const handlers={},calls=[],notices=[],focus={},parent={document:{querySelector:()=>null},postMessage(){}},frames=[];
 let modal=false,focused=true,response={ok:true},payload={session_name:'current-session',active_pane:{pane_id:13,is_plugin:false}};
 class Socket{constructor(){this.handlers={};}addEventListener(t,f){this.handlers[t]=f;}}
 const window={WebSocket:Socket,addEventListener:(t,f)=>handlers[t]=f,term:{element:{contains:el=>focused&&el===focus}}};
 const document={activeElement:focus,createElement:()=>({setAttribute(){},style:{},textContent:''}),head:{append(){}},body:{append:el=>notices.push(el)},querySelector:()=>modal?{}:null};
 vm.runInNewContext(source,{window,document,parent,location:{pathname:'/hosts/windows/old-session',origin:'http://localhost:8090'},localStorage:{getItem:()=>null},requestAnimationFrame:fn=>frames.push(fn),fetch:async(url,opts)=>{calls.push({url,...JSON.parse(opts.body)});return response;}});
 const socket=new window.WebSocket('ws://localhost/hosts/windows/ws/control');
 const state=p=>socket.handlers.message({data:JSON.stringify({type:'MobileState',payload:p})});state(payload);
 const key=extra=>{const e={code:'Escape',altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.keydown(e);return e;};
 return {calls,notices,key,state,socket,parent,setFocused:v=>focused=v,setModal:v=>modal=v,setResponse:v=>response=v};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('physical unmodified terminal Escape posts current MobileState target once',async()=>{const h=harness(),e=h.key();assert.equal(e.prevented,true);assert.equal(e.stopped,true);await flush();assert.deepEqual(h.calls,[{url:'/api/hosts/windows/escape',session:'current-session',pane_id:13}]);});
test('modified Escape, nonterminal focus, plugins and native/parent dialogs keep their Escape',async()=>{const h=harness();for(const v of ['altKey','ctrlKey','metaKey','shiftKey','isComposing'])assert.equal(h.key({[v]:true}).prevented,undefined);assert.equal(h.key({code:'KeyQ',key:'Escape'}).prevented,undefined);h.setFocused(false);assert.equal(h.key().prevented,undefined);h.setFocused(true);h.setModal(true);assert.equal(h.key().prevented,undefined);h.setModal(false);h.parent.document.querySelector=()=>({});assert.equal(h.key().prevented,undefined);h.parent.document.querySelector=()=>null;h.state({session_name:'current',active_pane:{pane_id:1,is_plugin:true}});assert.equal(h.key().prevented,undefined);await flush();assert.equal(h.calls.length,0);});
test('disconnect or failed POST shows a visible failure',async()=>{const h=harness();h.setResponse({ok:false,text:async()=> 'Helper disconnected'});h.key();await flush();assert.match(h.notices[0].textContent,/Escape failed: Helper disconnected/);assert.equal(h.notices[0].hidden,false);h.socket.handlers.close();h.key();assert.match(h.notices[0].textContent,/state is unavailable/);});
test('queued requests snapshot each latest target and serialize',async()=>{const h=harness();h.key();h.state({session_name:'switched',active_pane:{pane_id:24,is_plugin:false}});h.key();await flush();assert.deepEqual(h.calls.map(c=>[c.session,c.pane_id]),[['current-session',13],['switched',24]]);});
