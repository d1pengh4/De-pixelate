'use strict';

// ── Element references ──────────────────────────────────────────────────────
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
const newBtn       = $('new-btn');
const errorMsgEl   = $('error-msg');
const retryBtn     = $('error-retry-btn');

// ── State ───────────────────────────────────────────────────────────────────
let selectedFile   = null;
let firstFrameData = null;   // ImageData from first video frame
let videoW = 0, videoH = 0;  // native video dimensions
let selection      = null;   // { x, y, w, h } in video pixel coords
let resultBlobUrl  = null;

// Drag state
let dragStart   = null;   // { vx, vy } in video coords at pointer-down
let isDragging  = false;

// ── Utility ─────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── File loading ─────────────────────────────────────────────────────────────
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
  selectedFile = f;
  fileNameEl.textContent = f.name;
  fileSizeEl.textContent = fmtBytes(f.size);
  fileInfo.classList.remove('hidden');
  dropZone.classList.add('hidden');

  // Reset selection state
  selection      = null;
  firstFrameData = null;
  videoW = 0;
  videoH = 0;
  processBtn.disabled = true;
  selectionInfo.textContent = '';

  try {
    const { imageData, W, H } = await getFirstFrame(f);
    firstFrameData = imageData;
    videoW = W;
    videoH = H;
    previewCanvas.width  = W;
    previewCanvas.height = H;
    const pctx = previewCanvas.getContext('2d');
    pctx.putImageData(firstFrameData, 0, 0);
    previewWrap.classList.remove('hidden');
  } catch (err) {
    console.warn('Preview frame extraction failed:', err);
    previewWrap.classList.add('hidden');
  }
}

function clearFile() {
  selectedFile   = null;
  firstFrameData = null;
  selection      = null;
  dragStart      = null;
  isDragging     = false;
  videoW = 0;
  videoH = 0;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  previewWrap.classList.add('hidden');
  selectionInfo.textContent = '';
  processBtn.disabled = true;
}

/**
 * Extract the first usable frame from a video file.
 * Returns Promise<{ imageData, W, H }>
 */
function getFirstFrame(file) {
  return new Promise((resolve, reject) => {
    const video  = document.createElement('video');
    video.muted      = true;
    video.playsInline = true;

    const objUrl = URL.createObjectURL(file);

    const cleanup = () => URL.revokeObjectURL(objUrl);

    video.onerror = () => {
      cleanup();
      reject(new Error('첫 프레임을 읽을 수 없습니다.'));
    };

    video.onloadedmetadata = () => {
      const W = video.videoWidth;
      const H = video.videoHeight;
      if (!W || !H) {
        cleanup();
        reject(new Error('영상 크기를 알 수 없습니다.'));
        return;
      }

      const seekTime = Math.min(0.5, (video.duration || 1) * 0.1);
      video.currentTime = seekTime;

      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, W, H);
        const imageData = ctx.getImageData(0, 0, W, H);
        cleanup();
        resolve({ imageData, W, H });
      };
    };

    video.src = objUrl;
  });
}

// ── Drag selection on previewCanvas ─────────────────────────────────────────

/**
 * Convert a PointerEvent to video-space coordinates, clamped to video bounds.
 */
function toVideoCoords(e) {
  const rect   = previewCanvas.getBoundingClientRect();
  const scaleX = videoW / rect.width;
  const scaleY = videoH / rect.height;
  return {
    vx: Math.max(0, Math.min(videoW - 1, (e.clientX - rect.left) * scaleX)),
    vy: Math.max(0, Math.min(videoH - 1, (e.clientY - rect.top)  * scaleY)),
  };
}

/**
 * Redraw the canvas with the first frame, and overlay the selection if provided.
 * sel: { x, y, w, h } in video/canvas pixel coords, or null.
 */
