'use strict';
const $=id=>document.getElementById(id);
const dropZone=$('drop-zone'),fileInput=$('file-input'),fileInfo=$('file-info'),fileNameEl=$('file-name'),fileSizeEl=$('file-size'),removeBtn=$('remove-file'),processBtn=$('process-btn');
const uploadSec=$('upload-section'),progressSec=$('progress-section'),resultSec=$('result-section'),errorSec=$('error-section');
const progressBar=$('progress-bar'),stageEl=$('progress-stage'),pctEl=$('progress-pct');
const resultImg=$('result-img'),downloadBtn=$('download-btn'),newBtn=$('new-btn'),errorMsgEl=$('error-msg'),retryBtn=$('error-retry-btn');
let selectedFile=null,resultCanvas=null;
dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('dragover');});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragover');if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0]);});
fileInput.addEventListener('change',()=>{if(fileInput.files[0])setFile(fileInput.files[0]);});
removeBtn.addEventListener('click',clearFile);
function setFile(f){selectedFile=f;fileNameEl.textContent=f.name;fileSizeEl.textContent=fmtBytes(f.size);fileInfo.classList.remove('hidden');dropZone.classList.add('hidden');processBtn.disabled=false;}
function clearFile(){selectedFile=null;fileInput.value='';fileInfo.classList.add('hidden');dropZone.classList.remove('hidden');processBtn.disabled=true;}
function fmtBytes(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';}
processBtn.addEventListener('click',startProcessing);
async function startProcessing(){if(!selectedFile)return;
  const wx=+$('win-x').value||null,wy=+$('win-y').value||null,ww=+$('win-w').value||null,wh=+$('win-h').value||null,cw=+$('cell-w').value||null,ch=+$('cell-h').value||null;
  const options={windowPos:(wy!=null&&wx!=null)?[wy,wx]:null,windowSize:(wh!=null&&ww!=null)?[wh,ww]:null,cellSize:(ch!=null&&cw!=null)?[ch,cw]:null,maxFrames:200};
  showSection('progress');setProgress(0,'시작 중...');
  try{resultCanvas=await depixelate(selectedFile,options,(stage,pct)=>setProgress(pct,stage));showResult();}catch(err){showError(err.message||String(err));}
}
function setProgress(pct,stage){progressBar.style.width=pct+'%';stageEl.textContent=stage;pctEl.textContent=pct+'%';}
function showResult(){resultCanvas.toBlob(blob=>{resultImg.src=URL.createObjectURL(blob);},'image/png');downloadBtn.onclick=()=>{const a=document.createElement('a');a.href=resultImg.src;a.download='depixelated_result.png';a.click();};showSection('result');}
function showError(msg){errorMsgEl.textContent=msg;showSection('error');}
function showSection(name){[uploadSec,progressSec,resultSec,errorSec].forEach(s=>s.classList.add('hidden'));if(name==='upload')uploadSec.classList.remove('hidden');if(name==='progress')progressSec.classList.remove('hidden');if(name==='result')resultSec.classList.remove('hidden');if(name==='error')errorSec.classList.remove('hidden');}
newBtn.addEventListener('click',reset);retryBtn.addEventListener('click',reset);
function reset(){resultCanvas=null;clearFile();setProgress(0,'대기 중...');showSection('upload');}