'use strict';
/**
 * Client-side de-pixelation algorithm
 * Based on KoKuToru/de-pixelate_gaV-O6NPWrI (CC0 1.0)
 */

const yieldToUI = () => new Promise(r => setTimeout(r, 0));

async function extractFrames(file, onProgress, maxFrames = 200) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('영상을 읽을 수 없습니다.'));
    video.src = URL.createObjectURL(file);
  });
  const W = video.videoWidth, H = video.videoHeight, duration = video.duration;
  if (!W || !H || !duration || !isFinite(duration))
    throw new Error('영상 크기 또는 길이를 알 수 없습니다.');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const nFrames = Math.min(maxFrames, Math.max(1, Math.floor(duration * 10)));
  const step = duration / nFrames;
  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    video.currentTime = i * step;
    await new Promise(r => { video.onseeked = r; });
    ctx.drawImage(video, 0, 0);
    frames.push(ctx.getImageData(0, 0, W, H));
    onProgress?.(i + 1, nFrames);
    if (i % 8 === 0) await yieldToUI();
  }
  URL.revokeObjectURL(video.src);
  return { frames, W, H };
}

function detectWindow(frame) {
  const { data, width: W, height: H } = frame;
  const yStart = Math.min(Math.floor(H / 4), 350);
  const yEnd   = Math.min(H - 1, 1900);
  const xEnd   = Math.min(W - 1, 1230);
  let foundY = 0;
  for (let y = yStart; y < yEnd; y++) {
    let cnt = 0;
    for (let x = 0; x < W; x++) { const i=(y*W+x)*4; if(data[i]+data[i+1]+data[i+2]<135) cnt++; }
    if (cnt / W >= 0.5) { foundY = y; break; }
  }
  let foundX = 0;
  for (let x = 0; x < xEnd; x++) {
    let cnt = 0;
    for (let y = 0; y < H; y++) { const i=(y*W+x)*4; if(data[i]+data[i+1]+data[i+2]<135) cnt++; }
    if (cnt / H >= 0.5) { foundX = x; break; }
  }
  return { wy: foundY, wx: foundX };
}

function detectCellSize(frame, wy, wx, wh, ww) {
  const { data, width: W } = frame;
  const rowDiff = new Float32Array(wh - 1);
  for (let y = 0; y < wh-1; y++) {
    let s = 0;
    for (let x = 0; x < ww; x++) {
      const a=((wy+y)*W+wx+x)*4, b=((wy+y+1)*W+wx+x)*4;
      s += Math.abs((data[a]+data[a+1]+data[a+2])-(data[b]+data[b+1]+data[b+2]));
    }
    rowDiff[y] = s / ww;
  }
  const colDiff = new Float32Array(ww - 1);
  for (let x = 0; x < ww-1; x++) {
    let s = 0;
    for (let y = 0; y < wh; y++) {
      const a=((wy+y)*W+wx+x)*4, b=((wy+y)*W+wx+x+1)*4;
      s += Math.abs((data[a]+data[a+1]+data[a+2])-(data[b]+data[b+1]+data[b+2]));
    }
    colDiff[x] = s / wh;
  }
  function findPeriod(sig, minP=4, maxP=80) {
    const n=sig.length; let best=16, bestScore=-Infinity;
    for (let p=minP; p<Math.min(maxP,Math.floor(n/3)); p++) {
      let score=0; for(let i=0;i<n-p;i++) score+=sig[i]*sig[i+p];
      if(score>bestScore){bestScore=score;best=p;}
    }
    return best;
  }
  return { cellH: findPeriod(rowDiff), cellW: findPeriod(colDiff) };
}

function findMosaicOffset(frame, wy, wx, wh, ww, cellH, cellW) {
  const { data, width: W } = frame;
  const margin = Math.max(5, Math.min(25, Math.floor(Math.min(wh,ww)/6)));
  const hRow = new Float32Array(wh);
  for (let y=0;y<wh;y++){let s=0;for(let x=0;x<ww;x++){const i=((wy+y)*W+wx+x)*4;s+=(data[i]+data[i+1]+data[i+2])/3;}hRow[y]=s/ww;}
  const vCol = new Float32Array(ww);
  for (let x=0;x<ww;x++){let s=0;for(let y=0;y<wh;y++){const i=((wy+y)*W+wx+x)*4;s+=(data[i]+data[i+1]+data[i+2])/3;}vCol[x]=s/wh;}
  let mosaicY=0;
  for(let y=margin;y<wh-margin-1;y++){if(Math.abs(hRow[y]-hRow[y+1])>4){mosaicY=y+1;break;}}
  let mosaicX=0;
  for(let x=margin;x<ww-margin-1;x++){if(Math.abs(vCol[x]-vCol[x+1])>4){mosaicX=x+1;break;}}
  while(mosaicY-cellH>0) mosaicY-=cellH;
  while(mosaicX-cellW>0) mosaicX-=cellW;
  return { mosaicY, mosaicX };
}

