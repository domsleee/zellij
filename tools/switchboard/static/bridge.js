// Reuse the stock web client and expose only metadata and explicit focus commands.
(() => {
  const NativeSocket = window.WebSocket;
  const host = location.pathname.split('/')[2];
  let latest;
  let escapeQueue = Promise.resolve();
  let escapeStatus;
  let pendingFocus, desiredFocus, focusInputState, focusId;
  function dispatchFocus() {
    pendingFocus=desiredFocus;
    window.__zjSendControl({type:'FocusPane',pane_id:pendingFocus.pane_id,is_plugin:pendingFocus.is_plugin});
  }
  function releaseFocus() {
    if(focusInputState && window.term){
      window.term.options.disableStdin=focusInputState.disabled;
      window.term.element.style.pointerEvents=focusInputState.pointer;
    }
    if(pendingFocus && escapeStatus)showEscapeStatus('');
    pendingFocus=null;desiredFocus=null;focusInputState=null;
  }
  function rejectFocus() {
    if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin){
      pendingFocus=null;dispatchFocus();
      return;
    }
    releaseFocus();
    parent.postMessage({type:'zellij-focus-failed',host,focus_id:focusId,payload:latest},location.origin);
    showEscapeStatus('That terminal is unavailable. Choose another tab.',true);
  }
  function hasDialog() {
    if (document.querySelector('dialog[open], .security-modal, [aria-modal="true"]')) return true;
    try { return !!parent.document?.querySelector('dialog[open], .security-modal, [aria-modal="true"]'); }
    catch (_) { return false; }
  }
  function terminalFocused() {
    const active = document.activeElement;
    return !!active && (window.term?.element?.contains(active) ||
      active === window.__zjSoftKbdCapture?.element);
  }
  function showEscapeStatus(message, failed = false) {
    if (!escapeStatus) {
      escapeStatus = document.createElement('div');
      escapeStatus.setAttribute('role', 'status');
      escapeStatus.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:10000;max-width:90%;padding:8px 12px;border-radius:6px;background:#282828;color:white;font:13px system-ui;pointer-events:none';
      document.body.append(escapeStatus);
    }
    escapeStatus.textContent = message;
    escapeStatus.style.background = failed ? '#8b2525' : '#282828';
    escapeStatus.hidden = !message;
  }
  function sendEscape() {
      if(pendingFocus){showEscapeStatus('Waiting for the selected terminal to receive focus.',true);return;}
      const target = {session:latest?.session_name, pane_id:latest?.active_pane?.pane_id};
      if (!target.session || !Number.isInteger(target.pane_id)) {
        showEscapeStatus('Escape failed: terminal state is unavailable.', true);
        return;
      }
      showEscapeStatus('Sending Escape…');
      escapeQueue = escapeQueue.then(async () => {
        try {
          const response = await fetch(`/api/hosts/${host}/escape`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(target),
          });
          if (!response.ok) throw new Error((await response.text()).slice(0, 240) || `HTTP ${response.status}`);
          showEscapeStatus('');
        } catch (error) {
          showEscapeStatus(`Escape failed: ${error.message}`, true);
        }
      });
  }
  window.addEventListener('keydown',event=>{
    if(hasDialog())return;
    if(event.code === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.isComposing && terminalFocused()) {
      // Stock web 0.45.1 loses bare ESC during idle finalization. The relay
      // writes byte 27 directly to the terminal identified by current metadata.
      const pane = latest?.active_pane;
      if (pane?.is_plugin) return;
      event.preventDefault();event.stopImmediatePropagation();
      sendEscape();
      return;
    }
    if(!event.altKey||event.ctrlKey||event.metaKey)return;
    // Physical key codes also work with macOS Option producing ˙ and ¬.
    const direction=['KeyH','ArrowLeft'].includes(event.code)?-1:['KeyL','ArrowRight'].includes(event.code)?1:0;
    if(!direction)return;
    event.preventDefault();event.stopImmediatePropagation();
    parent.postMessage({type:event.shiftKey?'zellij-tab-move':'zellij-tab-step',host,direction},location.origin);
  },true);
  let showNativeTabs = localStorage.getItem('switchboard-native-tabs') === 'true';
  let hookedTerm;
  const style = document.createElement('style');
  style.textContent = `
    body.switchboard-hide-tabs:not(.zj-mobile-active),
    body.switchboard-hide-status:not(.zj-mobile-active) { overflow: hidden; }
    body.switchboard-hide-tabs:not(.zj-mobile-active) #terminal,
    body.switchboard-hide-status:not(.zj-mobile-active) #terminal {
      margin-top: calc(-1 * var(--switchboard-tab-height, 0px));
      height: calc(var(--dynamic-vh, 100vh) + var(--switchboard-tab-height, 0px));
    }
  `;
  document.head.append(style);
  function updateChrome() {
    const term = window.term;
    if (!term || !document.body) return;
    if (hookedTerm !== term) {
      hookedTerm = term;
      term.onRender(updateChrome);
      term.onResize(updateChrome);
      new MutationObserver(updateChrome).observe(document.body,{attributes:true,attributeFilter:['class']});
    }
    // Only crop an identified native bar. Fullscreen panes and alternate layouts
    // without the bar keep every terminal row. Mobile owns its own viewport.
    const firstRow = term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true) || '';
    const hide = !showNativeTabs && /^\s*Zellij\s*\(/.test(firstRow) && !document.body.classList.contains('zj-mobile-active');
    const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
    const bottomRows = window.__switchboardBottomRows?.(term, latest) || 0;
    const hideBottom = bottomRows > 0 && !!cellHeight;
    const oldHeight = document.documentElement.style.getPropertyValue('--switchboard-tab-height');
    const oldBottomHeight = document.documentElement.style.getPropertyValue('--switchboard-bottom-height');
    const height = hide && cellHeight ? `${cellHeight}px` : '0px';
    const bottomHeight = hideBottom ? `${bottomRows * cellHeight}px` : '0px';
    const changed = document.body.classList.contains('switchboard-hide-tabs') !== hide ||
      document.body.classList.contains('switchboard-hide-status') !== hideBottom ||
      oldHeight !== height || oldBottomHeight !== bottomHeight;
    if (!changed) return;
    document.documentElement.style.setProperty('--switchboard-tab-height',height);
    document.documentElement.style.setProperty('--switchboard-bottom-height',bottomHeight);
    document.body.classList.toggle('switchboard-hide-tabs',hide);
    document.body.classList.toggle('switchboard-hide-status',hideBottom);
    // Let the stock fit/resize handler allocate the extra row and report it to
    // the server. xterm's shifted bounds also keep mouse coordinates correct.
    // Bottom clipping must not resize: a resize briefly clears the status row,
    // which otherwise alternates the crop and sends another resize forever.
    if(oldHeight !== height)requestAnimationFrame(()=>window.dispatchEvent(new Event('zellij:rendering-resize')));
  }
  function sendState(payload) {
    latest = payload;
    const missingFocus=pendingFocus && Array.isArray(latest.panes) && !latest.panes.some(pane=>pane.pane_id===pendingFocus.pane_id && pane.is_plugin===pendingFocus.is_plugin);
    if(missingFocus)rejectFocus();
    if(!missingFocus && pendingFocus && latest.active_pane?.pane_id===pendingFocus.pane_id && latest.active_pane?.is_plugin===pendingFocus.is_plugin){
      if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin)dispatchFocus();
      else{releaseFocus();window.term?.focus();}
    }
    parent.postMessage({type: 'zellij-state', host, payload, focus_id:focusId, focus_pending:!!pendingFocus}, location.origin);
    requestAnimationFrame(updateChrome);
  }
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes('/ws/control')) {
        this.addEventListener('message', event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'MobileState') sendState(message.payload);
            if (message.type === 'LogError') {
              window.__zjLastControlError = message.lines;
              // Unrelated control errors must not acknowledge an in-flight focus.
              if(pendingFocus && message.lines?.some(line=>line.includes(`Could not find pane with id: ${pendingFocus.is_plugin?'Plugin':'Terminal'}(${pendingFocus.pane_id})`)))rejectFocus();
            }
          } catch (_) {}
        });
        this.addEventListener('close', () => {
          latest = undefined;
          releaseFocus();
          parent.postMessage({type:'zellij-disconnected',host},location.origin);
        });
      }
    }
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const message = event.data;
    if (message?.type === 'zellij-focus' && window.__zjSendControl) {
      focusId=message.focus_id;
      if (pendingFocus || latest?.active_pane?.pane_id !== message.pane_id || latest?.active_pane?.is_plugin !== message.is_plugin){
        desiredFocus={pane_id:message.pane_id,is_plugin:message.is_plugin};
        if(window.term?.element){
          focusInputState ||= {disabled:window.term.options.disableStdin,pointer:window.term.element.style.pointerEvents};
          window.term.options.disableStdin=true;window.term.element.style.pointerEvents='none';window.term.blur();
          showEscapeStatus('Switching terminal…');
        }
        if(!pendingFocus)dispatchFocus();
      }else{releaseFocus();window.term?.focus();if(latest)sendState(latest);}
    } else if (message?.type === 'zellij-escape' && !hasDialog()) {
      window.term?.focus();
      if(!latest?.active_pane?.is_plugin)sendEscape();
    } else if (message?.type === 'zellij-native-tabs') {
      showNativeTabs = !!message.visible;
      updateChrome();
    } else if (message?.type === 'zellij-new-tab' && window.__zjSendControl) {
      window.__zjSendControl({type:'NewTab'});
    } else if (message?.type === 'zellij-request-state' && latest) sendState(latest);
  });
})();
