const ids=['prefix','start'];
const $=id=>document.getElementById(id);
const ready=(async()=>{
  const {config,autoConfig}=await chrome.storage.local.get(['config','autoConfig']);
  if(config)for(const id of ids)$(id).value=config[id];
  if(autoConfig){$('program').value=autoConfig.program||$('program').value;$('kind').value=autoConfig.kind||'default';$('batchSize').value=autoConfig.batchSize||20;}
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
    if(!$('batchSize').reportValidity())return;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const config={
      program:$('program').value,
      kind:$('kind').value,
      prefix:$('prefix').value,
      start:$('start').value,
      batchSize:Number($('batchSize').value)
    };
    await chrome.storage.local.set({autoConfig:{program:config.program,kind:config.kind,batchSize:config.batchSize}});
    const response=await chrome.runtime.sendMessage({to:'worker',type:'auto-start',tabId:tab.id,config});
    if(!response?.ok)throw Error(response?.error||'自动流程失败');
    $('status').textContent=response.message||'流程已启动';
  }catch(error){$('status').textContent=error.message;}
};
$('stop').onclick=()=>request('stop');
async function update(){const {status}=await chrome.storage.local.get('status');if(status){$('status').textContent=status.text;$('startBtn').disabled=!!status.running;$('autoStart').disabled=!!status.running;}}
chrome.storage.onChanged.addListener((changes)=>{if(changes.status)update();});
update();
