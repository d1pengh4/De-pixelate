'use strict';

const yieldToUI = () => new Promise(r => setTimeout(r, 0));

async function extractFrames(file, onProgress, maxFrames = 300) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('영상을 읽을 수 없습니다.'));
    video.src = URL.createObjectURL(file);
  });
  const W = video.videoWidth, H = video.videoHeight, dur = video.duration;
  if (!W || !H || !dur || !isFinite(dur))
    throw new Error('영상 크기 또는 길이를 알 수 없습니다.');

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const nFrames = Math.min(maxFrames, Math.max(20, Math.floor(dur * 15)));
  const step = dur / nFrames;
  const frames = [];

  for (let i = 0; i < nFrames; i++) {
    video.currentTime = step * i + step * 0.05;
    await new Promise(r => { video.onseeked = r; });
    ctx.drawImage(video, 0, 0);
    frames.push(ctx.getImageData(0, 0, W, H));
    onProgress?.(i + 1, nFrames);
    if (i % 5 === 0) await yieldToUI();
  }
  URL.revokeObjectURL(video.src);
  video.src = '';
  return { frames, W, H, duration: dur };
}

function detectCellSize(frame, wy, wx, wh, ww) {
  const { data, width: W } = frame;

  const rowDiff = new Float32Array(Math.max(wh - 1, 1));
  for (let y = 0; y < wh - 1; y++) {
    let s = 0;
    for (let x = 0; x < ww; x++) {
      const a = ((wy + y) * W + wx + x) * 4;
      const b = ((wy + y + 1) * W + wx + x) * 4;
      s += Math.abs((data[a] + data[a+1] + data[a+2]) - (data[b] + data[b+1] + data[b+2]));
    }
    rowDiff[y] = s / ww;
  }

  const colDiff = new Float32Array(Math.max(ww - 1, 1));
  for (let x = 0; x < ww - 1; x++) {
    let s = 0;
    for (let y = 0; y < wh; y++) {
      const a = ((wy + y) * W + wx + x) * 4;
      const b = ((wy + y) * W + wx + x + 1) * 4;
      s += Math.abs((data[a] + data[a+1] + data[a+2]) - (data[b] + data[b+1] + data[b+2]));
    }
    colDiff[x] = s / wh;
  }

  function findPeriod(sig, minP = 4, maxP = 64) {
    const n = sig.length;
    let best = 16, bestScore = -Infinity;
    for (let p = minP; p < Math.min(maxP, Math.floor(n / 2)); p++) {
      let score = 0;
      for (let i = 0; i < n - p; i++) score += sig[i] * sig[i + p];
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  return { cellH: findPeriod(rowDiff), cellW: findPeriod(colDiff) };
}

function findMosaicOffset(frame, wy, wx, wh, ww, cellH, cellW) {
  const { data, width: W } = frame;

  const hRow = new Float32Array(wh);
  for (let y = 0; y < wh; y++) {
    let s = 0;
    for (let x = 0; x < ww; x++) {
      const i = ((wy + y) * W + wx + x) * 4;
      s += data[i] + data[i+1] + data[i+2];
    }
    hRow[y] = s / (ww * 3);
  }
  const rowDiff = new Float32Array(wh - 1);
  for (let y = 0; y < wh - 1; y++) rowDiff[y] = Math.abs(hRow[y+1] - hRow[y]);

  let bestOffY = 0, bestScoreY = -Infinity;
  for (let off = 0; off < cellH; off++) {
    let score = 0;
    for (let y = off; y < wh - 1; y += cellH) score += rowDiff[y];
    if (score > bestScoreY) { bestScoreY = score; bestOffY = off; }
  }

  const vCol = new Float32Array(ww);
  for (let x = 0; x < ww; x++) {
    let s = 0;
    for (let y = 0; y < wh; y++) {
      const i = ((wy + y) * W + wx + x) * 4;
      s += data[i] + data[i+1] + data[i+2];
    }
    vCol[x] = s / (wh * 3);
  }
  const colDiff = new Float32Array(ww - 1);
  for (let x = 0; x < ww - 1; x++) colDiff[x] = Math.abs(vCol[x+1] - vCol[x]);

  let bestOffX = 0, bestScoreX = -Infinity;
  for (let off = 0; off < cellW; off++) {
    let score = 0;
    for (let x = off; x < ww - 1; x += cellW) score += colDiff[x];
    if (score > bestScoreX) { bestScoreX = score; bestOffX = off; }
  }

  return { mosaicY: bestOffY, mosaicX: bestOffX };
}

function accumulateFrame(frame, wy, wx, wh, ww, cellH, cellW, mosaicY, mosaicX, accum, cnt) {
  const { data, width: W, height: H } = frame;
  for (let y = mosaicY + cellH * 0.5; y < wh; y += cellH) {
    for (let x = mosaicX + cellW * 0.5; x < ww; x += cellW) {
      const yi = Math.round(y), xi = Math.round(x);
      if (yi < 0 || yi >= wh || xi < 0 || xi >= ww) continue;
      const sy = wy + yi, sx = wx + xi;
      if (sy < 0 || sy >= H || sx < 0 || sx >= W) continue;
      const si = (sy * W + sx) * 4;
      if (data[si + 3] === 0) continue;
      const di = (yi * ww + xi) * 4;
      accum[di]   += data[si];
      accum[di+1] += data[si+1];
      accum[di+2] += data[si+2];
      cnt[yi * ww + xi]++;
    }
  }
}

async function fillGaps(accum, cnt, resH, resW, maxIters, onProgress) {
  const N = resH * resW;
  const image = new Float32Array(N * 4);
  const filled = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (cnt[i] > 0) {
      const n = cnt[i];
      image[i*4]   = accum[i*4]   / n;
      image[i*4+1] = accum[i*4+1] / n;
      image[i*4+2] = accum[i*4+2] / n;
      image[i*4+3] = 255;
      filled[i] = 1;
    }
  }

  const tmp = new Float32Array(N * 4);
  const tmpFill = new Uint8Array(N);

  for (let iter = 0; iter < maxIters; iter++) {
    let anyNew = false;
    tmp.set(image);
    tmpFill.set(filled);
    for (let y = 0; y < resH; y++) {
      for (let x = 0; x < resW; x++) {
        const i = y * resW + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        if (y > 0      && filled[i - resW]) { r += image[(i-resW)*4]; g += image[(i-resW)*4+1]; b += image[(i-resW)*4+2]; c++; }
        if (y < resH-1 && filled[i + resW]) { r += image[(i+resW)*4]; g += image[(i+resW)*4+1]; b += image[(i+resW)*4+2]; c++; }
        if (x > 0      && filled[i - 1])    { r += image[(i-1)*4];    g += image[(i-1)*4+1];    b += image[(i-1)*4+2];    c++; }
        if (x < resW-1 && filled[i + 1])    { r += image[(i+1)*4];    g += image[(i+1)*4+1];    b += image[(i+1)*4+2];    c++; }
        if (c > 0) {
          tmp[i*4] = r/c; tmp[i*4+1] = g/c; tmp[i*4+2] = b/c; tmp[i*4+3] = 255;
          tmpFill[i] = 1;
          anyNew = true;
        }
      }
    }
    image.set(tmp);
    filled.set(tmpFill);
    if (!anyNew) break;
    if (iter % 5 === 0) {
      onProgress?.(`픽셀 복원 중... (${iter+1}/${maxIters})`, 80 + Math.min(12, Math.floor(12 * iter / maxIters)));
      await yieldToUI();
    }
  }
  return image;
}

async function createOutputVideo(file, restored, wy, wx, wh, ww, W, H, onProgress) {
  onProgress?.('출력 영상 인코딩 중...', 94);

  const reconData = new ImageData(ww, wh);
  for (let i = 0; i < wh * ww * 4; i++) {
    reconData.data[i] = Math.max(0, Math.min(255, Math.round(restored[i])));
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const objUrl = URL.createObjectURL(file);
  video.src = objUrl;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const mimeType = ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      URL.revokeObjectURL(objUrl);
      video.src = '';
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };
    video.onerror = () => reject(new Error('출력 영상 생성 실패'));

    video.oncanplay = () => {
      recorder.start(100);
      const draw = () => {
        ctx.drawImage(video, 0, 0, W, H);
        ctx.putImageData(reconData, wx, wy);
        if (!video.ended && !video.paused) requestAnimationFrame(draw);
      };
      video.onended = () => {
        ctx.drawImage(video, 0, 0, W, H);
        ctx.putImageData(reconData, wx, wy);
        setTimeout(() => recorder.stop(), 400);
      };
      video.play()
        .then(() => requestAnimationFrame(draw))
        .catch(reject);
    };
    video.load();
  });
}

