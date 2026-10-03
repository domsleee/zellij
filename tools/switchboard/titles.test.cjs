const assert=require('node:assert/strict');
const {tabTitle}=require('./static/titles.js');
function state(title){return {panes:[{tab_position:0,pane_id:4,title,is_plugin:false}],active_pane:{tab_position:0,pane_id:4}};}
const tab={position:0,name:'Tab #5'};
assert.equal(tabTitle(state('codex - ssb orchestrator | ssb-recomp'),tab),'ssb orchestrator | ssb-recomp');
assert.equal(tabTitle(state('codex - renamed chat | ssb-recomp'),tab),'renamed chat | ssb-recomp');
assert.equal(tabTitle(state('✳ disk-cleaner installation'),{...tab,name:'old explicit name'}),'disk-cleaner installation');
assert.equal(tabTitle(state('✻ new name'),tab),'new name');
assert.equal(tabTitle(state('~\\git\\ssb-recomp'),{...tab,name:'my shell'}),'my shell');
assert.equal(tabTitle(state(''),tab),'Tab #5');
const multi={panes:[{tab_position:0,pane_id:1,title:'✳ first chat'},{tab_position:0,pane_id:2,title:'codex - second chat'}],active_pane:{tab_position:0,pane_id:2}};
assert.equal(tabTitle(multi,tab),'second chat');
console.log('Title updates, explicit names, shell fallback, and focused-pane titles passed.');
