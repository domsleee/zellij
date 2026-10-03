// Crop only the native Zellij status plugin, never an agent's prompt or footer.
(() => {
  const modes = /\b(?:LOCK|UNLOCK|PANE|TAB|RESIZE|MOVE|SEARCH|SESSION|TMUX|QUIT)\b/g;
  const shortModes = /(?:<[^>]+>\s*)(?:Lo|Un|Pa|Ta|Re|Mo|Se|Qu)\b/g;
  function isModeBar(line) {
    const labels = line.match(modes) || [];
    const shortLabels = line.match(shortModes) || [];
    return (/\b(?:Ctrl|Alt|Super)\b|\^C|\^A/.test(line) && new Set(labels).size >= 2)
      || shortLabels.length >= 3;
  }
  window.__switchboardBottomRows = (term, state) => {
    const screen = term?._core?.screenElement || term?.element?.querySelector('.xterm-screen');
    if (!term?.buffer?.active || !term.rows || state?.render_prefs?.single_pane
      || document.body?.classList.contains('zj-mobile-active')) {
      if(screen)screen.style.clipPath='';
      return 0;
    }
    const buffer = term.buffer.active;
    const row = offset => buffer.getLine(buffer.viewportY + term.rows - offset)?.translateToString(true) || '';
    // Classic layouts reserve two rows; current layouts reserve one. Identify
    // the mode selector first so a changing tip or clipboard hint stays hidden.
    // Another attached client may make Zellij render fewer rows than this xterm.
    // Clip from the actual status row, including unused rows beneath it, while
    // requesting only the one/two native rows back (no resize feedback loop).
    const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
    let offset = 0;
    for (let n = 1; n <= term.rows; n++) if (isModeBar(row(n))) { offset = n; break; }
    if (screen) screen.style.clipPath = offset && cellHeight ? `inset(0 0 ${offset * cellHeight}px 0)` : '';
    if (offset) return offset === 1 ? 1 : 2;
    // Locked mode replaces the selectors with this fixed stock-plugin message.
    // Require the native top bar as a second signal before hiding this row.
    const top = buffer.getLine(buffer.viewportY)?.translateToString(true) || '';
    if (/^\s*Zellij\s*\(/.test(top) && /^\s*(?:--\s*)?INTERFACE LOCKED(?:\s*--)?\s*$/.test(row(1))) {
      if(screen && cellHeight)screen.style.clipPath=`inset(0 0 ${cellHeight}px 0)`;
      return 1;
    }
    return 0;
  };
})();