async function depixelate(file, options, onProgress) {
  const { windowPos = null, windowSize = null, cellSize = null, maxFrames = 300 } = options || {};

  onProgress?.('프레임 추출 중...', 5);
  const { frames, W, H } = await extractFrames(
    file,
    (cur, tot) => onProgress?.(`프레임 추출 중... (${cur}/${tot})`, 5 + Math.floor(25 * cur / tot)),
    maxFrames
  );
  if (!frames.length) throw new Error('프레임을 추출할 수 없습니다.');
  onProgress?.(`${frames.length}개 프레임 추출 완료`, 30);
  await yieldToUI();

  const wy = windowPos ? windowPos[0] : 0;
  const wx = windowPos ? windowPos[1] : 0;
  const wh = windowSize ? windowSize[0] : H;
  const ww = windowSize ? windowSize[1] : W;

  let cellH, cellW;
  if (cellSize) {
    [cellH, cellW] = cellSize;
  } else {
    ({ cellH, cellW } = detectCellSize(frames[0], wy, wx, wh, ww));
  }
  onProgress?.(`격자 크기: ${cellH}×${cellW}px`, 33);
  await yieldToUI();

  const accum = new Float32Array(wh * ww * 4);
  const cnt   = new Float32Array(wh * ww);

  for (let i = 0; i < frames.length; i++) {
    onProgress?.(`프레임 분석 중... (${i+1}/${frames.length})`, 33 + Math.floor(45 * (i+1) / frames.length));
    const { mosaicY, mosaicX } = findMosaicOffset(frames[i], wy, wx, wh, ww, cellH, cellW);
    accumulateFrame(frames[i], wy, wx, wh, ww, cellH, cellW, mosaicY, mosaicX, accum, cnt);
    if (i % 5 === 0) await yieldToUI();
  }

  onProgress?.('픽셀 복원 중...', 80);
  const maxIters = Math.ceil(Math.max(cellH, cellW)) * 2 + 10;
  const restored = await fillGaps(accum, cnt, wh, ww, maxIters, onProgress);

  const blob = await createOutputVideo(file, restored, wy, wx, wh, ww, W, H, onProgress);
  onProgress?.('완료!', 100);
  return blob;
}
