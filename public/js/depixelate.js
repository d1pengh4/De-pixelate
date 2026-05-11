'use strict';

const yieldToUI = () => new Promise(r => setTimeout(r, 0));

// ── Frame extraction ──────────────────────────────────────────────────────────

async function extractFrames(file, onProgress, maxFrames = 300) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;

  const srcUrl = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error(
      '영상을 읽을 수 없습니다. MP4/WebM 형식을 지원합니다.'
    ));
    video.src = srcUrl;
  });

  const W = video.videoWidth, H = video.videoHeight, dur = video.duration;
  if (!W || !H || !dur || !isFinite(dur))
    throw new Error('영상 크기 또는 길이를 알 수 없습니다.');

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const nFrames = Math.min(maxFrames, Math.max(20, Math.floor(dur * 15)));
  const step    = dur / nFrames;
  const frames  = [];

  for (let i = 0; i < nFrames; i++) {
    video.currentTime = step * i + step * 0.05;
    await new Promise(r => { video.onseeked = r; });
    ctx.drawImage(video, 0, 0);
    frames.push(ctx.getImageData(0, 0, W, H));
    onProgress?.(i + 1, nFrames);
    if (i % 5 === 0) await yieldToUI();
  }
  URL.revokeObjectURL(srcUrl);
  video.src = '';
  return { frames, W, H, duration: dur };
}

// ── Diff-signal computation ───────────────────────────────────────────────────
// Row / column mean-brightness difference signals for the selected window.

function computeDiffSignals(frame, wy, wx, wh, ww) {
  const { data, width: W } = frame;

  const rowDiff = new Float32Array(Math.max(wh - 1, 1));
  for (let y = 0; y < wh - 1; y++) {
    let s = 0;
    for (let x = 0; x < ww; x++) {
      const a = ((wy + y)     * W + wx + x) * 4;
      const b = ((wy + y + 1) * W + wx + x) * 4;
      s += Math.abs((data[a] + data[a+1] + data[a+2]) -
                    (data[b] + data[b+1] + data[b+2]));
    }
    rowDiff[y] = s / ww;
  }

  const colDiff = new Float32Array(Math.max(ww - 1, 1));
  for (let x = 0; x < ww - 1; x++) {
    let s = 0;
    for (let y = 0; y < wh; y++) {
      const a = ((wy + y) * W + wx + x)     * 4;
      const b = ((wy + y) * W + wx + x + 1) * 4;
      s += Math.abs((data[a] + data[a+1] + data[a+2]) -
                    (data[b] + data[b+1] + data[b+2]));
    }
    colDiff[x] = s / wh;
  }

  return { rowDiff, colDiff };
}

// ── Period detection (improved: max-phase scoring) ────────────────────────────
// For each candidate period p we find the phase φ that maximises the sum of
// sig at positions φ, φ+p, φ+2p, … then normalise by the number of samples.
// This is more robust than raw autocorrelation because:
//   • harmonics of the true period (p/2, 2p, …) score lower after normalisation
//   • large periods are not unfairly penalised

