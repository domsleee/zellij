// Loaded before the stock Zellij scripts, in each same-origin relay iframe.
(() => {
  if (window.SwitchboardClipboard) return;
  const host = location.pathname.split('/')[2];
  let terminal, pending = null, surface, manualText, notice, revision = 0;

  function report(result) {
    if (parent !== window) parent.postMessage({type: 'zellij-clipboard', host, ...result}, location.origin);
    return result;
  }

  function fallback(text, message) {
    if (!document.body) return;
    if (!surface) {
      surface = document.createElement('section');
      surface.setAttribute('aria-label', 'Clipboard');
      surface.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:10000;padding:12px;background:#20242c;color:white;border:1px solid #8291a8;border-radius:6px;font:14px system-ui';
      notice = document.createElement('p');
      notice.setAttribute('role', 'status');
      manualText = document.createElement('textarea');
      manualText.readOnly = true;
      manualText.setAttribute('aria-label', 'Text to copy manually');
      manualText.style.cssText = 'display:block;width:100%;box-sizing:border-box;height:80px;margin:8px 0';
      const retry = document.createElement('button');
      retry.textContent = 'Copy again';
      retry.onclick = () => retryPending();
      const select = document.createElement('button');
      select.textContent = 'Select text';
      select.onclick = () => { manualText.focus(); manualText.select(); };
      const dismiss = document.createElement('button');
      dismiss.textContent = 'Dismiss';
      dismiss.onclick = () => { surface.hidden = true; };
      surface.append(notice, manualText, retry, select, dismiss);
      document.body.append(surface);
    }
    notice.textContent = message + ' Use Copy again, or Select text and your browser’s Copy command.';
    manualText.value = text;
    surface.hidden = false;
    // An unsolicited remote copy must never steal focus from the terminal.
  }

  function clearFallback() {
    pending = null;
    if (surface) { surface.hidden = true; manualText.value = ''; }
  }

  function legacyCopy(text) {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    const focused = document.activeElement;
    const selection = window.getSelection?.();
    const ranges = [];
    if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:-10000px;top:0';
    document.body.append(field);
    try {
      field.focus();
      field.select();
      return document.execCommand('copy') === true;
    } catch (_) { return false; }
    finally {
      field.remove();
      focused?.focus({preventScroll: true});
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }

  async function copyText(text, source) {
    const attempt = ++revision;
    let error = 'Browser clipboard access is unavailable.';
    try {
      // The app's Copy button focuses the parent document. Use its clipboard
      // object so Chromium does not reject an unfocused iframe's write.
      const clipboard = parent.navigator?.clipboard || navigator.clipboard;
      if (typeof clipboard?.writeText === 'function') {
        await clipboard.writeText(text);
        if (attempt !== revision) return {ok: true, source, method: 'clipboard'};
        clearFallback();
        return report({ok: true, source, method: 'clipboard'});
      }
    } catch (_) { error = 'Browser clipboard access was denied.'; }
    if (attempt !== revision) return {ok: false, source, error, superseded: true};
    if (legacyCopy(text)) {
      clearFallback();
      return report({ok: true, source, method: 'browser-copy'});
    }
    pending = {text, source};
    fallback(text, error);
    return report({ok: false, source, error, manual: true});
  }

  function copySelection() {
    const text = (terminal || window.term)?.getSelection() || '';
    if (text) return copyText(text, 'selection');
    if (pending) return retryPending();
    return Promise.resolve(report({ok: false, source: 'selection', error: 'No terminal text selected. Hold Option on Mac or Shift on Windows/Linux while dragging to select.'}));
  }

  function retryPending() {
    if (pending) return copyText(pending.text, pending.source);
    return Promise.resolve(report({ok: false, source: 'osc52', error: 'No pending clipboard text.'}));
  }

  function isTerminalTarget(event) {
    const term = terminal || window.term;
    return !!term && (event.target === term.textarea || event.target === term.element ||
      (term.element?.contains(event.target) && !event.target.closest?.('input,textarea,[contenteditable="true"]')));
  }

  window.addEventListener('keydown', event => {
    if (!isTerminalTarget(event) || event.altKey || event.isComposing ||
      !(event.code === 'KeyC' || event.key?.toLowerCase() === 'c')) return;
    const commandCopy = event.metaKey && !event.ctrlKey && !event.shiftKey;
    const controlCopy = event.ctrlKey && !event.metaKey;
    if (!commandCopy && !controlCopy) return;
    const selected = (terminal || window.term)?.getSelection();
    // Preserve Ctrl+C as interrupt when there is no local terminal selection.
    if (controlCopy && !event.shiftKey && !selected) return;
    event.stopImmediatePropagation();
    if (controlCopy) {
      event.preventDefault();
      void copySelection();
    }
    // Cmd+C keeps its native copy event, bypassing the stock kitty handler.
  }, true);

  window.addEventListener('copy', event => {
    if (!isTerminalTarget(event)) return;
    const text = (terminal || window.term)?.getSelection();
    if (!text) return;
    if (!event.clipboardData) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void copyText(text, 'selection');
      return;
    }
    try {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopImmediatePropagation();
      ++revision;
      clearFallback();
      report({ok: true, source: 'selection', method: 'native-copy'});
    } catch (_) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void copyText(text, 'selection');
    }
  }, true);

  function installAddon(namespace) {
    const prototype = namespace?.ClipboardAddon?.prototype;
    if (!prototype || prototype.__switchboardClipboard) return;
    prototype.__switchboardClipboard = true;
    // Use the stock addon lifecycle, but consume OSC52 before its rejecting provider.
    prototype.activate = function(term) {
      terminal = term;
      term.options.macOptionClickForcesSelection = true;
      this._terminal = term;
      this._disposable = term.parser.registerOscHandler(52, data => {
        const separator = data.indexOf(';');
        if (separator < 0) return true;
        const target = data.slice(0, separator), encoded = data.slice(separator + 1);
        // Empty Pc means the default clipboard; p/s alone are X11 selections.
        if (target && !target.includes('c')) return true;
        // Queries are answered empty without exposing the viewing clipboard remotely.
        if (encoded === '?') { term.input(`\x1b]52;${target};\x07`, false); return true; }
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(encoded)) {
          report({ok: false, source: 'osc52', error: 'Remote copy contained invalid base64.'});
          return true;
        }
        let text;
        try {
          const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
          text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch (_) {
          report({ok: false, source: 'osc52', error: 'Remote copy contained invalid text.'});
          return true;
        }
        void copyText(text, 'osc52');
        // Never hold up terminal parsing while waiting for browser permissions.
        return true;
      });
    };
  }

  // The stock UMD script assigns this global after our injected script runs.
  let clipboardAddon = window.ClipboardAddon;
  installAddon(clipboardAddon);
  Object.defineProperty(window, 'ClipboardAddon', {
    configurable: true,
    get: () => clipboardAddon,
    set: value => { clipboardAddon = value; installAddon(value); }
  });
  window.SwitchboardClipboard = {copySelection, retryPending, get hasPending() { return !!pending; }};
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'zellij-copy') return;
    void copySelection();
  });
})();
