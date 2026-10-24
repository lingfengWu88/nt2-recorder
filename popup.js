const ids=['prefix','start','count','seconds','nextText','playText'];
const $=id=>document.getElementById(id);
const ready=(async()=>{const {config}=await chrome.storage.local.get('config');if(config)for(const id of ids)$(id).value=config[id];})();
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
$('check').onclick=()=>request('check');
$('stop').onclick=()=>request('stop');
async function update(){const {status}=await chrome.storage.local.get('status');if(status){$('status').textContent=status.text;$('startBtn').disabled=!!status.running;}}
chrome.storage.onChanged.addListener((changes)=>{if(changes.status)update();});
update();
