'use strict';

const $ = id => document.getElementById(id);

const dropZone      = $('drop-zone');
const fileInput     = $('file-input');
const fileInfo      = $('file-info');
const fileNameEl    = $('file-name');
const fileSizeEl    = $('file-size');
const removeBtn     = $('remove-file');
const previewWrap   = $('preview-wrap');
const previewCanvas = $('preview-canvas');
const selectionInfo = $('selection-info');
const cellWInput    = $('cell-w');
const cellHInput    = $('cell-h');
const processBtn    = $('process-btn');

const uploadSec   = $('upload-section');
const progressSec = $('progress-section');
const resultSec   = $('result-section');
const errorSec    = $('error-section');

const progressBar = $('progress-bar');
const stageEl     = $('progress-stage');
const pctEl       = $('progress-pct');

const resultVideo  = $('result-video');
const downloadBtn  = $('download-btn');
const imgDownBtn   = $('img-download-btn');
const newBtn       = $('new-btn');
const errorMsgEl   = $('error-msg');
const retryBtn     = $('error-retry-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFile   = null;
let firstFrameData = null;
let videoW = 0, videoH = 0;
let selection      = null;   // { x, y, w, h } in video pixel coords
let resultBlobUrl  = null;
let resultImgUrl   = null;

// Drag state
let dragStart  = null;
let isDragging = false;

// ── Utility ───────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── File loading ──────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
removeBtn.addEventListener('click', clearFile);

async function setFile(f) {
  selectedFile   = f;
  firstFrameData = null;
  videoW = 0; videoH = 0;
  selection = null;
  processBtn.disabled = true;
  selectionInfo.textContent = '';

  fileNameEl.textContent = f.name;
  fileSizeEl.textContent = fmtBytes(f.size);
  fileInfo.classList.remove('hidden');
  dropZone.classList.add('hidden');

  try {
    const { imageData, W, H } = await getFirstFrame(f);
    firstFrameData = imageData;
    videoW = W; videoH = H;
    previewCanvas.width  = W;
    previewCanvas.height = H;
    previewCanvas.getContext('2d').putImageData(firstFrameData, 0, 0);
    previewWrap.classList.remove('hidden');
    selectionInfo.textContent = '모자이크 영역을 드래그하여 선택하세요';
  } catch (err) {
    console.warn('Preview failed:', err);
    previewWrap.classList.add('hidden');
    // Still allow processing without preview
    selection = { x: 0, y: 0, w: 999999, h: 999999 }; // full frame
    processBtn.disabled = false;
    selectionInfo.textContent = '미리보기 불가 — 전체 영상 처리';
  }
}

function clearFile() {
  selectedFile   = null;
  firstFrameData = null;
  selection      = null;
  dragStart      = null;
  isDragging     = false;
  videoW = 0; videoH = 0;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  previewWrap.classList.add('hidden');
  selectionInfo.textContent = '';
  processBtn.disabled = true;
}

function getFirstFrame(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    const done = () => URL.revokeObjectURL(url);

    video.onerror = () => { done(); reject(new Error('첫 프레임 로드 실패')); };

    video.onloadedmetadata = () => {
      const W = video.videoWidth, H = video.videoHeight;
      if (!W || !H) { done(); reject(new Error('영상 크기 불명')); return; }
      video.currentTime = Math.min(0.5, (video.duration || 1) * 0.05);
      video.onseeked = () => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, W, H);
        done();
        resolve({ imageData: ctx.getImageData(0, 0, W, H), W, H });
      };
    };
    video.src = url;
  });
}

// ── Drag-to-select on previewCanvas ───────────────────────────────────────────

function toVideoCoords(e) {
  const rect = previewCanvas.getBoundingClientRect();
  return {
    vx: Math.max(0, Math.min(videoW - 1, (e.clientX - rect.left) * (videoW / rect.width))),
    vy: Math.max(0, Math.min(videoH - 1, (e.clientY - rect.top)  * (videoH / rect.height))),
  };
}

function drawSelection(sel) {
  if (!firstFrameData) return;
  const ctx = previewCanvas.getContext('2d');
  const cw  = previewCanvas.width;
  const ch  = previewCanvas.height;

  ctx.putImageData(firstFrameData, 0, 0);
  if (!sel || sel.w < 2 || sel.h < 2) return;

  const { x, y, w, h } = sel;

  // Dark vignette outside selection
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  if (y > 0)         ctx.fillRect(0,     0,      cw,           y);
  if (y + h < ch)    ctx.fillRect(0,     y + h,  cw,           ch - (y + h));
  if (x > 0)         ctx.fillRect(0,     y,      x,            h);
  if (x + w < cw)    ctx.fillRect(x + w, y,      cw - (x + w), h);
  ctx.restore();

  // Dashed border
  ctx.save();
  ctx.strokeStyle = '#6c6fff';
  ctx.lineWidth   = Math.max(1.5, cw / 400);
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();

  // Corner handles
  const hs = Math.max(6, Math.round(cw / 100));
  ctx.save();
  ctx.fillStyle  = '#6c6fff';
  ctx.setLineDash([]);
  for (const [cx, cy] of [[x, y], [x+w-hs, y], [x, y+h-hs], [x+w-hs, y+h-hs]])
    ctx.fillRect(cx, cy, hs, hs);
  ctx.restore();
}