function accumulateFrame(frame, wy, wx, wh, ww, cellH, cellW, mosaicY, mosaicX, accum, cnt) {
  const { data, width: W, height: H } = frame;
  let y = mosaicY + cellH/2;
  while (y < wh) {
    let x = mosaicX + cellW/2;
    while (x < ww) {
      const yi=Math.round(y), xi=Math.round(x);
      if(yi>=0&&yi<wh&&xi>=0&&xi<ww){
        const sy=wy+yi, sx=wx+xi;
        if(sy>=0&&sy<H&&sx>=0&&sx<W){
          const si=(sy*W+sx)*4;
          if(data[si+3]>0){
            const di=(yi*ww+xi)*4;
            accum[di]+=data[si]; accum[di+1]+=data[si+1]; accum[di+2]+=data[si+2];
            cnt[yi*ww+xi]++;
          }
        }
      }
      x+=cellW;
    }
    y+=cellH;
  }
}

async function fillGaps(accum, cnt, resH, resW, maxIters, onProgress) {
  const N=resH*resW;
  const image=new Float32Array(N*4), filled=new Uint8Array(N);
  for(let i=0;i<N;i++){
    if(cnt[i]>0){
      const n=cnt[i];
      image[i*4]=accum[i*4]/n; image[i*4+1]=accum[i*4+1]/n; image[i*4+2]=accum[i*4+2]/n; image[i*4+3]=255;
      filled[i]=1;
    }
  }
  const tmp=new Float32Array(N*4), tmpFill=new Uint8Array(N);
  for(let iter=0;iter<maxIters;iter++){
    let anyNew=false;
    tmp.set(image); tmpFill.set(filled);
    for(let y=0;y<resH;y++){
      for(let x=0;x<resW;x++){
        const i=y*resW+x;
        if(filled[i]) continue;
        let r=0,g=0,b=0,c=0;
        if(y>0      &&filled[i-resW]){const n=i-resW;r+=image[n*4];g+=image[n*4+1];b+=image[n*4+2];c++;}
        if(y<resH-1 &&filled[i+resW]){const n=i+resW;r+=image[n*4];g+=image[n*4+1];b+=image[n*4+2];c++;}
        if(x>0      &&filled[i-1])   {const n=i-1;   r+=image[n*4];g+=image[n*4+1];b+=image[n*4+2];c++;}
        if(x<resW-1 &&filled[i+1])   {const n=i+1;   r+=image[n*4];g+=image[n*4+1];b+=image[n*4+2];c++;}
        if(c>0){tmp[i*4]=r/c;tmp[i*4+1]=g/c;tmp[i*4+2]=b/c;tmp[i*4+3]=255;tmpFill[i]=1;anyNew=true;}
      }
    }
    image.set(tmp); filled.set(tmpFill);
    if(!anyNew) break;
    if(iter%5===0){onProgress?.(`이미지 복원 중... (${iter+1}/${maxIters})`,84+Math.floor(10*iter/maxIters));await yieldToUI();}
  }
  return image;
}

async function depixelate(file, options, onProgress) {
  const { windowPos=null, windowSize=null, cellSize=null, maxFrames=200 } = options||{};
  onProgress('프레임 추출 중...', 5);
  const { frames, W, H } = await extractFrames(file,(cur,tot)=>{
    onProgress(`프레임 추출 중... (${cur}/${tot})`,5+Math.floor(28*cur/tot));
  }, maxFrames);
  if(!frames.length) throw new Error('프레임을 추출할 수 없습니다.');
  onProgress(`${frames.length}개 프레임 추출 완료`,34);
  await yieldToUI();
  let wy,wx;
  if(windowPos){[wy,wx]=windowPos;}else{const p=detectWindow(frames[0]);wy=p.wy;wx=p.wx;}
  const wh=windowSize?windowSize[0]:H-wy;
  const ww=windowSize?windowSize[1]:W-wx;
  let cellH,cellW;
  if(cellSize){[cellH,cellW]=cellSize;}else{const cs=detectCellSize(frames[0],wy,wx,wh,ww);cellH=cs.cellH;cellW=cs.cellW;}
  onProgress(`격자 크기 감지: ${cellH}×${cellW}px`,38);
  await yieldToUI();
  const accum=new Float32Array(wh*ww*4), cnt=new Float32Array(wh*ww);
  for(let i=0;i<frames.length;i++){
    onProgress(`프레임 처리 중... (${i+1}/${frames.length})`,38+Math.floor(44*(i+1)/frames.length));
    const frame=frames[i];
    let fwy=wy,fwx=wx;
    if(!windowPos){const p=detectWindow(frame);fwy=p.wy;fwx=p.wx;}
    const {mosaicY,mosaicX}=findMosaicOffset(frame,fwy,fwx,wh,ww,cellH,cellW);
    accumulateFrame(frame,fwy,fwx,wh,ww,cellH,cellW,mosaicY,mosaicX,accum,cnt);
    if(i%5===0) await yieldToUI();
  }
  onProgress('이미지 복원 중...',84);
  const maxIters=Math.ceil(Math.max(cellH,cellW)/2)*2+20;
  const image=await fillGaps(accum,cnt,wh,ww,maxIters,onProgress);
  onProgress('완료!',100);
  const canvas=document.createElement('canvas');
  canvas.width=ww; canvas.height=wh;
  const ctx=canvas.getContext('2d');
  const imgData=new ImageData(ww,wh);
  for(let i=0;i<wh*ww*4;i++) imgData.data[i]=Math.max(0,Math.min(255,Math.round(image[i])));
  ctx.putImageData(imgData,0,0);
  return canvas;
}
