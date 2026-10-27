let starting=false;
const advancing=new Map();
const DEFAULT_AUTOMATION_BATCH_SIZE=20;
const MAX_AUTOMATION_BATCH_SIZE=100;
const DEFAULT_BATCHES_PER_RUN=5;
const MAX_BATCHES_PER_RUN=100;
const AUTOMATION_CHECKPOINT_KEY='automationCheckpoint';
const VIDEO_FPS_PRESETS=[2,5,10,15,20,30];
const AUDIO_BITRATE_PRESETS=[24000,48000,64000,96000];
function presetOf(value,presets,fallback,label){
  const parsed=Number(value??fallback);
  if(!presets.includes(parsed))throw Error(`${label}设置无效；请从扩展提供的预设中选择。`);
  return parsed;
}
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
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function isPortalPage(address){
  try{const url=new URL(address);return url.protocol==='https:'&&url.hostname==='oefenexamensnt2.nl'&&url.pathname==='/facet-openbaar-portaal/oefenen/opdrachten';}
  catch{return false;}
}
function configOf(c){
  const start=Number(c.start);
  if(!Number.isInteger(start)||start<1||start>99999)throw Error('起始编号必须在 1–99999 之间');
  return {
    ...c,
    prefix:safeName(c.prefix),
    start,
    videoFps:presetOf(c.videoFps,VIDEO_FPS_PRESETS,5,'视频帧率'),
    audioBitrate:presetOf(c.audioBitrate,AUDIO_BITRATE_PRESETS,48000,'音频码率')
  };
}
function automationBatchSizeOf(value){
  const batchSize=Number(value??DEFAULT_AUTOMATION_BATCH_SIZE);
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>MAX_AUTOMATION_BATCH_SIZE)throw Error(`每场题目数必须是 1–${MAX_AUTOMATION_BATCH_SIZE} 之间的整数。`);
  return batchSize;
}
function batchesPerRunOf(value){
  const batchesPerRun=Number(value??DEFAULT_BATCHES_PER_RUN);
  if(!Number.isInteger(batchesPerRun)||batchesPerRun<1||batchesPerRun>MAX_BATCHES_PER_RUN)throw Error(`每次运行批次数必须是 1–${MAX_BATCHES_PER_RUN} 之间的整数。`);
  return batchesPerRun;
}
async function saveAutomationCheckpoint(checkpoint){
  await chrome.storage.local.set({[AUTOMATION_CHECKPOINT_KEY]:{...checkpoint,updatedAt:Date.now()}});
}
async function getAutomationCheckpoint(){
  const data=await chrome.storage.local.get(AUTOMATION_CHECKPOINT_KEY);
  return data[AUTOMATION_CHECKPOINT_KEY]||null;
}
async function setAutomationStatus(text,running=true,phase='PORTAL_AUTOMATION'){
  await chrome.storage.local.set({status:{text,running,phase,time:Date.now()}});
  await chrome.action.setBadgeText({text:running?'AUTO':''});
}
async function getAuthorizedTabStreamId(tabId){
  return chrome.tabCapture.getMediaStreamId({targetTabId:tabId});
}
async function prepareTabCapture(tabId){
  const tab=await chrome.tabs.get(tabId);
  if(!isPortalPage(tab.url))throw Error(`请在官方题目选择页启动自动流程；当前标签页不是受支持的 NT2 Portal（${tab.url||'URL 不可用'}）。`);
  const [activeTab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(activeTab?.id!==tabId)throw Error('请先切换到 NT2 题目选择页，再从该标签页点击扩展，以授权 Chrome 捕获此标签页。');
  await setAutomationStatus('CAPTURE_INITIALIZING：正在按 Chrome 授权准备当前 NT2 标签页……',true,'CAPTURE_INITIALIZING');
  await ensureOffscreen();
  const state=await chrome.runtime.sendMessage({to:'offscreen',type:'state'});
  if(state.running)throw Error('已有录制正在运行，无法初始化新的标签页捕获。');
  if(state.preparedTabId===tabId){
    if(!state.captureActive)throw Error('此前准备的标签页捕获流已结束；请停止并重新启动自动流程。');
    await setAutomationStatus('CAPTURE_READY：当前 NT2 标签页捕获已准备就绪。',true,'CAPTURE_READY');
    return;
  }
  if(state.preparedTabId!=null)throw Error('Offscreen 中已有属于其他标签页的捕获流；请停止旧任务后重试。');
  // Obtain the stream ID only while handling the user's initial action, then
  // consume it immediately in the offscreen document before portal navigation.
  const streamId=await getAuthorizedTabStreamId(tabId);
  const prepared=await chrome.runtime.sendMessage({to:'offscreen',type:'prepare',tabId,streamId});
  if(!prepared?.ok||prepared.preparedTabId!==tabId||!prepared.captureActive)throw Error(prepared?.error||'Chrome 标签页捕获流未能在导航前准备完成。');
  await setAutomationStatus('CAPTURE_READY：Chrome 已授权并保持当前标签页捕获流。',true,'CAPTURE_READY');
}
async function beginRecording(tabId,rawConfig,requirePreparedCapture=false){
  const cfg=configOf(rawConfig);
  let recordingStarted=false,frameId=null;
  try{
    const tab=await chrome.tabs.get(tabId);
    if(!isAllowedPage(tab.url))throw Error('目标标签页不是受支持的 NT2 播放页面。');
    const buttons=await findNextButton(tabId);
    if(buttons.length!==1)throw Error(`VOLGENDE 按钮找到 ${buttons.length} 个匹配；必须恰好一个。`);
    if(!buttons[0].disabled)throw Error('第一道题的 VOLGENDE 尚未禁用；未开始录制以免漏掉开头。');
    frameId=buttons[0].frameId;
    const crop=await findContentCrop(tabId,frameId);
    await ensureOffscreen();
    const state=await chrome.runtime.sendMessage({to:'offscreen',type:'state'});
    if(state.running)throw Error('已有录制正在运行，请先停止');
    await chrome.storage.local.set({config:cfg});
    if(requirePreparedCapture&&state.preparedTabId!==tabId)throw Error('导航前准备的 Chrome 捕获流不存在或不属于当前考试标签页；为避免未授权捕获，没有在 Vraag 1 重新请求权限。');
    if(state.preparedTabId===tabId&&!state.captureActive)throw Error('导航前准备的 Chrome 捕获流已结束；没有在 Vraag 1 重新请求权限。');
    if(state.preparedTabId!=null&&state.preparedTabId!==tabId)throw Error('已准备的捕获流属于其他标签页，拒绝开始录制。');
    const streamId=state.preparedTabId===tabId?undefined:await getAuthorizedTabStreamId(tabId);
    const res=await chrome.runtime.sendMessage({to:'offscreen',type:'start',streamId,tabId,config:cfg,crop});
    if(!res.ok)throw Error(res.error);
    recordingStarted=true;
    await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},files:['observer.js']});
    await chrome.storage.session.set({session:{tabId,frameId}});
    const observerResult=await chrome.tabs.sendMessage(tabId,{to:'observer',type:'start'},{frameId});
    if(!observerResult?.ok)throw Error('无法启动 VOLGENDE 状态监测');
    return {message:'录制已启动，正在检测第一题 VOLGENDE 状态。'};
  }catch(e){
    if(frameId!=null)await stopObserver(tabId,frameId);
    await chrome.storage.session.remove('session');
    if(recordingStarted)await chrome.runtime.sendMessage({to:'offscreen',type:'stop'});
    throw e;
  }
}
async function playerFrames(tabId){
  const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{
    const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
    const nodes=[...document.querySelectorAll('button,[role="button"],[role="radio"],input[type="button"],input[type="submit"],[tabindex]:not([tabindex="-1"])')].filter(el=>{
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
    });
    return {text:(document.body?.innerText||'').slice(0,10000),buttons:nodes.map(el=>({
      text:normalize(el.innerText),
      aria:normalize(el.getAttribute('aria-label')),
      title:normalize(el.title),
      disabled:Boolean(el.disabled||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true')
    }))};
  }});
  return results.map(result=>({frameId:result.frameId,...result.result})).filter(frame=>frame.text);
}
function normalizeControlLabel(value){
  return String(value||'').normalize('NFKC').toLocaleUpperCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function controlMatches(button,label){
  const wanted=normalizeControlLabel(label);
  return [button.text,button.aria,button.title].some(value=>normalizeControlLabel(value)===wanted);
}
async function waitForPlayerState(tabId,predicate,label,timeout=45000){
  const deadline=Date.now()+timeout;
  let latest=[];
  while(Date.now()<deadline){
    try{latest=await playerFrames(tabId);const hit=latest.find(predicate);if(hit)return hit;}
    catch(error){latest=[{text:String(error),buttons:[]}];}
    await delay(300);
  }
  const visible=latest.map(frame=>`文字: ${(frame.text||'').replace(/\s+/g,' ').slice(-500)}；控件: ${(frame.buttons||[]).map(button=>[button.text,button.aria,button.title].filter(Boolean).join('/')).filter(Boolean).join(', ')}`).join(' | ');
  throw Error(`等待“${label}”超时。可见页面诊断：${visible||'没有可读取的播放器框架内容'}。请确认当前步骤及 Chrome 麦克风权限提示。`);
}
async function clickPlayerControl(tabId,label,marker){
  const frame=await waitForPlayerState(tabId,state=>
    (!marker||marker.test(state.text))&&state.buttons.some(button=>controlMatches(button,label)&&!button.disabled),label);
  const results=await chrome.scripting.executeScript({target:{tabId,frameIds:[frame.frameId]},func:label=>{
    const norm=value=>String(value||'').normalize('NFKC').toLocaleUpperCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
    const selector='button,[role="button"],[role="radio"],input[type="button"],input[type="submit"],[tabindex]:not([tabindex="-1"])';
    const matches=[...document.querySelectorAll(selector)].filter(el=>{
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&
        [el.innerText,el.getAttribute('aria-label'),el.value,el.title].some(value=>norm(value)===norm(label));
    });
    if(matches.length!==1)throw Error(`“${label}”匹配数为 ${matches.length}，未点击。`);
    const button=matches[0];
    if(button.disabled||button.matches(':disabled')||button.getAttribute('aria-disabled')==='true')throw Error(`“${label}”当前不可用。`);
    button.click();return true;
  },args:[label]});
  if(!results[0]?.result)throw Error(`无法点击“${label}”。`);
}
async function clickPlayerExactText(tabId,label,marker){
  const frame=await waitForPlayerState(tabId,state=>
    (!marker||marker.test(state.text))&&state.text.toLocaleUpperCase().includes(label.toLocaleUpperCase()),label);
  const results=await chrome.scripting.executeScript({target:{tabId,frameIds:[frame.frameId]},func:label=>{
    const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleUpperCase();
    const visible=element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0;
    };
    const exact=[...document.querySelectorAll('body *')].filter(element=>visible(element)&&
      [element.innerText,element.getAttribute('aria-label'),element.getAttribute('title'),element.value].some(value=>normalize(value)===normalize(label)));
    const leaves=exact.filter(element=>![...element.querySelectorAll('*')].some(child=>exact.includes(child)));
    if(leaves.length!==1)throw Error(`“${label}”可见精确匹配 ${leaves.length} 个，未点击。`);
    const target=leaves[0];
    if(target.closest(':disabled,[aria-disabled="true"]'))throw Error(`“${label}”当前不可用。`);
    target.click();
    return true;
  },args:[label]});
  if(!results[0]?.result)throw Error(`无法点击“${label}”。`);
}
async function clickNextOnPlayer(tabId,marker){
  await clickPlayerControl(tabId,'VOLGENDE',marker);
}
async function waitForNewPlayer(portalTabId,beforeIds){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
    const tabs=await chrome.tabs.query({currentWindow:true});
    const matches=tabs.filter(tab=>isAllowedPage(tab.url)&&new URL(tab.url).pathname.startsWith('/facet-player-openbaar/'));
    const newTab=matches.find(tab=>!beforeIds.has(tab.id));
    if(newTab){
      console.info('[NT2 Recorder] Official site opened the player in a separate tab.',{portalTabId,playerTabId:newTab.id});
      return newTab;
    }
    const sameTab=matches.find(tab=>tab.id===portalTabId);
    if(sameTab){
      console.info('[NT2 Recorder] Official site navigated the selection tab to the player.',{playerTabId:sameTab.id});
      return sameTab;
    }
    await delay(300);
  }
  throw Error('Start 已点击，但未找到 NT2 播放器页面。请确认浏览器没有拦截新标签页。');
}
async function automatePortal(tabId,config,selectionQuestions=null,allQuestions=null,batchOffset=0,batchesThisRun=0,expectedQuestions=null){
  const batchSize=automationBatchSizeOf(config.batchSize);
  if(!isPortalPage((await chrome.tabs.get(tabId)).url))throw Error('请先打开官方“Opdrachten oefenen”题目选择页。');
  await chrome.scripting.executeScript({target:{tabId},files:['portal.js']});
  await delay(300);
  await setAutomationStatus('正在核对项目、题型和题目标题……',true,'PORTAL_AUTOMATION');
  const prepared=await chrome.tabs.sendMessage(tabId,{to:'portal',type:'prepare',config:{...config,...(selectionQuestions?{selectionQuestions}: {}),...(expectedQuestions?{expectedQuestions}: {})}});
  if(!prepared?.ok)throw Error(prepared?.error||'题目选择失败');
  allQuestions=allQuestions||prepared.allQuestions;
  if(!Array.isArray(allQuestions)||!allQuestions.length)throw Error('官网题目清单无效或为空；没有启动考试。');
  if(!expectedQuestions){
    const checkpoint=await getAutomationCheckpoint();
    if(!checkpoint){
      await saveAutomationCheckpoint({config,allQuestions,nextQuestionOffset:batchOffset,completedBatches:Math.ceil(batchOffset/batchSize)});
    }
  }
  const nextIndex=batchOffset+prepared.count;
  const recordingConfig={...config,start:Number(config.start)+batchOffset};
  await chrome.storage.session.set({automation:{config,allQuestions,nextIndex,batchOffset,batchesThisRun}});
  const batchNumber=Math.floor(batchOffset/batchSize)+1,totalBatches=Math.ceil(allQuestions.length/batchSize);
  await setAutomationStatus(`已选择第 ${batchNumber}/${totalBatches} 批 ${prepared.count} 道题（筛选共 ${allQuestions.length} 道）；正在启动官方考试页面……`);
  const beforeTabs=await chrome.tabs.query({currentWindow:true});
  const beforeIds=new Set(beforeTabs.map(tab=>tab.id));
  const started=await chrome.tabs.sendMessage(tabId,{to:'portal',type:'start'});
  if(!started?.ok)throw Error(started?.error||'官网未能启动练习');
  const player=await waitForNewPlayer(tabId,beforeIds);
  const playerTabId=player.id;

  const isQuestionOne=state=>/vraag\s+1\s+van\s+\d+/i.test(state.text);
  const hasNext=state=>state.buttons.some(button=>controlMatches(button,'VOLGENDE')&&!button.disabled);

  // Treat each onboarding page as a distinct state. In particular, never
  // interpret a generic VOLGENDE button as proof that setup is complete.
  await waitForPlayerState(playerTabId,state=>/\bcontrole\b/i.test(state.text)&&hasNext(state),'Controle 页面');
  await setAutomationStatus('Controle 页面已就绪；正在点击 VOLGENDE……',true,'EXAM_PREPARATION');
  await clickNextOnPlayer(playerTabId,/\bcontrole\b/i);

  await waitForPlayerState(playerTabId,state=>/geluid\s+instellen/i.test(state.text),'Geluid instellen 页面');
  await setAutomationStatus('正在跳过声音示例并选择“Geluid is goed”……',true,'EXAM_PREPARATION');
  await clickPlayerExactText(playerTabId,'Geluid is goed',/geluid\s+instellen/i);
  await clickNextOnPlayer(playerTabId,/geluid\s+instellen/i);

  await waitForPlayerState(playerTabId,state=>/microfoon\s+instellen/i.test(state.text),'Microfoon instellen 页面');
  await setAutomationStatus('正在选择“Opname is goed”；如 Chrome 请求麦克风权限，请在浏览器提示中允许。',true,'EXAM_PREPARATION');
  await clickPlayerExactText(playerTabId,'Opname is goed',/microfoon\s+instellen/i);
  await clickNextOnPlayer(playerTabId,/microfoon\s+instellen/i);

  await waitForPlayerState(playerTabId,state=>/\bstart\b/i.test(state.text)&&hasNext(state),'Start 页面');
  await setAutomationStatus('Start 页面已就绪；正在点击 VOLGENDE……',true,'EXAM_PREPARATION');
  await clickNextOnPlayer(playerTabId,/\bstart\b/i);

  await waitForPlayerState(playerTabId,isQuestionOne,'第一道实际考试题 Vraag 1 van x');
  await setAutomationStatus('Vraag 1 已就绪；正在使用导航前准备的捕获流自动开始录制……',true,'RECORDING');
  try{
    await beginRecording(playerTabId,recordingConfig,true);
  }catch(error){
    throw Error(`Vraag 1 已就绪，但 Chrome 未允许自动捕获此标签页：${error.message}。请从官方题目选择页打开扩展启动流程，并确认播放器留在同一标签页和同一网站来源（origin）。`);
  }
}
async function startNextAutomationBatch(completedPlayerTabId){
  const {automation}=await chrome.storage.session.get('automation');
  if(!automation)return 'complete';
  if(!Array.isArray(automation.allQuestions))throw Error('批次题目清单格式已过期；请重新启动自动流程。');
  if(automation.nextIndex>=automation.allQuestions.length){
    await chrome.storage.session.remove('automation');
    await chrome.storage.local.remove(AUTOMATION_CHECKPOINT_KEY);
    await setAutomationStatus(`全部 ${automation.allQuestions.length} 道匹配题目已完成录制。`,false);
    return 'complete';
  }
  if(automation.batchesThisRun>=batchesPerRunOf(automation.config?.batchesPerRun)){
    await chrome.storage.session.remove('automation');
    await waitForOffscreenIdle(true);
    await returnTabToPortal(completedPlayerTabId);
    const checkpoint=await getAutomationCheckpoint();
    const completedBatches=checkpoint?.completedBatches||0;
    await setAutomationStatus(`已完成本次 ${automation.batchesThisRun} 批；进度 ${completedBatches}/${Math.ceil(automation.allQuestions.length/automationBatchSizeOf(automation.config.batchSize))} 批。已暂停，点击“继续”可从第 ${automation.nextIndex+1} 道题恢复。`,false,'PAUSED');
    return 'paused';
  }
  const portalTabId=completedPlayerTabId;
  const offset=automation.nextIndex;
  const batchSize=automationBatchSizeOf(automation.config?.batchSize);
  const selectionQuestions=automation.allQuestions.slice(offset,offset+batchSize);
  await setAutomationStatus(`本批已完成，准备下一批 ${offset+1}–${offset+selectionQuestions.length} / ${automation.allQuestions.length}……`,true,'PORTAL_AUTOMATION');
  console.info('[NT2 Recorder] Reusing the completed player tab for the next batch to preserve its tab-scoped capture authorization.',{completedPlayerTabId,portalTabId,offset});
  await returnTabToPortal(portalTabId);
  await automatePortal(portalTabId,automation.config,selectionQuestions,automation.allQuestions,offset,automation.batchesThisRun);
  return 'continued';
}
async function waitForOffscreenIdle(requireReleasedCapture=false){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const state=await chrome.runtime.sendMessage({to:'offscreen',type:'state'}).catch(()=>null);
    if(state&&!state.running&&(!requireReleasedCapture||state.preparedTabId==null))return;
    await delay(100);
  }
  throw Error('录制流未能及时结束；为避免破坏捕获状态，流程没有继续切换页面。');
}
async function returnTabToPortal(tabId){
  await chrome.tabs.update(tabId,{url:'https://oefenexamensnt2.nl/facet-openbaar-portaal/oefenen/opdrachten'});
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete'&&isPortalPage(tab.url))return;
    await delay(200);
  }
  throw Error('无法在已授权的播放器标签页打开官方题目选择页。');
}
async function resumeAutomation(tabId){
  const checkpoint=await getAutomationCheckpoint();
  if(!checkpoint)throw Error('没有找到可继续的保存进度。');
  const {config,allQuestions,nextQuestionOffset}=checkpoint;
  if(!Array.isArray(allQuestions)||!allQuestions.length||!Number.isInteger(nextQuestionOffset)||nextQuestionOffset<0||nextQuestionOffset>allQuestions.length)throw Error('保存的进度无效；请开始新流程。');
  if(nextQuestionOffset===allQuestions.length){
    await chrome.storage.local.remove(AUTOMATION_CHECKPOINT_KEY);
    await setAutomationStatus(`全部 ${allQuestions.length} 道匹配题目已完成录制。`,false,'COMPLETED');
    return {message:'此流程已完成；已清除保存的进度。'};
  }
  await prepareTabCapture(tabId);
  const offset=nextQuestionOffset;
  const batchSize=automationBatchSizeOf(config.batchSize);
  const selectionQuestions=allQuestions.slice(offset,offset+batchSize);
  try{
    await automatePortal(tabId,config,selectionQuestions,allQuestions,offset,0,allQuestions);
    return {message:`已从第 ${offset+1} 道题继续；本次最多运行 ${batchesPerRunOf(config.batchesPerRun)} 批。`};
  }catch(error){
    const {running:recording,preparedTabId}=await chrome.runtime.sendMessage({to:'offscreen',type:'state'}).catch(()=>({}));
    if(!recording&&preparedTabId===tabId)await chrome.runtime.sendMessage({to:'offscreen',type:'cancel-capture'}).catch(()=>{});
    throw error;
  }
}
async function findNextButton(tabId){
  const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{
    const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().toLocaleUpperCase();
    const selector='button,[role="button"],input[type="button"],input[type="submit"],a';
    const matches=[...document.querySelectorAll(selector)].filter(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      const labels=[element.innerText,element.getAttribute('aria-label'),element.value,element.getAttribute('title')];
      return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&labels.some(value=>normalize(value)==='VOLGENDE');
    });
    return matches.map(element=>({disabled:Boolean(element.disabled||element.matches(':disabled')||element.getAttribute('aria-disabled')==='true')}));
  }});
  return results.flatMap(result=>(result.result||[]).map(button=>({...button,frameId:result.frameId})));
}
async function findContentCrop(tabId,frameId){
  const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},func:()=>{
    const app=document.querySelector('.app-player')||document.querySelector('#app');
    const header=app?.querySelector('.app-header,header');
    const footer=app?.querySelector('footer,[role="contentinfo"]');
    if(!app||!header||!footer)throw Error('未能定位播放器内容区域的页眉和页脚');
    const headerRect=header.getBoundingClientRect(),footerRect=footer.getBoundingClientRect();
    const bandTop=Math.max(headerRect.bottom,0),bandBottom=Math.min(footerRect.top,innerHeight);
    // Crop the question card itself (including its natural whitespace), not a
    // union of text/control bounds: long prompt lines can span almost the page.
    const candidates=[...app.querySelectorAll('*')].filter(element=>
      !header.contains(element)&&!footer.contains(element)&&
      !element.matches('.app-header,header,footer,[role="contentinfo"]')
    ).map(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      const hasBorder=['Top','Right','Bottom','Left'].some(side=>
        parseFloat(style[`border${side}Width`])>0&&style[`border${side}Style`]!=='none'
      );
      const hasShadow=style.boxShadow!=='none';
      const background=style.backgroundColor.match(/[\d.]+/g)?.map(Number)||[];
      const opaqueWhite=background.length>=3&&background[0]>235&&background[1]>235&&background[2]>235&&Number(background[3]??1)>0.8;
      return {rect,hasBorder,hasShadow,opaqueWhite};
    }).filter(({rect,hasBorder,hasShadow,opaqueWhite})=>
      rect.width>=innerWidth*0.55&&rect.width<=innerWidth*0.995&&
      rect.height>=80&&rect.top>=bandTop-6&&rect.bottom<=bandBottom+6&&
      (hasBorder||hasShadow)&&opaqueWhite
    );
    if(!candidates.length)throw Error('未能识别播放器中央白色问题卡片；为避免录入题号或导航，已拒绝录制');
    // Select the largest bordered/shadowed white card between the player header and footer.
    candidates.sort((a,b)=>b.rect.width*b.rect.height-a.rect.width*a.rect.height);
    const card=candidates[0].rect;
    const left=Math.max(0,card.left),right=Math.min(innerWidth,card.right);
    const top=Math.max(bandTop,card.top),bottom=Math.min(bandBottom,card.bottom);
    if(right-left<40||bottom-top<40)throw Error('播放器问题内容面板尺寸过小，无法安全裁剪');
    let x=left,y=top,width=right-left,height=bottom-top;
    let view=window;
    while(view!==view.parent){
      const frame=view.frameElement;
      if(!frame)throw Error('无法从播放器框架计算内容裁剪位置');
      const frameRect=frame.getBoundingClientRect();
      const scaleX=frameRect.width/frame.offsetWidth,scaleY=frameRect.height/frame.offsetHeight;
      if(!Number.isFinite(scaleX)||!Number.isFinite(scaleY)||scaleX<=0||scaleY<=0)throw Error('播放器框架缩放无效，无法裁剪');
      x=frameRect.left+frame.clientLeft*scaleX+x*scaleX;
      y=frameRect.top+frame.clientTop*scaleY+y*scaleY;
      width*=scaleX;height*=scaleY;
      view=view.parent;
    }
    return {x,y,width,height,viewportWidth:view.innerWidth,viewportHeight:view.innerHeight};
  }});
  const crop=result?.result;
  if(!crop||![crop.x,crop.y,crop.width,crop.height,crop.viewportWidth,crop.viewportHeight].every(Number.isFinite))throw Error('无法计算播放器内容裁剪区域');
  return crop;
}
async function clickNextButton(tabId,frameId){
  const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},func:()=>{
    const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().toLocaleUpperCase();
    const selector='button,[role="button"],input[type="button"],input[type="submit"],a';
    const matches=[...document.querySelectorAll(selector)].filter(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      const labels=[element.innerText,element.getAttribute('aria-label'),element.value,element.getAttribute('title')];
      return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&labels.some(value=>normalize(value)==='VOLGENDE');
    });
    if(matches.length!==1)throw Error(`VOLGENDE 按钮找到 ${matches.length} 个匹配，未点击。`);
    const button=matches[0];
    if(button.disabled||button.matches(':disabled')||button.getAttribute('aria-disabled')==='true')throw Error('VOLGENDE 不再处于启用状态，未点击。');
    button.click();
    return {clicked:true,label:button.innerText||button.getAttribute('aria-label')||button.value||'VOLGENDE'};
  }});
  return result?.result||null;
}
function waitForClick(attempt,timeout=1200){
  if(attempt.clickObserved)return Promise.resolve(true);
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{attempt.resolveClick=null;resolve(false);},timeout);
    attempt.resolveClick=()=>{clearTimeout(timer);attempt.resolveClick=null;resolve(true);};
  });
}
async function stopObserver(tabId,frameId){
  if(tabId==null||frameId==null)return;
  try{await chrome.tabs.sendMessage(tabId,{to:'observer',type:'stop'},{frameId});}catch{}
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
async function handle(m,s){
  if(m.type==='status'){await chrome.storage.local.set({status:m.status});await chrome.action.setBadgeText({text:m.status.running?'REC':''});return;}
  if(m.type==='automation-status'){await setAutomationStatus(m.text,true);return;}
  if(m.type==='portal-set-filter'){
    if(!s.tab?.id||!isPortalPage(s.tab.url))throw Error('筛选条件只能在官方题目选择页设置。');
    if(!['filter-programma','filter-soort-opdracht'].includes(m.field))throw Error('不支持此官网筛选字段。');
    const [result]=await chrome.scripting.executeScript({
      target:{tabId:s.tab.id,frameIds:[s.frameId??0]},world:'MAIN',
      func:(field,value)=>{
        const normalize=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        const select=document.querySelector(`facet-openbaar-portaal select#${CSS.escape(field)}`)||document.querySelector(`select#${CSS.escape(field)}`);
        if(!select)throw Error(`官网筛选器 ${field} 尚未加载。`);
        const option=[...select.options].find(item=>item.value===value||normalize(item.textContent)===normalize(value));
        if(!option)throw Error(`官网筛选器 ${field} 没有选项 ${value}。`);
        const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')?.set;
        if(setter)setter.call(select,option.value);else select.value=option.value;
        select.dispatchEvent(new Event('input',{bubbles:true}));
        select.dispatchEvent(new Event('change',{bubbles:true}));
        return {value:select.value,text:option.textContent.trim()};
      },args:[m.field,m.value]
    });
    return {value:result.result?.value,text:result.result?.text};
  }
  if(m.type==='portal-search'){
    if(!s.tab?.id||!isPortalPage(s.tab.url))throw Error('查询只能在官方题目选择页执行。');
    const [result]=await chrome.scripting.executeScript({
      target:{tabId:s.tab.id,frameIds:[s.frameId??0]},world:'MAIN',
      func:()=>{
        const button=document.querySelector('facet-openbaar-portaal button#zoeken-knop')||document.querySelector('button#zoeken-knop');
        if(!button||button.disabled)throw Error('官网“Zoek”按钮不存在或不可用。');
        button.click();return true;
      }
    });
    if(!result?.result)throw Error('无法点击官网“Zoek”按钮。');
    return;
  }
  if(m.type==='download')return download(m.url,m.filename);
  if(m.type==='page-event'){
    const {session}=await chrome.storage.session.get('session');
    if(!session||s.tab?.id!==session.tabId||s.frameId!==session.frameId)return;
    const event=m.event;
    if(event?.name==='observer-error'){
      await stopObserver(session.tabId,session.frameId);
      await chrome.storage.session.remove('session');
      await chrome.runtime.sendMessage({to:'offscreen',type:'event',event:{name:'error',message:event.message}});
    }else if(['enabled','final-ready'].includes(event?.name)){
      if(advancing.has(session.tabId))return;
      const attempt={manualClick:false,autoClickInitiated:false,clickObserved:false,resolveClick:null};
      advancing.set(session.tabId,attempt);
      try{
          let recorderEvent=event;
          let automation=null;
          let completedThisRun=0;
          if(event.name==='final-ready'){
            ({automation}=await chrome.storage.session.get('automation'));
            const hasNextBatch=Boolean(automation?.allQuestions&&automation.nextIndex<automation.allQuestions.length);
            completedThisRun=(automation?.batchesThisRun||0)+1;
            const shouldPause=Boolean(hasNextBatch&&completedThisRun>=batchesPerRunOf(automation?.config?.batchesPerRun));
            recorderEvent={...event,retainCaptureForNextBatch:hasNextBatch&&!shouldPause,workflowComplete:!hasNextBatch};
          }
          const saved=await chrome.runtime.sendMessage({to:'offscreen',type:'event',event:recorderEvent});
        if(!saved?.ok)throw Error(saved?.error||'保存当前题目失败');
        if(event.name==='final-ready'){
          if(automation){
            const checkpoint=await getAutomationCheckpoint();
            if(!checkpoint)throw Error('保存的自动流程进度不存在；本批录音已保存，但无法安全推进进度。');
            const completedBatches=Math.ceil(automation.nextIndex/automationBatchSizeOf(automation.config.batchSize));
            await saveAutomationCheckpoint({...checkpoint,nextQuestionOffset:automation.nextIndex,completedBatches});
            await chrome.storage.session.set({automation:{...automation,batchesThisRun:completedThisRun}});
          }
          await stopObserver(session.tabId,session.frameId);
          await chrome.storage.session.remove('session');
          const outcome=await startNextAutomationBatch(session.tabId);
          if(outcome==='complete')await chrome.tabs.remove(session.tabId);
        }else if(!attempt.manualClick){
          attempt.autoClickInitiated=true;
          const result=await clickNextButton(session.tabId,session.frameId);
          if(!result){
            const observed=await waitForClick(attempt);
            if(!observed)throw Error('点击脚本已运行，但未收到 VOLGENDE 点击确认；可能是播放器忽略脚本点击，或页面/框架在返回前发生重载。');
          }
        }
      }catch(e){
        if(event.name==='final-ready'){
          await chrome.storage.session.remove('automation');
          await setAutomationStatus(`本批片段已保存，但推进或暂停失败：${e.message}。保存的进度仍可恢复。`,false,'ERROR');
        }else{
          await chrome.runtime.sendMessage({to:'offscreen',type:'event',event:{name:'warning',message:`本题已保存，但无法自动进入下一题：${e.message}。请手动点击 VOLGENDE；录制会继续。`}});
        }
      }finally{advancing.delete(session.tabId);}
    }else if(event?.name==='next-click'){
      const attempt=advancing.get(session.tabId);
      if(attempt){
        if(attempt.autoClickInitiated){attempt.clickObserved=true;attempt.resolveClick?.();}
        else attempt.manualClick=true;
      }
      await chrome.runtime.sendMessage({to:'offscreen',type:'event',event});
    }
    return;
  }
  if(m.type==='stop'){
    const {session}=await chrome.storage.session.get('session');
    if(session){await stopObserver(session.tabId,session.frameId);await chrome.storage.session.remove('session');}
    await ensureOffscreen();
    return chrome.runtime.sendMessage({to:'offscreen',type:'stop'});
  }
  if(m.type==='start'){
    if(starting)throw Error('正在启动，请稍候');
    starting=true;
    try{
      const {pendingCapture}=await chrome.storage.session.get('pendingCapture');
      if(pendingCapture){
        if(pendingCapture.tabId!==m.tabId)throw Error('自动设置已完成。请切换到 Vraag 1 播放器标签页，再打开扩展并点击“开始录制”。');
        const result=await beginRecording(m.tabId,pendingCapture.config);
        await chrome.storage.session.remove('pendingCapture');
        return result;
      }
      return await beginRecording(m.tabId,m.config);
    }
    finally{starting=false;}
  }
  if(m.type==='auto-start'){
    if(starting)throw Error('自动流程正在运行，请稍候');
    const program=String(m.config?.program||'').trim();
    const kind=String(m.config?.kind||'default').trim();
    const existingCheckpoint=await getAutomationCheckpoint();
    if(existingCheckpoint&&!m.replaceCheckpoint)throw Error('已有保存的自动流程进度；请先选择“继续”或明确选择“重新开始”。');
    if(!['Programma I Spreken','Programma II Spreken'].includes(program))throw Error('自动音频/麦克风流程仅支持 Programma I/II Spreken。');
    if(!['default','Kort','Lang','Middellang'].includes(kind))throw Error('请选择有效的题型。');
    const config={...m.config,program,kind,batchSize:automationBatchSizeOf(m.config?.batchSize),batchesPerRun:batchesPerRunOf(m.config?.batchesPerRun)};
    configOf(config);
    starting=true;
    try{
      await prepareTabCapture(m.tabId);
      if(existingCheckpoint)await chrome.storage.local.remove(AUTOMATION_CHECKPOINT_KEY);
      await automatePortal(m.tabId,config);
      return {message:'自动设置已完成，并已在 Vraag 1 自动开始录制。'};
    }catch(e){
      if(existingCheckpoint)await saveAutomationCheckpoint(existingCheckpoint).catch(()=>{});
      const {running:recording,preparedTabId}=await chrome.runtime.sendMessage({to:'offscreen',type:'state'}).catch(()=>({}));
      if(!recording&&preparedTabId===m.tabId){
        await chrome.runtime.sendMessage({to:'offscreen',type:'cancel-capture'}).catch(()=>{});
      }
      await setAutomationStatus(`自动流程已停止：${e.message}`,false,'ERROR');
      throw e;
    }finally{starting=false;}
  }
  if(m.type==='auto-resume'){
    if(starting)throw Error('自动流程正在启动，请稍候');
    starting=true;
    try{return await resumeAutomation(m.tabId);}
    catch(error){
      await setAutomationStatus(`继续流程失败：${error.message}。保存的进度未删除。`,false,'ERROR');
      throw error;
    }finally{starting=false;}
  }
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.to!=='worker')return;
  handle(m,s).then(value=>reply({ok:true,...(value&&typeof value==='object'?value:{value})})).catch(e=>reply({ok:false,error:e.message}));return true;
});
async function recoverInterruptedAutomation(){
  const [{status},contexts]=await Promise.all([
    chrome.storage.local.get('status'),
    chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})
  ]);
  if(!status?.running)return;
  let recorderState=null;
  if(contexts.length)recorderState=await chrome.runtime.sendMessage({to:'offscreen',type:'state'}).catch(()=>null);
  if(recorderState?.running)return;
  const checkpoint=await getAutomationCheckpoint();
  await setAutomationStatus(checkpoint?'自动流程已中断；已保存的进度可在官方题目选择页继续。':'先前录制已停止。',false,checkpoint?'INTERRUPTED':'IDLE');
}
chrome.runtime.onStartup.addListener(()=>recoverInterruptedAutomation());
chrome.runtime.onInstalled.addListener(()=>recoverInterruptedAutomation());