function drawSelection(sel) {
  if (!firstFrameData) return;
  const ctx = previewCanvas.getContext('2d');
  const cw  = previewCanvas.width;
  const ch  = previewCanvas.height;

  ctx.putImageData(firstFrameData, 0, 0);

  if (!sel || sel.w < 2 || sel.h < 2) return;

  const { x, y, w, h } = sel;

  // Semi-transparent dark overlay on the four strips outside the selection
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.52)';
  if (y > 0)          ctx.fillRect(0,       0,      cw,           y);
  if (y + h < ch)     ctx.fillRect(0,       y + h,  cw,           ch - (y + h));
  if (x > 0)          ctx.fillRect(0,       y,      x,            h);
  if (x + w < cw)     ctx.fillRect(x + w,   y,      cw - (x + w), h);
  ctx.restore();

  // Dashed accent border
  ctx.save();
  ctx.strokeStyle = '#6c6fff';
  ctx.lineWidth   = Math.max(1.5, Math.round(cw / 400));
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();

  // Small square corner handles
  const hs = Math.max(6, Math.round(cw / 120));
  ctx.save();
  ctx.fillStyle = '#6c6fff';
  ctx.setLineDash([]);
  const corners = [
    [x,         y        ],
    [x + w - hs, y        ],
    [x,         y + h - hs],
    [x + w - hs, y + h - hs],
  ];
  for (const [cx2, cy2] of corners) ctx.fillRect(cx2, cy2, hs, hs);
  ctx.restore();
}

previewCanvas.addEventListener('pointerdown', e => {
  if (!firstFrameData) return;
  e.preventDefault();
  previewCanvas.setPointerCapture(e.pointerId);

  const { vx, vy } = toVideoCoords(e);
  dragStart  = { vx, vy };
  isDragging = true;

  // Clear existing selection while dragging
  selection = null;
  processBtn.disabled = true;
  selectionInfo.textContent = '';
  drawSelection(null);
});

previewCanvas.addEventListener('pointermove', e => {
  if (!isDragging || !dragStart) return;
  e.preventDefault();

  const { vx, vy } = toVideoCoords(e);
  const x = Math.min(dragStart.vx, vx);
  const y = Math.min(dragStart.vy, vy);
  const w = Math.abs(vx - dragStart.vx);
  const h = Math.abs(vy - dragStart.vy);

  const drag = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  drawSelection(drag);
  selectionInfo.textContent = `${Math.round(w)} × ${Math.round(h)} px  (${Math.round(x)}, ${Math.round(y)})`;
});

previewCanvas.addEventListener('pointerup', e => {
  if (!isDragging || !dragStart) return;
  e.preventDefault();
  isDragging = false;

  const { vx, vy } = toVideoCoords(e);
  const x = Math.min(dragStart.vx, vx);
  const y = Math.min(dragStart.vy, vy);
  const w = Math.abs(vx - dragStart.vx);
  const h = Math.abs(vy - dragStart.vy);
  dragStart = null;

  if (w >= 10 && h >= 10) {
    selection = {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
    drawSelection(selection);
    selectionInfo.textContent =
      `선택 완료: ${selection.w} × ${selection.h} px  (${selection.x}, ${selection.y})`;
    processBtn.disabled = false;
  } else {
    selection = null;
    drawSelection(null);
    selectionInfo.textContent = '영역이 너무 작습니다. 다시 드래그하세요 (최소 10×10px)';
    processBtn.disabled = true;
  }
});

previewCanvas.addEventListener('pointercancel', () => {
  isDragging = false;
  dragStart  = null;
  drawSelection(selection);
});

// ── Processing ───────────────────────────────────────────────────────────────
processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile || !selection) return;

  const cw = parseFloat(cellWInput.value) || null;
  const ch = parseFloat(cellHInput.value) || null;

  const options = {
    windowPos:  [selection.y, selection.x],
    windowSize: [selection.h, selection.w],
    cellSize:   (ch != null && cw != null) ? [ch, cw] : null,
    maxFrames:  300,
  };

  showSection('progress');
  setProgress(0, '시작 중...');

  try {
    const blob = await depixelate(
      selectedFile,
      options,
      (stage, pct) => setProgress(pct, stage)
    );
    showResult(blob);
  } catch (err) {
    showError(err.message || String(err));
  }
}

// ── showResult ───────────────────────────────────────────────────────────────
function showResult(blob) {
  if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
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

  showSection('result');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function showSection(name) {
  [uploadSec, progressSec, resultSec, errorSec].forEach(s => s.classList.add('hidden'));
  if (name === 'upload')   uploadSec.classList.remove('hidden');
  if (name === 'progress') progressSec.classList.remove('hidden');
  if (name === 'result')   resultSec.classList.remove('hidden');
  if (name === 'error')    errorSec.classList.remove('hidden');
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
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  resultVideo.src = '';
  clearFile();
  setProgress(0, '대기 중...');
  showSection('upload');
}

// ── Button wiring ─────────────────────────────────────────────────────────────
newBtn.addEventListener('click', reset);
retryBtn.addEventListener('click', reset);