previewCanvas.addEventListener('pointerdown', e => {
  if (!firstFrameData) return;
  e.preventDefault();
  previewCanvas.setPointerCapture(e.pointerId);
  const { vx, vy } = toVideoCoords(e);
  dragStart  = { vx, vy };
  isDragging = true;
  selection  = null;
  processBtn.disabled = true;
  selectionInfo.textContent = '';
  drawSelection(null);
});

previewCanvas.addEventListener('pointermove', e => {
  if (!isDragging || !dragStart) return;
  e.preventDefault();
  const { vx, vy } = toVideoCoords(e);
  const x = Math.min(dragStart.vx, vx), y = Math.min(dragStart.vy, vy);
  const w = Math.abs(vx - dragStart.vx), h = Math.abs(vy - dragStart.vy);
  const drag = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  drawSelection(drag);
  selectionInfo.textContent = `${Math.round(w)} × ${Math.round(h)} px`;
});

previewCanvas.addEventListener('pointerup', e => {
  if (!isDragging || !dragStart) return;
  e.preventDefault();
  isDragging = false;
  const { vx, vy } = toVideoCoords(e);
  const x = Math.min(dragStart.vx, vx), y = Math.min(dragStart.vy, vy);
  const w = Math.abs(vx - dragStart.vx), h = Math.abs(vy - dragStart.vy);
  dragStart = null;

  if (w >= 10 && h >= 10) {
    selection = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    drawSelection(selection);
    selectionInfo.textContent =
      `선택 완료: ${selection.w} × ${selection.h}px  (${selection.x}, ${selection.y})`;
    processBtn.disabled = false;
  } else {
    selection = null;
    drawSelection(null);
    selectionInfo.textContent = '너무 작음 — 다시 드래그 (최소 10×10px)';
    processBtn.disabled = true;
  }
});

previewCanvas.addEventListener('pointercancel', () => {
  isDragging = false; dragStart = null;
  drawSelection(selection);
});

// ── Processing ────────────────────────────────────────────────────────────────
processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile || !selection) return;

  const cw = parseFloat(cellWInput.value) || null;
  const ch = parseFloat(cellHInput.value) || null;

  // Clamp selection to actual video bounds
  const sx = Math.max(0, selection.x);
  const sy = Math.max(0, selection.y);
  const sw = Math.min(selection.w, videoW - sx || selection.w);
  const sh = Math.min(selection.h, videoH - sy || selection.h);

  const options = {
    windowPos:  [sy, sx],
    windowSize: [sh, sw],
    cellSize:   (ch && cw) ? [ch, cw] : null,
    maxFrames:  300,
  };

  showSection('progress');
  setProgress(0, '시작 중...');

  try {
    const result = await depixelate(
      selectedFile,
      options,
      (stage, pct) => setProgress(pct, stage)
    );
    showResult(result);
  } catch (err) {
    showError(err.message || String(err));
  }
}

// ── Result display ────────────────────────────────────────────────────────────
function showResult({ blob, reconData, cellH, cellW, frameCount }) {
  // Revoke old URLs
  if (resultBlobUrl) { URL.revokeObjectURL(resultBlobUrl); resultBlobUrl = null; }
  if (resultImgUrl)  { URL.revokeObjectURL(resultImgUrl);  resultImgUrl  = null; }

  // Video
  resultBlobUrl = URL.createObjectURL(blob);
  resultVideo.src = resultBlobUrl;
  resultVideo.load();

  downloadBtn.onclick = () => {
    const a = document.createElement('a');
    a.href     = resultBlobUrl;
    a.download = 'depixelated_' +
      (selectedFile?.name?.replace(/\.[^.]+$/, '') || 'result') + '.webm';
    a.click();
  };

  // Static PNG from reconData (always works as fallback)
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = reconData.width; tmpCanvas.height = reconData.height;
  tmpCanvas.getContext('2d').putImageData(reconData, 0, 0);
  tmpCanvas.toBlob(imgBlob => {
    if (!imgBlob) return;
    resultImgUrl = URL.createObjectURL(imgBlob);
    imgDownBtn.onclick = () => {
      const a = document.createElement('a');
      a.href     = resultImgUrl;
      a.download = 'depixelated_' +
        (selectedFile?.name?.replace(/\.[^.]+$/, '') || 'result') + '.png';
      a.click();
    };
    imgDownBtn.classList.remove('hidden');
  }, 'image/png');

  // Show info
  const infoEl = $('result-info');
  if (infoEl) {
    infoEl.textContent =
      `감지된 격자: ${cellH}×${cellW}px · 분석 프레임: ${frameCount}개`;
  }

  showSection('result');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showSection(name) {
  [uploadSec, progressSec, resultSec, errorSec].forEach(s => s.classList.add('hidden'));
  ({ upload: uploadSec, progress: progressSec, result: resultSec, error: errorSec }
    [name] || uploadSec).classList.remove('hidden');
}

function setProgress(pct, stage) {
  progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  stageEl.textContent = stage || '';
  pctEl.textContent   = Math.round(pct) + '%';
}

function showError(msg) {
  errorMsgEl.textContent = msg;
  showSection('error');
}

function reset() {
  if (resultBlobUrl) { URL.revokeObjectURL(resultBlobUrl); resultBlobUrl = null; }
  if (resultImgUrl)  { URL.revokeObjectURL(resultImgUrl);  resultImgUrl  = null; }
  resultVideo.src = '';
  imgDownBtn.classList.add('hidden');
  clearFile();
  setProgress(0, '대기 중...');
  showSection('upload');
}

newBtn.addEventListener('click', reset);
retryBtn.addEventListener('click', reset);
