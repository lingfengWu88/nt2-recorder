let running=false,stopRequested=false,stream=null,captureTabId=null,recordingStream=null,output=null,active=null,segmentNumber=0,config=null,batch='',error=null,retainCaptureForNextBatch=false;
let cropVideo=null,cropCanvas=null,cropTimer=null,cropCanvasTrack=null;
let events=[],eventWaiter=null,saves=[],completed=false,batchComplete=false;
let estimatedSegmentDurationMs=120000;
async function rpc(type,args={}){const r=await chrome.runtime.sendMessage({to:'worker',type,...args});if(!r?.ok)throw Error(r?.error||'后台无响应');return r;}
async function status(text,phase='RECORDING'){await rpc('status',{status:{text,running,phase,time:Date.now()}});}
function enqueue(event,reply){events.push({event,reply});eventWaiter?.();eventWaiter=null;}
async function nextEvent(){if(events.length)return events.shift();await new Promise(resolve=>{eventWaiter=resolve;});return events.shift();}
async function prepareCapture(streamId,tabId){
  if(running)throw Error('录制正在运行，不能重新准备捕获流。');
  if(stream){
    if(captureTabId!==tabId)throw Error('已有捕获流属于其他标签页。');
    return;
  }
  stream=await navigator.mediaDevices.getUserMedia({
    audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}},
    video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}}
  });
  captureTabId=tabId;
  try{
    if(!stream.getAudioTracks().length)throw Error('没有取得标签页音轨，已停止');
    stream.getVideoTracks().forEach(track=>track.onended=()=>{if(running)enqueue({name:'error',message:'标签页视频录制流已结束'});});
    stream.getAudioTracks().forEach(track=>track.onended=()=>{if(running)enqueue({name:'warning',message:'标签页音轨已结束；仍继续录制画面并等待 VOLGENDE 启用。'});});
    output=new AudioContext();
    output.createMediaStreamSource(stream).connect(output.destination);
    await output.resume();
  }catch(error){
    await releaseCapture();
    throw error;
  }
}
async function releaseCapture(){
  if(stream){stream.getTracks().forEach(track=>{track.onended=null;track.stop();});stream=null;}
  captureTabId=null;
  if(output){await output.close();output=null;}
}
function startSegment(){
  const mimeType=['video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)throw Error('浏览器不支持 WebM 录制');
  // Aim for ~500 KiB per segment using the last segment's duration. The first
  // segment assumes two minutes; a minimum audio/video rate avoids unusable output.
  const targetBitsPerSecond=500*1024*8*0.9/(estimatedSegmentDurationMs/1000);
  const audioBitsPerSecond=24000;
  const videoBitsPerSecond=Math.max(8000,Math.floor(targetBitsPerSecond-audioBitsPerSecond));
  const chunks=[],recorder=new MediaRecorder(recordingStream,{mimeType,videoBitsPerSecond,audioBitsPerSecond});
  let resolve,reject;
  const done=new Promise((a,b)=>{resolve=a;reject=b;});
  done.catch(()=>{});
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  recorder.onerror=event=>{
    const failure=Error(event.error?.message||'录制编码出错');
    reject(failure);
    enqueue({name:'error',message:failure.message});
  };
  recorder.onstop=()=>resolve(new Blob(chunks,{type:mimeType}));
  recorder.start(1000);
  active={recorder,done,startedAt:performance.now()};
  segmentNumber++;
}
async function stopSegment(partial=false){
  if(!active)return;
  const segment=active;active=null;
  if(segment.recorder.state!=='inactive')segment.recorder.stop();
  const blob=await segment.done;
  const durationMs=Math.max(1000,performance.now()-segment.startedAt);
  estimatedSegmentDurationMs=Math.round(estimatedSegmentDurationMs*0.5+durationMs*0.5);
  if(blob.size<1024)throw Error('录制结果为空或过短，已停止');
  const segmentIndex=segmentNumber;
  const index=config.start+segmentIndex-1;
  const filename=`NT2-recordings/${batch}/${config.prefix}_${String(index).padStart(4,'0')}${partial?'_partial':''}.webm`;
  const url=URL.createObjectURL(blob);
  const save=async()=>{
    try{await status(`正在保存第 ${segmentIndex} 段：${filename}`,'SAVING');await rpc('download',{url,filename});}
    finally{URL.revokeObjectURL(url);}
  };
  const job=save().catch(reason=>{error=reason.message;stopRequested=true;enqueue({name:'stop'});throw reason;});
  saves.push(job);
  return job;
}
async function createCroppedRecordingStream(crop){
  const sourceVideo=stream.getVideoTracks()[0];
  if(!sourceVideo)throw Error('标签页视频轨道不可用');
  cropVideo=document.createElement('video');
  cropVideo.muted=true;cropVideo.playsInline=true;cropVideo.srcObject=stream;
  await cropVideo.play();
  if(!cropVideo.videoWidth||!cropVideo.videoHeight)await new Promise((resolve,reject)=>{
    cropVideo.onloadedmetadata=resolve;
    cropVideo.onerror=()=>reject(Error('无法读取标签页视频尺寸'));
  });
  const scaleX=cropVideo.videoWidth/crop.viewportWidth,scaleY=cropVideo.videoHeight/crop.viewportHeight;
  let sx=Math.round(crop.x*scaleX),sy=Math.round(crop.y*scaleY);
  sx=Math.max(0,Math.min(cropVideo.videoWidth-1,sx));
  sy=Math.max(0,Math.min(cropVideo.videoHeight-1,sy));
  const sw=Math.min(Math.round(crop.width*scaleX),cropVideo.videoWidth-sx);
  const sh=Math.min(Math.round(crop.height*scaleY),cropVideo.videoHeight-sy);
  if(sw<2||sh<2)throw Error('播放器内容裁剪区域不在录制画面范围内');
  cropCanvas=document.createElement('canvas');
  cropCanvas.width=sw;cropCanvas.height=sh;
  const context=cropCanvas.getContext('2d');
  if(!context)throw Error('无法创建内容裁剪画布');
  const paint=()=>{
    if(!running)return;
    try{
      context.drawImage(cropVideo,sx,sy,sw,sh,0,0,sw,sh);
      cropCanvasTrack?.requestFrame?.();
    }catch(e){
      enqueue({name:'error',message:`裁剪画面更新失败：${e.message}`});
    }
  };
  const canvasStream=cropCanvas.captureStream(0);
  cropCanvasTrack=canvasStream.getVideoTracks()[0];
  paint();
  // A low frame rate preserves readable static question cards at the small
  // target bitrate; animated UI will appear less smooth.
  cropTimer=setInterval(paint,1000/5);
  recordingStream=new MediaStream([...canvasStream.getVideoTracks(),...stream.getAudioTracks()]);
}
function releaseCrop(){
  if(cropTimer)clearInterval(cropTimer);
  cropTimer=null;
  cropCanvasTrack=null;
  if(recordingStream){recordingStream.getVideoTracks().forEach(track=>track.stop());recordingStream=null;}
  if(cropVideo){cropVideo.pause();cropVideo.srcObject=null;cropVideo.remove();cropVideo=null;}
  cropCanvas=null;
}
async function handleEvent(event){
  if(event.name==='error')throw Error(event.message||'按钮状态监测失败');
  if(event.name==='warning'){
    await status(event.message);
    return;
  }
  if(event.name==='final-ready'){
    if(active)await stopSegment(false);
    await Promise.all(saves);
    retainCaptureForNextBatch=Boolean(event.retainCaptureForNextBatch);
    completed=event.workflowComplete!==false;
    batchComplete=true;
    stopRequested=true;
    await status(`已检测到最后一题状态。最终录制已保存，共 ${segmentNumber} 段；${retainCaptureForNextBatch?'正在准备下一批。':'考试录制已完成。'}`,'SAVING');
    return;
  }
  if(event.name==='enabled'){
    if(active){await stopSegment(false);await Promise.all(saves);await status(`已检测到 VOLGENDE 启用并保存第 ${segmentNumber} 段；正在进入下一题。`);}
    return;
  }
  if(event.name==='next-click'){
    if(active)await stopSegment(false); // Covers a rapid click arriving before the enabled notification.
    if(!stopRequested){startSegment();await status(`正在录制第 ${segmentNumber} 题；结束时将根据 VOLGENDE 状态自动保存。`);}
  }
}
async function run(message,ready){
  config=message.config;batch=new Date().toISOString().replace(/[:.]/g,'-');
  segmentNumber=0;estimatedSegmentDurationMs=120000;error=null;saves=[];events=[];stopRequested=false;retainCaptureForNextBatch=false;completed=false;batchComplete=false;
  let initialized=false;
  try{
    if(stream&&captureTabId!==message.tabId)throw Error('预先捕获的标签页与考试播放器不一致。');
    if(!stream){
      if(!message.streamId)throw Error('没有可复用的预先捕获流，也没有新的 Chrome stream ID。');
      await prepareCapture(message.streamId,message.tabId);
    }
    if([...stream.getAudioTracks(),...stream.getVideoTracks()].some(track=>track.readyState==='ended'))throw Error('预先捕获的音频或视频流已结束。');
    await createCroppedRecordingStream(message.crop);
    startSegment();
    const cropInfo=`内容裁剪 x=${Math.round(message.crop.x)}, y=${Math.round(message.crop.y)}, ${Math.round(message.crop.width)}×${Math.round(message.crop.height)} / ${message.crop.viewportWidth}×${message.crop.viewportHeight}`;
    await status(`正在录制第 ${segmentNumber} 题。${cropInfo}。等待 VOLGENDE 从禁用变为启用。`);
    initialized=true;ready();
    while(!stopRequested){
      const item=await nextEvent();
      if(item.event.name==='stop'){item.reply?.({ok:true});stopRequested=true;break;}
      try{await handleEvent(item.event);item.reply?.({ok:true});}
      catch(reason){item.reply?.({ok:false,error:reason.message||String(reason)});throw reason;}
    }
    if(active)await stopSegment(true);
  }catch(reason){
    error=reason.message||String(reason);stopRequested=true;
    if(!initialized)ready(reason);
    try{if(active)await stopSegment(true);}catch(saveError){error+=`；当前片段保存失败：${saveError.message}`;}
  }finally{
    await Promise.allSettled(saves);
    releaseCrop();
    if(!retainCaptureForNextBatch)await releaseCapture();
    running=false;active=null;
    const phase=error?'ERROR':completed?'COMPLETED':batchComplete?'PORTAL_AUTOMATION':'IDLE';
    const finalText=error?'已中止：'+error:completed?'全部题目录制完成':batchComplete?'当前批次已保存，准备下一批':'已停止';
    await status(`${finalText}\n已完成第 ${segmentNumber} 段。请回听确认每题边界、画面和声音。`,phase);
  }
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.to!=='offscreen')return;
  if(message.type==='state'){
    reply({running,preparedTabId:captureTabId,captureActive:Boolean(stream&&stream.getTracks().length&&stream.getTracks().every(track=>track.readyState==='live'))});
    return;
  }
  if(message.type==='prepare'){
    prepareCapture(message.streamId,message.tabId)
      .then(()=>reply({ok:true,preparedTabId:captureTabId,captureActive:Boolean(stream&&stream.getTracks().length&&stream.getTracks().every(track=>track.readyState==='live'))}))
      .catch(error=>reply({ok:false,error:error.message||String(error)}));
    return true;
  }
  if(message.type==='cancel-capture'){
    if(running){reply({ok:false,error:'录制正在运行，不能取消捕获流。'});return;}
    releaseCrop();
    releaseCapture().then(()=>reply({ok:true}));
    return true;
  }
  if(message.type==='event'){
    if(['enabled','final-ready'].includes(message.event?.name)&&running){
      enqueue(message.event,reply);
      return true;
    }
    if(running)enqueue(message.event);
    reply({ok:true});
    return;
  }
  if(message.type==='stop'){
    if(running){enqueue({name:'stop'});reply({ok:true});return;}
    releaseCrop();
    releaseCapture().then(()=>reply({ok:true}));
    return true;
  }
  if(message.type==='start'){
    if(running){reply({ok:false,error:'已有任务'});return;}
    running=true;
    run(message,reason=>reason?reply({ok:false,error:reason.message||String(reason)}):reply({ok:true}));
    return true;
  }
});