function findPeriod(sig, minP = 4, maxP = 64) {
  const n = sig.length;
  if (n < minP * 2) return minP;

  let best = Math.max(minP, Math.min(16, maxP));
  let bestScore = -Infinity;

  const lim = Math.min(maxP + 1, Math.floor(n / 2));
  for (let p = minP; p < lim; p++) {
    // For each phase offset find the maximum per-sample score
    let maxPhase = 0;
    for (let phi = 0; phi < p; phi++) {
      let s = 0, cnt = 0;
      for (let k = phi; k < n; k += p) { s += sig[k]; cnt++; }
      if (s > maxPhase) maxPhase = s;
    }
    const nObs = Math.floor(n / p);
    if (nObs < 2) continue;
    const score = maxPhase / nObs;  // normalised per-sample score
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// ── Cell size — single frame ──────────────────────────────────────────────────

function detectCellSize(frame, wy, wx, wh, ww) {
  const { rowDiff, colDiff } = computeDiffSignals(frame, wy, wx, wh, ww);
  return { cellH: findPeriod(rowDiff), cellW: findPeriod(colDiff) };
}

// ── Cell size — robust median across multiple frames ──────────────────────────

function detectCellSizeRobust(frames, wy, wx, wh, ww) {
  const nSamples = Math.min(frames.length, 9);
  const hArr = [], wArr = [];
  for (let i = 0; i < nSamples; i++) {
    const idx = Math.floor(i * frames.length / nSamples);
    const { cellH, cellW } = detectCellSize(frames[idx], wy, wx, wh, ww);
    hArr.push(cellH);
    wArr.push(cellW);
  }
  hArr.sort((a, b) => a - b);
  wArr.sort((a, b) => a - b);
  const mid = i => i[Math.floor(i.length / 2)];
  return { cellH: mid(hArr), cellW: mid(wArr) };
}

// ── Phase detection (per frame) ───────────────────────────────────────────────
// Score every candidate phase offset and pick the one where cell-boundary
// positions accumulate the most signal energy.

function findMosaicOffset(frame, wy, wx, wh, ww, cellH, cellW) {
  const { rowDiff, colDiff } = computeDiffSignals(frame, wy, wx, wh, ww);

  let bestOffY = 0, bestScoreY = -Infinity;
  for (let off = 0; off < cellH; off++) {
    let s = 0;
    for (let y = off; y < wh - 1; y += cellH) s += rowDiff[y];
    if (s > bestScoreY) { bestScoreY = s; bestOffY = off; }
  }

  let bestOffX = 0, bestScoreX = -Infinity;
  for (let off = 0; off < cellW; off++) {
    let s = 0;
    for (let x = off; x < ww - 1; x += cellW) s += colDiff[x];
    if (s > bestScoreX) { bestScoreX = s; bestOffX = off; }
  }

  return { mosaicY: bestOffY, mosaicX: bestOffX };
}

// ── Pixel accumulation ────────────────────────────────────────────────────────
// For this frame, the mosaic grid has boundaries at (mosaicY, mosaicX).
// Cell centres are at mosaicY+cellH/2, mosaicY+3*cellH/2, …
// We read the source pixel at each centre and add it to the accumulation buffer.
// Different frames have different (mosaicY, mosaicX), so over many frames every
// sub-cell position gets sampled at least once.

function accumulateFrame(frame, wy, wx, wh, ww, cellH, cellW,
                         mosaicY, mosaicX, accum, cnt) {
  const { data, width: W, height: H } = frame;

  for (let y = mosaicY + cellH * 0.5; y < wh; y += cellH) {
    for (let x = mosaicX + cellW * 0.5; x < ww; x += cellW) {
      const yi = Math.round(y);
      const xi = Math.round(x);
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

// ── BFS gap fill ──────────────────────────────────────────────────────────────
// Sampled pixels cover ~1/(cellH*cellW) of positions. BFS propagates colours
// to neighbours until every pixel is filled. The iteration count is bounded
// by the max gap size (≈ cell diameter).

async function fillGaps(accum, cnt, resH, resW, maxIters, onProgress) {
  const N = resH * resW;
  const image  = new Float32Array(N * 4);
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

  const tmp     = new Float32Array(N * 4);
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
      onProgress?.(`픽셀 복원 중... (${iter+1}/${maxIters})`,
        80 + Math.min(10, Math.floor(10 * iter / maxIters)));
      await yieldToUI();
    }
  }
  return image;
}

// ── Output video via MediaRecorder ───────────────────────────────────────────
// Plays the original video through a canvas while overlaying the restored
// ImageData on the selected region. Records up to MAX_RECORD_SEC seconds.

const MAX_RECORD_SEC = 60;

async function createOutputVideo(file, reconData, wy, wx, W, H, duration, onProgress) {
  onProgress?.('출력 영상 인코딩 중...', 92);

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

  const stream   = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks   = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  const recordSec = Math.min(duration, MAX_RECORD_SEC);

  return new Promise((resolve, reject) => {
    let stopped = false;
    const stopOnce = () => {
      if (!stopped) { stopped = true; recorder.stop(); }
    };

    recorder.onstop = () => {
      URL.revokeObjectURL(objUrl);
      video.src = '';
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };

    video.onerror = () => {
      stopOnce();
      reject(new Error('출력 영상 생성 실패'));
    };

    video.oncanplay = () => {
      recorder.start(100);
      let rafId;

      const draw = () => {
        ctx.drawImage(video, 0, 0, W, H);
        ctx.putImageData(reconData, wx, wy);
        if (!video.ended && !video.paused && video.currentTime < recordSec) {
          rafId = requestAnimationFrame(draw);
        } else {
          cancelAnimationFrame(rafId);
          ctx.drawImage(video, 0, 0, W, H);
          ctx.putImageData(reconData, wx, wy);
          setTimeout(stopOnce, 400);
        }
      };

      video.onended = () => {
        cancelAnimationFrame(rafId);
        ctx.drawImage(video, 0, 0, W, H);
        ctx.putImageData(reconData, wx, wy);
        setTimeout(stopOnce, 400);
      };

      video.play().then(() => { rafId = requestAnimationFrame(draw); }).catch(reject);
    };

    video.load();
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function depixelate(file, options, onProgress) {
  const {
    windowPos  = null,
    windowSize = null,
    cellSize   = null,
    maxFrames  = 300,
  } = options || {};

  // 1. Extract frames
  onProgress?.('프레임 추출 중...', 5);
  const { frames, W, H, duration } = await extractFrames(
    file,
    (cur, tot) => onProgress?.(
      `프레임 추출 중... (${cur}/${tot})`,
      5 + Math.floor(25 * cur / tot)
    ),
    maxFrames
  );
  if (!frames.length) throw new Error('프레임을 추출할 수 없습니다.');
  onProgress?.(`${frames.length}개 프레임 추출 완료`, 30);
  await yieldToUI();

  // 2. Window bounds
  const wy = windowPos  ? windowPos[0]  : 0;
  const wx = windowPos  ? windowPos[1]  : 0;
  const wh = windowSize ? windowSize[0] : H;
  const ww = windowSize ? windowSize[1] : W;

  if (wh < 8 || ww < 8)
    throw new Error('선택 영역이 너무 작습니다. 더 큰 영역을 드래그하세요.');

  // 3. Cell size
  let cellH, cellW;
  if (cellSize) {
    [cellH, cellW] = cellSize;
  } else {
    onProgress?.('격자 크기 감지 중...', 31);
    ({ cellH, cellW } = detectCellSizeRobust(frames, wy, wx, wh, ww));
  }
  onProgress?.(`격자 크기: ${cellH}×${cellW}px`, 33);
  await yieldToUI();

  // 4. Accumulate across frames
  const accum = new Float32Array(wh * ww * 4);
  const cnt   = new Float32Array(wh * ww);

  for (let i = 0; i < frames.length; i++) {
    onProgress?.(
      `프레임 분석 중... (${i+1}/${frames.length})`,
      33 + Math.floor(45 * (i+1) / frames.length)
    );
    const { mosaicY, mosaicX } =
      findMosaicOffset(frames[i], wy, wx, wh, ww, cellH, cellW);
    accumulateFrame(frames[i], wy, wx, wh, ww, cellH, cellW,
                    mosaicY, mosaicX, accum, cnt);
    if (i % 5 === 0) await yieldToUI();
  }

  // Check that we actually got samples
  const totalSamples = cnt.reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
  if (totalSamples === 0)
    throw new Error('픽셀을 누적할 수 없습니다. 셀 크기를 수동으로 지정해 보세요.');

  // 5. Fill gaps
  onProgress?.('픽셀 복원 중...', 80);
  const maxIters = Math.ceil(Math.max(cellH, cellW)) * 2 + 10;
  const restored = await fillGaps(accum, cnt, wh, ww, maxIters, onProgress);

  // 6. Build ImageData for the restored region
  const reconData = new ImageData(ww, wh);
  for (let i = 0; i < wh * ww * 4; i++) {
    reconData.data[i] = Math.max(0, Math.min(255, Math.round(restored[i])));
  }

  // 7. Encode output video
  const blob = await createOutputVideo(
    file, reconData, wy, wx, W, H, duration, onProgress
  );

  onProgress?.('완료!', 100);
  return { blob, reconData, cellH, cellW, frameCount: frames.length };
}
