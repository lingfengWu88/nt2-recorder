let running=false,stopRequested=false,recorder=null,stream=null,output=null,wake=null;
const sleep=ms=>new Promise(r=>{const t=setTimeout(()=>{wake=null;r();},ms);wake=()=>{clearTimeout(t);wake=null;r();};});
async function rpc(type,args={}){const r=await chrome.runtime.sendMessage({to:'worker',type,...args});if(!r?.ok)throw Error(r?.error||'后台无响应');return r;}
async function status(text){await rpc('status',{status:{text,running,time:Date.now()}});}
function recordSegment(){
  const mimeType=['video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));
  if(!mimeType)throw Error('浏览器不支持 WebM 录制');
  const chunks=[];recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:1500000,audioBitsPerSecond:96000});
  let resolve,reject;
  const result=new Promise((a,b)=>{resolve=a;reject=b;});
  // Attach a handler immediately: errors may precede the later await.
  result.catch(()=>{});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  recorder.onerror=e=>{stopRequested=true;wake?.();reject(Error(e.error?.message||'录制编码出错'));};
  recorder.onstop=()=>resolve(new Blob(chunks,{type:mimeType}));
  recorder.start(1000);return result;
}
async function run(m){
  const cfg=m.config,batch=new Date().toISOString().replace(/[:.]/g,'-');
  let completed=0,error=null;
  try{
    // tabCapture uses Chromium's mandatory constraint format. Do not mix
    // standard constraints (e.g. frameRate) into the same audio/video object.
    stream=await navigator.mediaDevices.getUserMedia({
      audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}},
      video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}}
    });
    if(!stream.getAudioTracks().length)throw Error('没有取得标签页音轨，已停止');
    stream.getTracks().forEach(t=>t.onended=()=>{stopRequested=true;wake?.();});
    output=new AudioContext();output.createMediaStreamSource(stream).connect(output.destination);await output.resume();
    for(let i=0;i<cfg.count&&!stopRequested;i++){
      await status(`正在录制 ${i+1}/${cfg.count}，编号 ${cfg.start+i}。每段 ${cfg.seconds} 秒。`);
      const blobPromise=recordSegment();let segmentError=null;
      try{
        // Start recording BEFORE navigation/play so initial audio is retained.
        if(i>0){await rpc('control',{tabId:m.tabId,text:cfg.nextText});await sleep(2000);}
        if(!stopRequested&&cfg.playText)await rpc('control',{tabId:m.tabId,text:cfg.playText});
        if(!stopRequested)await sleep(cfg.seconds*1000);
      }catch(e){segmentError=e;}
      if(recorder.state!=='inactive')recorder.stop();
      const blob=await blobPromise;recorder=null;
      if(blob.size<1024)throw Error('录制结果为空或过短，已停止');
      const partial=stopRequested||segmentError;
      const filename=`NT2-recordings/${batch}/${cfg.prefix}_${String(cfg.start+i).padStart(4,'0')}${partial?'_partial':''}.webm`;
      const url=URL.createObjectURL(blob);
      try{await status('正在保存：'+filename);await rpc('download',{url,filename});}finally{URL.revokeObjectURL(url);}
      completed++;
      if(segmentError)throw segmentError;
    }
  }catch(e){error=e.message;}
  finally{
    if(recorder&&recorder.state!=='inactive')recorder.stop();recorder=null;
    if(stream){stream.getTracks().forEach(t=>{t.onended=null;t.stop();});stream=null;}
    if(output){await output.close();output=null;}
    running=false;
    await status(`${error?'已中止：'+error:stopRequested?'已停止':'本批完成'}\n已保存 ${completed} 段。请回听验证声音，并核对是否漏题、重复或截断。`);
  }
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.to!=='offscreen')return;
  if(m.type==='state'){reply({running});return;}
  if(m.type==='stop'){stopRequested=true;wake?.();reply({ok:true});return;}
  if(m.type==='start'){
    if(running){reply({ok:false,error:'已有任务'});return;}
    running=true;stopRequested=false;reply({ok:true});run(m);
  }
});
