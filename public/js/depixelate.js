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
    video.onerror = () => reject(new Error('영상을 읽을 수 없습니다. MP4/WebM 형식을 지원합니다.'));
    video.src = srcUrl;
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
  URL.revokeObjectURL(srcUrl);
  video.src = '';
  return { frames, W, H, duration: dur };
}

// ── Diff-signal computation ───────────────────────────────────────────────────

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

// ── Period detection (max-phase scoring) ──────────────────────────────────────
// For each candidate period p find the phase φ maximising Σ sig[φ+k*p],
// then normalise by nObs = floor(n/p).  Harmonics score lower after
// normalisation, and large vs small periods are treated fairly.

function findPeriod(sig, minP = 4, maxP = 64) {
  const n = sig.length;
  if (n < minP * 2) return minP;

  let best = Math.max(minP, Math.min(16, maxP));
  let bestScore = -Infinity;

  const lim = Math.min(maxP + 1, Math.floor(n / 2));
  for (let p = minP; p < lim; p++) {
    let maxPhase = 0;
    for (let phi = 0; phi < p; phi++) {
      let s = 0;
      for (let k = phi; k < n; k += p) s += sig[k];
      if (s > maxPhase) maxPhase = s;
    }
    const nObs = Math.floor(n / p);
    if (nObs < 2) continue;
    const score = maxPhase / nObs;
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
  const mid = a => a[Math.floor(a.length / 2)];
  return { cellH: mid(hArr), cellW: mid(wArr) };
}

// ── Phase detection ───────────────────────────────────────────────────────────

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
// Start one full cell before mosaicY/mosaicX so cells that straddle the
// window edge are not missed. The yi/xi bounds check discards out-of-range
// centres. Multi-point sampling within each cell reduces compression noise.

function accumulateFrame(frame, wy, wx, wh, ww, cellH, cellW,
                         mosaicY, mosaicX, accum, cnt) {
  const { data, width: W, height: H } = frame;

  const startY = mosaicY - cellH; // ≤ 0 since mosaicY ∈ [0, cellH)
  const startX = mosaicX - cellW;

  const qH = Math.max(1, Math.floor(cellH / 4));
  const qW = Math.max(1, Math.floor(cellW / 4));
  // Sample center + 4 cardinal points (quarter-cell offset) for noise robustness
  const offsets = [[0,0],[qH,0],[-qH,0],[0,qW],[0,-qW]];

  for (let y0 = startY; y0 < wh; y0 += cellH) {
    const yi = Math.round(y0 + cellH / 2);
    if (yi < 0 || yi >= wh) continue;

    for (let x0 = startX; x0 < ww; x0 += cellW) {
      const xi = Math.round(x0 + cellW / 2);
      if (xi < 0 || xi >= ww) continue;

      let sr = 0, sg = 0, sb = 0, sc = 0;
      for (const [dy, dx] of offsets) {
        const sy = wy + yi + dy, sx = wx + xi + dx;
        if (sy < 0 || sy >= H || sx < 0 || sx >= W) continue;
        const si = (sy * W + sx) * 4;
        if (data[si + 3] === 0) continue;
        sr += data[si]; sg += data[si+1]; sb += data[si+2]; sc++;
      }
      if (sc === 0) continue;

      const di = (yi * ww + xi) * 4;
      accum[di]   += sr / sc;
      accum[di+1] += sg / sc;
      accum[di+2] += sb / sc;
      cnt[yi * ww + xi]++;
    }
  }
}

// ── Bilinear gap fill ─────────────────────────────────────────────────────────
// Two independent 1-D linear interpolation passes (horizontal then vertical)
// followed by a weighted combination.  This is O(N) and produces smooth,
// grid-artefact-free results — much better than BFS nearest-neighbour.

async function fillGapsBilinear(accum, cnt, resH, resW, onProgress) {
  const N = resH * resW;

  const kr = new Float32Array(N), kg = new Float32Array(N), kb = new Float32Array(N);
  const known = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (cnt[i] > 0) {
      const n = cnt[i];
      kr[i] = accum[i*4]   / n;
      kg[i] = accum[i*4+1] / n;
      kb[i] = accum[i*4+2] / n;
      known[i] = 1;
    }
  }

  onProgress?.('수평 보간 중...', 82);
  await yieldToUI();

  // ── Horizontal pass ──
  const hr = new Float32Array(N), hg = new Float32Array(N), hb = new Float32Array(N);
  const hw = new Float32Array(N);

  for (let y = 0; y < resH; y++) {
    const base = y * resW;
    let prevX = -1;

    // Interpolate between known pixels
    for (let x = 0; x < resW; x++) {
      if (!known[base + x]) continue;
      if (prevX >= 0) {
        const span = x - prevX;
        for (let fx = prevX + 1; fx < x; fx++) {
          const fi = base + fx;
          const t = (fx - prevX) / span;
          hr[fi] = kr[base+prevX] * (1-t) + kr[base+x] * t;
          hg[fi] = kg[base+prevX] * (1-t) + kg[base+x] * t;
          hb[fi] = kb[base+prevX] * (1-t) + kb[base+x] * t;
          hw[fi] = 1;
        }
      }
      hr[base+x] = kr[base+x]; hg[base+x] = kg[base+x]; hb[base+x] = kb[base+x];
      hw[base+x] = 4; // known pixels get higher weight in final blend
      prevX = x;
    }

    // Extrapolate edges (copy nearest known)
    let firstX = -1, lastX = -1;
    for (let x = 0; x < resW; x++) if (known[base+x]) { if (firstX < 0) firstX = x; lastX = x; }
    if (firstX > 0) {
      for (let x = 0; x < firstX; x++) {
        hw[base+x] = 0.5;
        hr[base+x] = hr[base+firstX]; hg[base+x] = hg[base+firstX]; hb[base+x] = hb[base+firstX];
      }
    }
    if (lastX >= 0 && lastX < resW - 1) {
      for (let x = lastX + 1; x < resW; x++) {
        hw[base+x] = 0.5;
        hr[base+x] = hr[base+lastX]; hg[base+x] = hg[base+lastX]; hb[base+x] = hb[base+lastX];
      }
    }
  }

  onProgress?.('수직 보간 중...', 86);
  await yieldToUI();

  // ── Vertical pass ──
  const vr = new Float32Array(N), vg = new Float32Array(N), vb = new Float32Array(N);
  const vw = new Float32Array(N);

  for (let x = 0; x < resW; x++) {
    let prevY = -1;

    for (let y = 0; y < resH; y++) {
      const i = y * resW + x;
      if (!known[i]) continue;
      if (prevY >= 0) {
        const span = y - prevY;
        for (let fy = prevY + 1; fy < y; fy++) {
          const fi = fy * resW + x;
          const t = (fy - prevY) / span;
          vr[fi] = kr[prevY*resW+x] * (1-t) + kr[i] * t;
          vg[fi] = kg[prevY*resW+x] * (1-t) + kg[i] * t;
          vb[fi] = kb[prevY*resW+x] * (1-t) + kb[i] * t;
          vw[fi] = 1;
        }
      }
      vr[i] = kr[i]; vg[i] = kg[i]; vb[i] = kb[i]; vw[i] = 4;
      prevY = y;
    }

    let firstY = -1, lastY = -1;
    for (let y = 0; y < resH; y++) if (known[y*resW+x]) { if (firstY < 0) firstY = y; lastY = y; }
    if (firstY > 0) {
      for (let y = 0; y < firstY; y++) {
        const fi = y*resW+x;
        vw[fi] = 0.5; vr[fi] = vr[firstY*resW+x]; vg[fi] = vg[firstY*resW+x]; vb[fi] = vb[firstY*resW+x];
      }
    }
    if (lastY >= 0 && lastY < resH - 1) {
      for (let y = lastY + 1; y < resH; y++) {
        const fi = y*resW+x;
        vw[fi] = 0.5; vr[fi] = vr[lastY*resW+x]; vg[fi] = vg[lastY*resW+x]; vb[fi] = vb[lastY*resW+x];
      }
    }
  }

  onProgress?.('이미지 합성 중...', 89);
  await yieldToUI();

  // ── Combine H + V (weighted average) ──
  const image = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const wt = hw[i] + vw[i];
    if (wt > 0) {
      image[i*4]   = (hr[i]*hw[i] + vr[i]*vw[i]) / wt;
      image[i*4+1] = (hg[i]*hw[i] + vg[i]*vw[i]) / wt;
      image[i*4+2] = (hb[i]*hw[i] + vb[i]*vw[i]) / wt;
    }
    image[i*4+3] = 255;
  }
  return image;
}

