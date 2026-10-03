const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/static/clipboard.js', 'utf8');
const stockAddon = fs.readFileSync(__dirname + '/../../zellij-client/assets/addon-clipboard.js', 'utf8');

function harness({write = async () => {}, legacy = false} = {}) {
  const handlers = {}, messages = [], writes = [], inputs = [], nodes = [];
  let selection = '', osc, disposed = false;
  const document = {activeElement: null};
  function element(tag) {
    const node = {tag, children: [], style: {}, value: '', hidden: false, attributes: {},
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { document.activeElement = this; }, select() { this.selected = true; },
      remove() { this.removed = true; }, closest() { return tag === 'textarea' ? this : null; }};
    nodes.push(node);
    return node;
  }
  document.createElement = element;
  document.body = element('body');
  document.execCommand = () => legacy;
  const textarea = element('textarea');
  const terminalElement = element('div');
  terminalElement.contains = target => target === textarea;
  const term = {options: {}, textarea, element: terminalElement, getSelection: () => selection,
    input: (...args) => inputs.push(args),
    parser: {registerOscHandler(id, callback) {
      assert.equal(id, 52); osc = callback;
      return {dispose() { disposed = true; }};
    }}};
  document.activeElement = textarea;
  const parent = {postMessage: (message, origin) => messages.push({message, origin})};
  const window = {term, addEventListener(type, callback) { (handlers[type] ||= []).push(callback); }};
  const context = {window, self: window, document, parent,
    location: {origin: 'http://localhost:8090', pathname: '/hosts/mac/main'},
    navigator: {clipboard: write && {writeText(text) { writes.push(text); return write(text); }}},
    atob, TextDecoder, TextEncoder, Uint8Array};
  vm.runInNewContext(source, context);
  // Exercise the real stock UMD assignment and addon lifecycle, not a mock addon.
  vm.runInNewContext(stockAddon, context);
  const addon = new window.ClipboardAddon.ClipboardAddon();
  addon.activate(term);
  function event(type, extra = {}) {
    const e = {target: textarea, code: 'KeyC', key: 'c', ctrlKey: false, metaKey: false,
      altKey: false, shiftKey: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra};
    for (const callback of handlers[type] || []) callback(e);
    return e;
  }
  return {window, context, document, nodes, term, addon, messages, writes, inputs, event,
    setSelection(text) { selection = text; }, osc: text => osc(text),
    get disposed() { return disposed; }, api: window.SwitchboardClipboard};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const base64 = text => Buffer.from(text).toString('base64');

test('stock addon hook enables Mac selection and keeps its disposable lifecycle', () => {
  const h = harness();
  assert.equal(h.term.options.macOptionClickForcesSelection, true);
  h.addon.dispose();
  assert.equal(h.disposed, true);
});

test('native Cmd+C bypasses stock keys and fills the copy event', () => {
  const h = harness(); h.setSelection('selected Ω\nsecond line');
  for (const modifiers of [{metaKey: true}]) {
    const key = h.event('keydown', modifiers);
    assert.equal(key.stopped, true);
    assert.equal(key.prevented, undefined);
    const clipboard = new Map();
    const copy = h.event('copy', {clipboardData: {setData: (key, value) => clipboard.set(key, value)}});
    assert.equal(clipboard.get('text/plain'), 'selected Ω\nsecond line');
    assert.equal(copy.prevented, true);
    assert.equal(copy.stopped, true);
    assert.equal(h.messages.at(-1).message.method, 'native-copy');
  }
  assert.equal(h.writes.length, 0);
});

test('Ctrl+C interrupt, composing keys, unrelated modifiers and manual fields are preserved', () => {
  const h = harness();
  assert.equal(h.event('keydown', {ctrlKey: true}).stopped, undefined);
  h.setSelection('selection');
  for (const modifiers of [{metaKey: true, altKey: true}, {ctrlKey: true, isComposing: true},
    {metaKey: true, target: h.document.createElement('textarea')}]) {
    assert.equal(h.event('keydown', modifiers).stopped, undefined);
  }
});

test('selected Ctrl+C, Ctrl+Shift+C and app Copy write the viewing clipboard', async () => {
  const h = harness(); h.setSelection('selected Ω');
  const key = h.event('keydown', {ctrlKey: true, shiftKey: true});
  assert.equal(key.prevented, true); assert.equal(key.stopped, true);
  await settle();
  assert.deepEqual(h.writes, ['selected Ω']);
  const plain = h.event('keydown', {ctrlKey: true});
  assert.equal(plain.prevented, true); assert.equal(plain.stopped, true);
  await settle();
  assert.deepEqual(h.writes, ['selected Ω', 'selected Ω']);
  assert.equal((await h.api.copySelection()).ok, true);
  assert.equal(h.messages.at(-1).message.source, 'selection');
});

test('app Copy prefers the focused viewing parent clipboard over the iframe clipboard', async () => {
  const h = harness({write: async () => { throw Error('Unfocused iframe'); }});
  const parentWrites = [];
  h.context.parent.navigator = {clipboard: {writeText: async text => { parentWrites.push(text); }}};
  h.setSelection('viewer selection');
  assert.equal((await h.api.copySelection()).method, 'clipboard');
  assert.deepEqual(parentWrites, ['viewer selection']);
  assert.deepEqual(h.writes, []);
});

test('OSC52 handles unicode, default and combined clipboard selectors without stalling parsing', async () => {
  const h = harness();
  for (const selector of ['c', '', 'pc']) {
    assert.equal(h.osc(selector + ';' + base64('remote 🦀\n')), true);
    await settle();
  }
  assert.deepEqual(h.writes, ['remote 🦀\n', 'remote 🦀\n', 'remote 🦀\n']);
  assert.equal(h.messages.at(-1).message.source, 'osc52');
  assert.ok(h.messages.every(({message}) => !JSON.stringify(message).includes('remote 🦀')));
});

test('malformed OSC52 does not clear clipboard; primary selections ignored; reads answer empty', () => {
  const h = harness();
  for (const payload of ['c;not;base64', 'c;A', 'c;/w==', 'p;' + base64('primary'), 'no separator']) {
    assert.equal(h.osc(payload), true);
  }
  assert.deepEqual(h.writes, []);
  assert.equal(h.osc('c;?'), true);
  assert.equal(h.osc(';?'), true);
  assert.deepEqual(h.inputs.map(args => Array.from(args)), [['\x1b]52;c;\x07', false], ['\x1b]52;;\x07', false]]);
});

test('denied remote copy offers manual text without stealing focus; app Copy retries it', async () => {
  let allowed = false;
  const h = harness({write: async () => { if (!allowed) throw Error('Denied'); }});
  const focused = h.document.activeElement;
  assert.equal(h.osc('c;' + base64('retain me')), true);
  await settle();
  assert.equal(h.api.hasPending, true);
  assert.equal(h.document.activeElement, focused);
  const result = h.messages.at(-1).message;
  assert.equal(result.ok, false); assert.equal(result.manual, true);
  const field = h.nodes.find(node => node.attributes['aria-label'] === 'Text to copy manually');
  assert.equal(field.value, 'retain me'); assert.equal(field.readOnly, true);
  allowed = true;
  assert.equal((await h.api.copySelection()).ok, true);
  assert.equal(h.api.hasPending, false); assert.equal(field.value, '');
});

test('unavailable API uses successful browser copy; false execCommand stays an honest failure', async () => {
  for (const legacy of [true, false]) {
    const h = harness({write: null, legacy}); h.setSelection('text');
    const result = await h.api.copySelection();
    assert.equal(result.ok, legacy);
    assert.equal(h.document.activeElement, h.term.textarea);
    if (legacy) assert.equal(result.method, 'browser-copy');
    else assert.equal(result.manual, true);
  }
});

test('no selection reports failure and never writes empty text', async () => {
  const h = harness();
  assert.equal((await h.api.copySelection()).ok, false);
  assert.match(h.messages.at(-1).message.error, /No terminal text selected/);
  assert.deepEqual(h.writes, []);
});

test('only the same-origin parent can request app copying', async () => {
  const h = harness(); h.setSelection('app selection');
  h.event('message', {origin: 'https://other.example', source: h.context.parent, data: {type: 'zellij-copy'}});
  h.event('message', {origin: h.context.location.origin, source: {}, data: {type: 'zellij-copy'}});
  assert.deepEqual(h.writes, []);
  h.event('message', {origin: h.context.location.origin, source: h.context.parent, data: {type: 'zellij-copy'}});
  await settle();
  assert.deepEqual(h.writes, ['app selection']);
});

test('late failures from old writes cannot replace newer successful copy with stale fallback', async () => {
  let rejectOld;
  const h = harness({write: text => text === 'old' ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve()});
  h.osc('c;' + base64('old'));
  h.osc('c;' + base64('new'));
  await settle();
  rejectOld(Error('old failure'));
  await settle();
  assert.equal(h.api.hasPending, false);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.ok, true);
});
