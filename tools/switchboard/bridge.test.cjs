const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/bridge.js','utf8');
function harness(){
  const handlers={},messages=[],properties=new Map(),classes=new Set(),frames=[],resizes=[];
  let modal=false,bottomRows=2,firstRow='Zellij (main)';
  class Socket{constructor(){this.handlers={};}addEventListener(type,fn){this.handlers[type]=fn;}}
  const parent={postMessage:data=>messages.push(data)};
  const window={WebSocket:Socket,addEventListener:(type,fn)=>handlers[type]=fn,dispatchEvent:()=>resizes.push(1),
    __switchboardBottomRows:()=>bottomRows,
    term:{options:{disableStdin:false},element:{style:{pointerEvents:""}},blur(){},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>firstRow})}},_core:{_renderService:{dimensions:{css:{cell:{height:18}}}}},onRender(){},onResize(){},focus(){}}};
  const document={createElement:()=>({style:{},setAttribute(){}}),head:{append(){}},querySelector:()=>modal?{}:null,
    body:{append(){},classList:{contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)}},
    documentElement:{style:{getPropertyValue:key=>properties.get(key)||'',setProperty:(key,val)=>properties.set(key,val)}}};
  vm.runInNewContext(source,{window,document,parent,location:{pathname:'/hosts/windows/main',origin:'http://localhost:8090'},localStorage:{getItem:()=>null},MutationObserver:class{observe(){}},requestAnimationFrame:fn=>frames.push(fn),Event:class{}});
  const key=(code,extra={})=>{const event={code,altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.keydown(event);return event;};
  const state=(payload={})=>{const socket=new window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.message({data:JSON.stringify({type:'MobileState',payload})});while(frames.length)frames.shift()();};
  const error=(...lines)=>{const socket=new window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.message({data:JSON.stringify({type:'LogError',lines})});};
  return{window,handlers,parent,messages,properties,classes,key,state,error,setModal:v=>modal=v,setBottomRows:v=>bottomRows=v,setFirstRow:v=>firstRow=v,frames,resizes};
}
test('iframe arrows and H/L send one switch/move and stop native/browser navigation',()=>{
  const h=harness();
  for(const [code,direction] of [['ArrowLeft',-1],['ArrowRight',1],['KeyH',-1],['KeyL',1]]){
    h.messages.length=0;const event=h.key(code);
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(h.messages.length,1);
    assert.equal(h.messages[0].type,'zellij-tab-step');assert.equal(h.messages[0].direction,direction);
  }
  h.messages.length=0;h.key('ArrowRight',{shiftKey:true});assert.equal(h.messages[0].type,'zellij-tab-move');
});
test('iframe modal and unrelated/modified keys keep native behavior',()=>{
  const h=harness();
  for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:false}])assert.equal(h.key('ArrowLeft',extra).prevented,undefined);
  assert.equal(h.key('Escape',{altKey:false}).prevented,undefined);
  h.setModal(true);assert.equal(h.key('ArrowLeft').prevented,undefined);assert.equal(h.messages.length,0);
});
test('native top and bottom crop independently and restore zero offsets',()=>{
  const h=harness();h.state();
  assert.equal(h.properties.get('--switchboard-tab-height'),'18px');assert.equal(h.properties.get('--switchboard-bottom-height'),'36px');
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-native-tabs',visible:true}});
  assert.equal(h.classes.has('switchboard-hide-tabs'),false);assert.equal(h.classes.has('switchboard-hide-status'),true);
  assert.equal(h.properties.get('--switchboard-tab-height'),'0px');
  h.setBottomRows(0);h.setFirstRow('agent output');h.state();
  assert.equal(h.classes.has('switchboard-hide-status'),false);assert.equal(h.properties.get('--switchboard-bottom-height'),'0px');
});

test("bottom-bar redraws do not trigger the resize feedback loop",()=>{
  const h=harness();h.state();h.resizes.length=0;
  for(const rows of [0,1,2,0,2]){h.setBottomRows(rows);h.state();}
  assert.equal(h.resizes.length,0);
});