// ── Unsharp masking ───────────────────────────────────────────────────────────
// Enhance edges lost during the averaging/interpolation step.

function applyUnsharpMask(image, w, h, amount = 0.6) {
  const N = w * h;
  const blurred = new Float32Array(N * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y+dy, nx = x+dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const ni = (ny*w+nx)*4;
          sr += image[ni]; sg += image[ni+1]; sb += image[ni+2]; sc++;
        }
      }
      const i = (y*w+x)*4;
      blurred[i] = sr/sc; blurred[i+1] = sg/sc; blurred[i+2] = sb/sc; blurred[i+3] = 255;
    }
  }

  const result = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const c = i * 4;
    result[c]   = Math.max(0, Math.min(255, image[c]   + amount*(image[c]   - blurred[c])));
    result[c+1] = Math.max(0, Math.min(255, image[c+1] + amount*(image[c+1] - blurred[c+1])));
    result[c+2] = Math.max(0, Math.min(255, image[c+2] + amount*(image[c+2] - blurred[c+2])));
    result[c+3] = 255;
  }
  return result;
}

// ── Output video via MediaRecorder ────────────────────────────────────────────

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
    const stopOnce = () => { if (!stopped) { stopped = true; recorder.stop(); } };

    recorder.onstop = () => {
      URL.revokeObjectURL(objUrl);
      video.src = '';
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };

    video.onerror = () => { stopOnce(); reject(new Error('출력 영상 생성 실패')); };

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
    if (i % 10 === 0) {
      onProgress?.(
        `프레임 분석 중... (${i+1}/${frames.length})`,
        33 + Math.floor(45 * (i+1) / frames.length)
      );
    }
    const { mosaicY, mosaicX } =
      findMosaicOffset(frames[i], wy, wx, wh, ww, cellH, cellW);
    accumulateFrame(frames[i], wy, wx, wh, ww, cellH, cellW,
                    mosaicY, mosaicX, accum, cnt);
    if (i % 5 === 0) await yieldToUI();
  }

  const totalSamples = cnt.reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
  if (totalSamples === 0)
    throw new Error('픽셀을 누적할 수 없습니다. 셀 크기를 수동으로 지정해 보세요.');

  // 5. Bilinear gap fill (replaces BFS — smoother, no blur cascade)
  onProgress?.('픽셀 보간 중...', 80);
  const restored = await fillGapsBilinear(accum, cnt, wh, ww, onProgress);

  // 6. Unsharp mask to recover edges lost during averaging
  onProgress?.('이미지 선명화 중...', 90);
  const sharpened = applyUnsharpMask(restored, ww, wh, 0.6);

  // 7. Build final ImageData
  const reconData = new ImageData(ww, wh);
  for (let i = 0; i < wh * ww * 4; i++) {
    reconData.data[i] = Math.max(0, Math.min(255, Math.round(sharpened[i])));
  }

  // 8. Encode output video
  const blob = await createOutputVideo(
    file, reconData, wy, wx, W, H, duration, onProgress
  );

  onProgress?.('완료!', 100);
  return { blob, reconData, cellH, cellW, frameCount: frames.length };
}
