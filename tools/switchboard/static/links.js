// Open links in the viewing browser, synchronously within the user's gesture.
(() => {
  const host = location.pathname.split('/')[2];
  const config = window.__switchboardLinkHosts?.[host];
  const localHost = name => ['localhost','127.0.0.1','[::1]','::1'].includes(name);
  function resolve(uri) {
    const url = new URL(uri, location.href);
    if (!['http:','https:','mailto:'].includes(url.protocol)) throw Error('Unsupported link type');
    if (config && (localHost(url.hostname) || url.hostname === new URL(config.origin).hostname)) {
      const target = config.artifacts?.[url.port || (url.protocol==='https:'?'443':'80')];
      if (target) {
        const root = new URL(target);
        root.pathname = root.pathname.replace(/\/$/,'') + url.pathname;
        root.search = url.search; root.hash = url.hash;
        return root.href;
      }
      // This requires the artifact server to listen on LAN. An actual tunnel can
      // be supplied in artifact_urls without changing terminal link behavior.
      if(localHost(url.hostname) && !config.local)url.hostname = new URL(config.origin).hostname;
    }
    return url.href;
  }
  function open(event,uri) {
    if (!event.shiftKey || event.button!==0) return;
    event.preventDefault();event.stopImmediatePropagation();
    try {
      const target=resolve(uri);
      if(parent!==window)parent.postMessage({type:'zellij-open-link',uri:target},location.origin);
      else location.assign(target);
    } catch(error) { console.warn('Switchboard link:',error.message); }
  }
  function atPointer(event,term) {
    const core=term?._core, linkifier=core?.linkifier || core?._linkifier2;
    const position=linkifier?._positionFromMouseEvent?.(event,term.element,core._mouseService);
    if(!position)return null;
    const contains=link=>{
      const start=link.range.start.y*term.cols+link.range.start.x;
      const end=link.range.end.y*term.cols+link.range.end.x;
      const point=position.y*term.cols+position.x;
      return start<=point&&point<=end;
    };
    const cached=linkifier?._currentLink?.link;
    if(cached&&contains(cached))return cached.text;
    let found;
    const providers=core?._linkProviderService?.linkProviders || core?._linkifier2?._linkProviders || [];
    for(const provider of providers){
      provider.provideLinks(position.y,links=>{if(!found)found=links?.find(contains)?.text;});
      if(found)break;
    }
    return found;
  }
  let down;
  window.addEventListener('mousedown',event=>{
    if(!event.shiftKey||event.button!==0||!event.target.closest?.('#terminal'))return;
    const uri=atPointer(event,window.term);
    if(uri){down={uri,x:event.clientX,y:event.clientY};event.preventDefault();event.stopImmediatePropagation();}
  },true);
  window.addEventListener('mouseup',event=>{
    const previous=down;down=null;
    if(!previous||!event.shiftKey||event.button!==0)return;
    if(Math.hypot(event.clientX-previous.x,event.clientY-previous.y)>5)return;
    open(event,previous.uri);
  },true);
  window.addEventListener('blur',()=>{down=null;});
  const timer=setInterval(()=>{
    const term=window.term;if(!term)return;clearInterval(timer);
    if(term.options.linkHandler)term.options.linkHandler={...term.options.linkHandler,activate:open};
    for(const entry of term._addonManager?._addons || []){
      const addon=entry.instance;
      if(addon?._linkProvider?._handler){addon._handler=open;addon._linkProvider._handler=open;}
    }
  },25);
  window.__switchboardResolveLink=resolve;
})();