test('terminal input waits for FocusPane acknowledgement',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false}});
  assert.equal(h.window.term.options.disableStdin,true);assert.equal(h.window.term.element.style.pointerEvents,'none');
  assert.equal(sent[0].pane_id,2);
  h.state({active_pane:{pane_id:1,is_plugin:false}});assert.equal(h.window.term.options.disableStdin,true);
  h.state({active_pane:{pane_id:2,is_plugin:false}});assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.window.term.element.style.pointerEvents,'');
});

test('fullscreen and mobile transitions clear a previous status clip',()=>{
  const window={},classes=new Set(),document={body:{append(){},classList:{contains:mode=>classes.has(mode)}}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/chrome.js','utf8'),{window,document});
  const screen={style:{}},term={rows:4,buffer:{active:{viewportY:0,getLine:index=>({translateToString:()=>index===3?'Ctrl + LOCK PANE TAB':''})}},_core:{screenElement:screen,_renderService:{dimensions:{css:{cell:{height:18}}}}}};
  assert.equal(window.__switchboardBottomRows(term,{}),1);assert.match(screen.style.clipPath,/18px/);
  window.__switchboardBottomRows(term,{render_prefs:{single_pane:true}});assert.equal(screen.style.clipPath,'');
  window.__switchboardBottomRows(term,{});classes.add('zj-mobile-active');window.__switchboardBottomRows(term,{});assert.equal(screen.style.clipPath,'');
});

test('rapid A to B to A waits for B then acknowledges the replacement A',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  const state=id=>h.state({active_pane:{pane_id:id,is_plugin:false}});
  const focus=(id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:id,is_plugin:false,focus_id}});
  state(1);focus(2,1);focus(1,2);assert.deepEqual(sent.map(x=>x.pane_id),[2]);assert.equal(h.window.term.options.disableStdin,true);
  state(1);assert.equal(h.window.term.options.disableStdin,true);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,true);
  state(2);assert.deepEqual(sent.map(x=>x.pane_id),[2,1]);assert.equal(h.window.term.options.disableStdin,true);
  state(1);assert.equal(h.window.term.options.disableStdin,false);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
});

test('a rejected focus retires its request and acknowledges the queued replacement',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  const focus=(pane_id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id,is_plugin:false,focus_id}});
  focus(2,1);focus(1,2);
  h.error('Unrelated clipboard error');assert.deepEqual(sent.map(x=>x.pane_id),[2]);assert.equal(h.window.term.options.disableStdin,true);
  h.error('Could not find pane with id: Terminal(2)');assert.deepEqual(sent.map(x=>x.pane_id),[2,1]);assert.equal(h.window.term.options.disableStdin,true);
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
});

test('a disappeared target releases input and reports the exact failed request',()=>{
  const h=harness();h.window.__zjSendControl=()=>{};
  const state={active_pane:{pane_id:1,is_plugin:false},panes:[{pane_id:1,is_plugin:false}]};h.state(state);
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false,focus_id:4}});
  h.state(state);
  const failure=h.messages.find(message=>message.type==='zellij-focus-failed');
  assert.equal(failure.focus_id,4);assert.equal(failure.payload.active_pane.pane_id,1);
  assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_pending,false);
});

test('disappearance cannot acknowledge the replacement focus dispatched by that same state',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  const panes=[{pane_id:1,is_plugin:false},{pane_id:2,is_plugin:false}],state={active_pane:panes[0],panes};h.state(state);
  const focus=(pane_id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id,is_plugin:false,focus_id}});
  focus(2,1);focus(1,2);
  h.state({...state,panes:[panes[0]]});
  assert.deepEqual(sent.map(command=>command.pane_id),[2,1]);assert.equal(h.window.term.options.disableStdin,true);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,true);
  h.state({...state,panes:[panes[0]]});assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_pending,false);
});
