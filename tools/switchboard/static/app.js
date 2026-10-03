const $ = id => document.getElementById(id);
const hosts = new Map(), sessions = new Map();
const tabButtons=new Map();
let filter = 'all', selected = null, loading = false, dragging = false;
const dragType='application/x-zellij-switchboard-tab';
let dragState=null, dragScrollFrame=0, suppressTabClickUntil=0;
function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
const groups = load('switchboard-groups');
const ready = load('switchboard-ready');
let tabOrder=load('switchboard-tab-order');
if(!Array.isArray(tabOrder))tabOrder=[];
let nativeTabs = localStorage.getItem('switchboard-native-tabs') === 'true';
function updateNativeTabs() {
  $('native-tabs').setAttribute('aria-pressed',String(nativeTabs));
  $('native-tabs').classList.toggle('selected',nativeTabs);
  for (const entry of sessions.values()) entry.frame.contentWindow.postMessage({type:'zellij-native-tabs',visible:nativeTabs},location.origin);
}
function saveReady() { localStorage.setItem('switchboard-ready', JSON.stringify(ready)); }
function setStatus(message,isError=false) {
  $('status').textContent=message;$('status').classList.toggle('has-error',isError);
  $('notifications').title=`${$('notifications').textContent}\n${message}`;
}
function sessionKey(host, name) { return JSON.stringify([host, name]); }
function tabKey(entry, tab) {
  // 0.45.1 has no stable tab ID in its web payload; prefer a pane ID over position.
  const pane = entry.state.panes.find(p => p.tab_position === tab.position);
  return JSON.stringify([entry.host, entry.name, pane?.pane_id ?? tab.position, !!pane?.is_plugin]);
}
function allTabs(ignoreFilter=false) {
  const ranks=new Map(tabOrder.map((key,index)=>[key,index]));
  return [...sessions.values()].flatMap(entry => (entry.state?.tabs || []).map(tab => ({entry,tab,key:tabKey(entry,tab)})))
    .filter(({entry}) => ignoreFilter || filter === 'all' || groups[entry.host] === filter)
    .sort((a,b) => Number(!!(ready[b.key] || b.tab.name.startsWith('*'))) - Number(!!(ready[a.key] || a.tab.name.startsWith('*'))) || (ranks.get(a.key)??Infinity)-(ranks.get(b.key)??Infinity) || (ready[b.key] || 0)-(ready[a.key] || 0));
}
function moveTab(key,targetKey,after=false) {
  if(key===targetKey)return;
  const order=allTabs(true).map(t=>t.key);
  if(!order.includes(key)||!order.includes(targetKey))return;
  order.splice(order.indexOf(key),1);
  order.splice(order.indexOf(targetKey)+(after?1:0),0,key);
  tabOrder=order;localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));render();
  tabButtons.get(key)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function moveSelected(direction) {
  const tabs=allTabs(),index=tabs.findIndex(t=>t.key===selected),target=tabs[index+direction];
  if(index<0||!target)return;
  moveTab(selected,target.key,direction>0);
}
function render() {
  // Live metadata arrives while dragging; keep the source element mounted.
  if(dragging)return;
  const tabs = allTabs();
  const previous = selected;
  if (!tabs.some(t => t.key === selected)) selected = tabs[0]?.key || null;
  const liveKeys=new Set(tabs.map(item=>item.key));
  for(const [key,button] of tabButtons)if(!liveKeys.has(key)){button.remove();tabButtons.delete(key);}
  for (const [index,item] of tabs.entries()) {
    let button=tabButtons.get(item.key);
    if(!button){
      button=document.createElement('button');button.draggable=true;
      const star=document.createElement('span');star.className='star';star.textContent='* ';
      const name=document.createElement('span');name.className='tab-name';
      const label=document.createElement('small');button.append(star,name,label);
      button.ondragstart=event=>{
        dragging=true;
        dragState={key:button._item.key,ready:!!(ready[button._item.key]||button._item.tab.name.startsWith('*')),clientX:event.clientX,target:null};
        event.dataTransfer.setData(dragType,dragState.key);event.dataTransfer.effectAllowed='move';
        button.classList.add('dragging');$('tabs').classList.add('reordering');
      };
      button.ondragend=finishDrag;
      button.onclick=()=>{if(dragging||Date.now()<suppressTabClickUntil)return;activate(button._item);};
      tabButtons.set(item.key,button);
    }
    button._item=item;
    const title=SwitchboardTitles.tabTitle(item.entry.state,item.tab);
    button.title=`${title}\nDrag to reorder · Alt+Shift+Left/Right or H/L moves this tab · Ready tabs stay first`;
    const starred = ready[item.key] || item.tab.name.startsWith('*');
    button.className = item.key === selected ? 'selected' : '';
    button.setAttribute('aria-pressed',String(item.key===selected));
    button.children[0].hidden=!starred;
    if(button.children[1].textContent!==title)button.children[1].textContent=title;
    const subtitle=`${hosts.get(item.entry.host)?.name || item.entry.host} · ${item.entry.name}`;
    if(button.children[2].textContent!==subtitle)button.children[2].textContent=subtitle;
    if($('tabs').children[index]!==button)$('tabs').insertBefore(button,$('tabs').children[index]||null);
  }
  const current=tabs.find(t=>t.key===selected);
  const notifications=allTabs(true).filter(item=>ready[item.key]||item.tab.name.startsWith('*')).length;
  $('notifications').textContent=`${notifications} notification${notifications===1?'':'s'}`;
  $('notifications').classList.toggle('has-notifications',notifications>0);
  document.title=`${notifications?'('+notifications+') ':''}`+(current?`${SwitchboardTitles.tabTitle(current.entry.state,current.tab)} — ${hosts.get(current.entry.host)?.name} · Switchboard`:'Zellij Switchboard');
  for (const entry of sessions.values()) entry.frame.classList.toggle('active',entry===current?.entry);
  $('ready').disabled=!current;
  $('empty').hidden=!!current;
  if (!current) $('empty').textContent=filter==='all'?'No connected tabs. Check Machines or refresh.':`No ${filter} tabs. Assign machines to this group using Machines.`;
  const errors=[...hosts.values()].filter(h=>h.error).map(h=>`${h.name}: ${h.error}`);
  setStatus(errors.length?errors.join(' · '):`${hosts.size} machines · ${tabs.length} tabs${current?' · '+hosts.get(current.entry.host)?.name:''}`,errors.length>0);
  if (selected !== previous && current) focus(current);
  if(selected!==previous) $('tabs').querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function updateDragTarget() {
  if(!dragState)return;
  const strip=$('tabs'),bounds=strip.getBoundingClientRect();
  const candidates=[...strip.children].filter(button=>button._item&&button._item.key!==dragState.key&&!!(ready[button._item.key]||button._item.tab.name.startsWith('*'))===dragState.ready);
  const next=candidates.find(button=>{const rect=button.getBoundingClientRect();return dragState.clientX<rect.left+rect.width/2;});
  const target=next||candidates.at(-1);
  if(!target){dragState.target=null;strip.classList.remove('drop-target');return;}
  const after=!next,rect=target.getBoundingClientRect();
  dragState.target={key:target._item.key,after};
  strip.style.setProperty('--drop-left',`${(after?rect.right+2:rect.left-3)-bounds.left+strip.scrollLeft}px`);
  strip.classList.add('drop-target');
}
function scrollDuringDrag() {
  dragScrollFrame=0;
  if(!dragState||!$('tabs').classList.contains('drop-target'))return;
  const strip=$('tabs'),bounds=strip.getBoundingClientRect(),edge=36;
  const left=Math.max(0,edge-(dragState.clientX-bounds.left));
  const right=Math.max(0,edge-(bounds.right-dragState.clientX));
  strip.scrollLeft+=Math.max(-14,Math.min(14,(right-left)/3));
  updateDragTarget();
  dragScrollFrame=requestAnimationFrame(scrollDuringDrag);
}
$('tabs').addEventListener('dragover',event=>{
  if(!dragState||!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';dragState.clientX=event.clientX;
  updateDragTarget();if(!dragScrollFrame)dragScrollFrame=requestAnimationFrame(scrollDuringDrag);
});
$('tabs').addEventListener('dragleave',event=>{
  if(event.relatedTarget&&$('tabs').contains(event.relatedTarget))return;
  $('tabs').classList.remove('drop-target');cancelAnimationFrame(dragScrollFrame);dragScrollFrame=0;
});
$('tabs').addEventListener('drop',event=>{
  if(!dragState||!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();dragState.clientX=event.clientX;updateDragTarget();
  const {key,target}=dragState;
  finishDrag();if(target)moveTab(key,target.key,target.after);
});
function finishDrag(){
  if(!dragging)return;
  dragging=false;dragState=null;suppressTabClickUntil=Date.now()+250;
  cancelAnimationFrame(dragScrollFrame);dragScrollFrame=0;
  $('tabs').classList.remove('reordering','drop-target');
  for(const button of tabButtons.values())button.classList.remove('dragging');
  render();
}
window.addEventListener('dragend',finishDrag,true);
window.addEventListener('drop',()=>setTimeout(finishDrag,0),true);
window.addEventListener('blur',finishDrag);
function focus(item) {
  item.entry.needsFocus=false;
  $('artifact-preview').hidden=true;
  $('artifact-frame').src='about:blank';
  const active=item.entry.state.active_pane;
  const pane=item.entry.state.panes.find(p=>p.tab_position===item.tab.position && p.pane_id===active?.pane_id && p.is_plugin===active?.is_plugin)
    || item.entry.state.panes.find(p=>p.tab_position===item.tab.position);
  if(pane){
    const focusId=item.entry.focusId=(item.entry.focusId||0)+1;
    if(item.entry.requestedPane || active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.requestedPane={pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId};
    item.entry.frame.contentWindow.postMessage({type:'zellij-focus',pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId},location.origin);
  }
}
function activate(item, clear=true) {
  selected=item.key;
  if(clear){delete ready[item.key];saveReady();}
  render();
  focus(item);
}
function stepTab(direction) {
  const tabs=allTabs();
  if(!tabs.length)return;
  const index=tabs.findIndex(t=>t.key===selected);
  activate(tabs[(Math.max(index,0)+direction+tabs.length)%tabs.length]);
}
window.addEventListener('keydown',event=>{
  if(event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
  if($('new-tab-dialog').open)return;
  if(event.key==='Escape'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    if(!$('artifact-preview').hidden){event.preventDefault();$('artifact-back').click();return;}
    if(!$('machines').hidden)return;
    const current=allTabs().find(item=>item.key===selected);
    if(current){event.preventDefault();event.stopImmediatePropagation();current.entry.frame.contentWindow.postMessage({type:'zellij-escape'},location.origin);current.entry.frame.focus();}
    return;
  }
  if(!event.altKey||event.ctrlKey||event.metaKey)return;
  const direction=['KeyH','ArrowLeft'].includes(event.code)?-1:['KeyL','ArrowRight'].includes(event.code)?1:0;
  if(!direction)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.shiftKey)moveSelected(direction);else stepTab(direction);
},true);
function renderMachines() {
  $('machines').replaceChildren();
  for(const host of hosts.values()) {
    const label=document.createElement('label');label.append(document.createTextNode(host.name));
    const select=document.createElement('select');select.setAttribute('aria-label',`${host.name} group`);
    for(const [value,text] of [['','Ungrouped'],['work','Work'],['home','Home']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
    select.value=groups[host.id]||'';
    select.onchange=()=>{groups[host.id]=select.value;localStorage.setItem('switchboard-groups',JSON.stringify(groups));render();};label.append(select);$('machines').append(label);
  }
}
async function refresh() {
  if(loading)return;loading=true;
  try {
    const response=await fetch('/api/hosts');if(!response.ok)throw Error('Cannot reach local relay');
    const data=await response.json();
    for(const host of data) {
      hosts.set(host.id,host);
      for(const session of host.sessions||[]) {
        if(!session.web_clients_allowed)continue;
        const key=sessionKey(host.id,session.name);
        if(sessions.has(key))continue;
        const frame=document.createElement('iframe');frame.title=`${host.name}: ${session.name}`;
        frame.src=`/hosts/${encodeURIComponent(host.id)}/${encodeURIComponent(session.name)}`;
        frame.allow='clipboard-read; clipboard-write';
        const entry={host:host.id,name:session.name,frame,state:null};sessions.set(key,entry);$('terminals').append(frame);
      }
      if(!host.error) for(const [key,entry] of sessions) {
        if(entry.host===host.id&&!host.sessions.some(s=>s.name===entry.name)) {entry.frame.remove();sessions.delete(key);}
      }
    }
    renderMachines();render();
  }catch(error){setStatus(error.message,true);}finally{loading=false;}
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  const entry=[...sessions.values()].find(e=>e.frame.contentWindow===event.source);
  if(!entry)return;
  if(event.data?.type==='zellij-state') {
    const previousPosition=entry.state?.active_pane?.tab_position;
    entry.state=event.data.payload;
    if(entry.requestedPane){
      const active=entry.state.active_pane,requested=entry.requestedPane;
      if(!event.data.focus_pending && event.data.focus_id===requested.focus_id && active?.pane_id===requested.pane_id&&active?.is_plugin===requested.is_plugin)entry.requestedPane=null;
    }
    if(entry.pendingNewTab){
      const added=entry.state.tabs.find(tab=>!entry.pendingNewTab.has(tabKey(entry,tab)));
      if(added){
        entry.pendingNewTab=null;
        if(filter!=='all'&&groups[entry.host]!==filter)setFilter('all');
        selected=tabKey(entry,added);
      }
    }
    entry.frame.contentWindow.postMessage({type:'zellij-native-tabs',visible:nativeTabs},location.origin);
    // A client can switch sessions using native Zellij controls; follow its metadata.
    if(entry.name!==entry.state.session_name){
      sessions.delete(sessionKey(entry.host,entry.name));
      entry.name=entry.state.session_name;
      const key=sessionKey(entry.host,entry.name), duplicate=sessions.get(key);
      if(duplicate&&duplicate!==entry)duplicate.frame.remove();
      sessions.set(key,entry);
    }
    if(!entry.requestedPane && entry.frame.classList.contains('active') && previousPosition!==undefined && previousPosition!==entry.state.active_pane?.tab_position){
      const tab=entry.state.tabs.find(t=>t.position===entry.state.active_pane?.tab_position);
      if(tab){selected=tabKey(entry,tab);delete ready[selected];saveReady();}
    }
    render();
    if(entry.needsFocus && entry.frame.classList.contains('active')){
      const current=allTabs().find(item=>item.key===selected);if(current)focus(current);
    }
  }else if(event.data?.type==='zellij-focus-failed'){
    if(entry.requestedPane?.focus_id!==event.data.focus_id)return;
    entry.requestedPane=null;
    if(!entry.frame.classList.contains('active'))return;
    const state=event.data.payload || entry.state;
    const tab=state?.tabs.find(tab=>tab.position===state.active_pane?.tab_position);
    if(tab){entry.state=state;selected=tabKey(entry,tab);render();focus({entry,tab});}
    setStatus('That terminal is unavailable. Choose another tab.',true);
  }else if(event.data?.type==='zellij-tab-step' && (event.data.direction===-1||event.data.direction===1)){
    if(entry.frame.classList.contains('active'))stepTab(event.data.direction);
  }else if(event.data?.type==='zellij-tab-move' && (event.data.direction===-1||event.data.direction===1)){
    if(entry.frame.classList.contains('active'))moveSelected(event.data.direction);
  }else if(event.data?.type==='zellij-open-link'){
    if(!entry.frame.classList.contains('active'))return;
    try{
      const url=new URL(event.data.uri);
      if(!['http:','https:'].includes(url.protocol))return;
      if(url.origin===location.origin){setStatus('Artifact links must use a separate server port.',true);return;}
      $('artifact-url').textContent=url.href;$('artifact-url').title='If embedding is blocked, use Open in browser tab.';
      $('artifact-external').href=url.href;$('artifact-frame').src=url.href;
      $('artifact-preview').hidden=false;$('artifact-back').focus();
    }catch(_){setStatus('Invalid artifact link.',true);}
  }else if(event.data?.type==='zellij-clipboard'){
    setStatus(event.data.ok?'Copied to this browser.':event.data.error||'Copy failed; use the terminal’s clipboard panel.',!event.data.ok);
  }else if(event.data?.type==='zellij-disconnected'){entry.needsFocus=true;setStatus(`${hosts.get(entry.host)?.name}: reconnecting…`,true);}
});
$('artifact-back').onclick=()=>{const current=allTabs().find(item=>item.key===selected);if(current)focus(current);else $('artifact-preview').hidden=true;};
$('copy').onclick=async()=>{
  const current=allTabs().find(item=>item.key===selected);
  const api=current?.entry.frame.contentWindow.SwitchboardClipboard;
  if(!api){setStatus('Terminal clipboard is unavailable; refresh this page.',true);return;}
  const result=await api.copySelection();
  setStatus(result.ok?'Copied to this browser.':result.error||'Nothing selected. Select terminal text first.',!result.ok);
};
function setFilter(value){filter=value;for(const b of $('filters').children)b.classList.toggle('selected',b.dataset.filter===value);render();}
$('filters').onclick=event=>{const button=event.target.closest('[data-filter]');if(button)setFilter(button.dataset.filter);};
$('new-tab').onclick=()=>{
  const select=$('new-tab-target');select.replaceChildren();
  const current=allTabs().find(t=>t.key===selected)?.entry;
  for(const [key,entry] of sessions){
    if(!entry.state)continue;
    const option=document.createElement('option');option.value=key;option.textContent=`${hosts.get(entry.host)?.name} · ${entry.name}`;option.selected=entry===current;select.append(option);
  }
  if(!select.options.length){setStatus('Connect to a session before creating a tab.',true);return;}
  $('new-tab-dialog').showModal();
};
$('cancel-new-tab').onclick=()=>$('new-tab-dialog').close();
$('new-tab-form').onsubmit=event=>{
  event.preventDefault();const entry=sessions.get($('new-tab-target').value);if(!entry?.state)return;
  entry.pendingNewTab=new Set(entry.state.tabs.map(tab=>tabKey(entry,tab)));
  entry.frame.contentWindow.postMessage({type:'zellij-new-tab'},location.origin);
  $('new-tab-dialog').close();setStatus(`Creating a tab on ${hosts.get(entry.host)?.name}…`);
  setTimeout(()=>{if(entry.pendingNewTab){entry.pendingNewTab=null;setStatus('No new tab received. Check the connection and try again.',true);}},10000);
};
$('ready').onclick=()=>{
  if(!selected)return;
  ready[selected]=Date.now();saveReady();
  tabOrder=[selected,...allTabs(true).map(t=>t.key).filter(key=>key!==selected)];
  localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));render();
};
$('settings').onclick=()=>{$('machines').hidden=!$('machines').hidden;$('settings').setAttribute('aria-expanded',String(!$('machines').hidden));};
$('refresh').onclick=refresh;
$('native-tabs').onclick=()=>{nativeTabs=!nativeTabs;localStorage.setItem('switchboard-native-tabs',String(nativeTabs));updateNativeTabs();};
updateNativeTabs();
refresh();setInterval(refresh,15000);
