(function(root) {
  const spinner=/^[✳✻✽✶✢·⏺⠁-⣿]+\s*/u;
  function tabTitle(state, tab) {
    const panes=state.panes.filter(p=>p.tab_position===tab.position && !p.is_plugin);
    const active=state.active_pane;
    const pane=panes.find(p=>p.pane_id===active?.pane_id && active.tab_position===tab.position)||panes[0];
    const title=pane?.title?.trim()||'';
    const agent=spinner.test(title)||/^(codex|claude)(\s*[-:|]|$)/i.test(title);
    const shell=!title||/^(~|\/|[A-Za-z]:[\\/])/.test(title)||/^(nu|zsh|bash|fish|pwsh|powershell|cmd)(\.exe)?$/i.test(title);
    const useTitle=agent||(/^\*?\s*Tab #\d+$/.test(tab.name)&&!shell);
    const label=useTitle?title.replace(spinner,'').replace(/^(codex|claude)\s*[-:]\s*/i,'').trim():tab.name;
    return label.replace(/^\*\s*/,'')||tab.name;
  }
  root.SwitchboardTitles={tabTitle};
  if(typeof module!=='undefined')module.exports=root.SwitchboardTitles;
})(globalThis);
