const ids=['prefix','start'];
const $=id=>document.getElementById(id);
const ready=(async()=>{
  const {config,autoConfig}=await chrome.storage.local.get(['config','autoConfig']);
  if(config)for(const id of ids)$(id).value=config[id];
  if(autoConfig){$('program').value=autoConfig.program||$('program').value;$('kind').value=autoConfig.kind||'default';$('batchSize').value=autoConfig.batchSize||20;$('batchesPerRun').value=autoConfig.batchesPerRun||5;}
})();
async function request(type){
  try{
    await ready;
    const config=Object.fromEntries(ids.map(id=>[id,$(id).value]));
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const response=await chrome.runtime.sendMessage({to:'worker',type,tabId:tab.id,config});
    if(!response?.ok)throw Error(response?.error||'扩展无响应');
    $('status').textContent=response.message||'已执行';
  }catch(e){$('status').textContent=e.message;}
}
$('startBtn').onclick=()=>request('start');
$('autoStart').onclick=async()=>{
  try{
    await launchNewRun(false);
  }catch(error){$('status').textContent=error.message;}
};
$('resumeBtn').onclick=async()=>{
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const response=await chrome.runtime.sendMessage({to:'worker',type:'auto-resume',tabId:tab.id});
    if(!response?.ok)throw Error(response?.error||'无法继续自动流程');
    $('status').textContent=response.message||'已继续保存的流程';
  }catch(error){$('status').textContent=error.message;}
};
$('startOverBtn').onclick=async()=>{
  if(!confirm('重新开始会清除已保存进度。确定继续吗？'))return;
  try{await launchNewRun(true);}catch(error){$('status').textContent=error.message;}
};
async function launchNewRun(replaceCheckpoint){
  await ready;
  if(!$('batchSize').reportValidity()||!$('batchesPerRun').reportValidity())return;
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const config={
    program:$('program').value,
    kind:$('kind').value,
    prefix:$('prefix').value,
    start:$('start').value,
    batchSize:Number($('batchSize').value),
    batchesPerRun:Number($('batchesPerRun').value)
  };
  await chrome.storage.local.set({autoConfig:{program:config.program,kind:config.kind,batchSize:config.batchSize,batchesPerRun:config.batchesPerRun}});
  const response=await chrome.runtime.sendMessage({to:'worker',type:'auto-start',tabId:tab.id,config,replaceCheckpoint});
  if(!response?.ok)throw Error(response?.error||'自动流程失败');
  $('status').textContent=response.message||'流程已启动';
}
$('stop').onclick=()=>request('stop');
async function update(){
  const {status:storedStatus,automationCheckpoint}=await chrome.storage.local.get(['status','automationCheckpoint']);
  let status=storedStatus;
  if(status?.running){
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    let recorderState=null;
    if(contexts.length)recorderState=await chrome.runtime.sendMessage({to:'offscreen',type:'state'}).catch(()=>null);
    if(!recorderState?.running){
      status={...status,running:false,phase:automationCheckpoint?'INTERRUPTED':'IDLE',text:automationCheckpoint?'自动流程已中断；已保存的进度可在官方题目选择页继续。':'先前录制已停止。'};
      await chrome.storage.local.set({status});
    }
  }
  const hasCheckpoint=Boolean(automationCheckpoint);
  $('checkpointPanel').hidden=!hasCheckpoint;
  $('autoStart').hidden=hasCheckpoint;
  if(hasCheckpoint){
    const {config,allQuestions,nextQuestionOffset,completedBatches=0}=automationCheckpoint;
    const totalBatches=Math.ceil((allQuestions?.length||0)/(Number(config?.batchSize)||20));
    $('checkpointSummary').textContent=nextQuestionOffset>=(allQuestions?.length||0)?`所有 ${allQuestions?.length||0} 道题已完成。点击继续清理进度，或重新开始新流程。`:`已完成 ${completedBatches}/${totalBatches} 批；下一题 ${nextQuestionOffset+1}/${allQuestions?.length||0}。每场 ${config?.batchSize} 题，本次最多 ${config?.batchesPerRun} 批。`;
  }
  if(status){
    $('status').textContent=status.text;
    $('startBtn').disabled=!!status.running;
    $('autoStart').disabled=!!status.running;
    $('resumeBtn').disabled=!!status.running;
    $('startOverBtn').disabled=!!status.running;
  }
}
chrome.storage.onChanged.addListener(()=>update());
ready.then(update);
