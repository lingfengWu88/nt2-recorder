let starting=false;
function isAllowedPage(address){
  try{
    const url=new URL(address);
    return url.protocol==='https:' && (
      url.hostname==='nt2-oefenomgeving.facet.onl' ||
      (url.hostname==='oefenexamensnt2.nl' && url.pathname.startsWith('/facet-player-openbaar/'))
    );
  }catch{return false;}
}
const safeName=s=>String(s).normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'_').slice(0,60)||'NT2';
function configOf(c){
  const n=(key,min,max)=>{const x=Number(c[key]);if(!Number.isInteger(x)||x<min||x>max)throw Error(`${key} 必须在 ${min}–${max} 之间`);return x;};
  const config={prefix:safeName(c.prefix),start:n('start',1,99999),count:n('count',1,20),seconds:n('seconds',10,600),nextText:c.nextText.trim(),playText:c.playText.trim()};
  if(config.count>1&&!config.nextText)throw Error('批量录制必须填写下一题按钮的实际完整文字');
  return config;
}
// Only interact with visible, uniquely matched controls. No guessed coordinates.
async function control(tabId,text,click=false){
  const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:(text,click)=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim();
    const matches=[...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')].filter(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&[el.innerText,el.getAttribute('aria-label'),el.value,el.getAttribute('title')].some(v=>norm(v)===norm(text));
    });
    return matches.map(el=>({disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true'}));
  },args:[text,false]});
  const hits=results.flatMap(r=>(r.result||[]).map(m=>({...m,frameId:r.frameId})));
  if(hits.length!==1)throw Error(`按钮“${text}”找到 ${hits.length} 个匹配；必须恰好 1 个。可能在跨域框架内，或文字不正确。`);
  if(hits[0].disabled)throw Error(`按钮“${text}”尚不可点击。请增加每题录制时长，或手动处理当前页面。`);
  if(click){
    const result=await chrome.scripting.executeScript({target:{tabId,frameIds:[hits[0].frameId]},func:text=>{
      const norm=s=>(s||'').replace(/\s+/g,' ').trim();
      const els=[...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&[el.innerText,el.getAttribute('aria-label'),el.value,el.getAttribute('title')].some(v=>norm(v)===norm(text));});
      if(els.length!==1||els[0].disabled||els[0].getAttribute('aria-disabled')==='true')throw Error('按钮状态改变，停止');
      els[0].click();return true;
    },args:[text]});
    if(!result[0]?.result)throw Error('未能点击按钮');
  }
  return true;
}
async function ensureOffscreen(){
  const existing=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if(!existing.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS'],justification:'用户主动录制题目标签页并将视频保存到本机'});
}
async function download(url,filename){
  const id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:'uniquify'});
  // Wait for a completed download before releasing its blob URL or starting another item.
  for(let i=0;i<120;i++){
    const [d]=await chrome.downloads.search({id});
    if(d?.state==='complete')return id;
    if(!d||d.state==='interrupted')throw Error('保存失败：'+(d?.error||'下载被取消'));
    await new Promise(r=>setTimeout(r,500));
  }
  throw Error('保存超过 60 秒；请检查下载提示和磁盘空间');
}
async function handle(m){
  if(m.type==='status'){await chrome.storage.local.set({status:m.status});await chrome.action.setBadgeText({text:m.status.running?'REC':''});return;}
  if(m.type==='download')return download(m.url,m.filename);
  if(m.type==='control')return control(m.tabId,m.text,true);
  if(m.type==='stop'){await ensureOffscreen();return chrome.runtime.sendMessage({to:'offscreen',type:'stop'});}
  const cfg=configOf(m.config);
  if(m.type==='check'){
    if(!cfg.nextText&&!cfg.playText)throw Error('请填写至少一个实际按钮文字');
    if(cfg.nextText)await control(m.tabId,cfg.nextText);
    if(cfg.playText)await control(m.tabId,cfg.playText);
    return {message:'按钮检查通过（没有点击）。仍需两题试录验证翻题和播放。'};
  }
  if(m.type==='start'){
    if(starting)throw Error('正在启动，请稍候');starting=true;
    try{
      await ensureOffscreen();
      const state=await chrome.runtime.sendMessage({to:'offscreen',type:'state'});
      if(state.running)throw Error('已有录制正在运行，请先停止');
      const tab=await chrome.tabs.get(m.tabId);
      if(!isAllowedPage(tab.url))throw Error('请在 NT2 题目播放标签页中点击扩展。支持 oefenexamensnt2.nl/facet-player-openbaar/ 和 nt2-oefenomgeving.facet.onl。');
      if(cfg.playText)await control(m.tabId,cfg.playText);
      await chrome.storage.local.set({config:cfg});
      const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:m.tabId});
      const res=await chrome.runtime.sendMessage({to:'offscreen',type:'start',streamId,tabId:m.tabId,config:cfg});
      if(!res.ok)throw Error(res.error);
      return {message:'录制已启动。未设置播放按钮时，请现在手动播放第一题。'};
    }finally{starting=false;}
  }
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.to!=='worker')return;
  handle(m).then(value=>reply({ok:true,...(value&&typeof value==='object'?value:{value})})).catch(e=>reply({ok:false,error:e.message}));return true;
});
