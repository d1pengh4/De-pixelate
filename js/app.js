'use strict';

const $ = id => document.getElementById(id);

const dropZone   = $('drop-zone');
const fileInput  = $('file-input');
const fileInfo   = $('file-info');
const fileNameEl = $('file-name');
const fileSizeEl = $('file-size');
const removeBtn  = $('remove-file');
const processBtn = $('process-btn');

const uploadSec   = $('upload-section');
const progressSec = $('progress-section');
const resultSec   = $('result-section');
const errorSec    = $('error-section');

const progressBar = $('progress-bar');
const stageEl     = $('progress-stage');
const pctEl       = $('progress-pct');

const resultVideo = $('result-video');
const downloadBtn = $('download-btn');
const imgDownBtn  = $('img-download-btn');
const newBtn      = $('new-btn');
const errorMsgEl  = $('error-msg');
const retryBtn    = $('error-retry-btn');

let selectedFile  = null;
let resultBlobUrl = null;
let resultImgUrl  = null;

function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── File handling ─────────────────────────────────────────────────────────────

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

function setFile(f) {
  selectedFile = f;
  fileNameEl.textContent = f.name;
  fileSizeEl.textContent = fmtBytes(f.size);
  fileInfo.classList.remove('hidden');
  dropZone.classList.add('hidden');
  processBtn.disabled = false;
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  processBtn.disabled = true;
}

// ── Processing ────────────────────────────────────────────────────────────────

processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile) return;

  showSection('progress');
  setProgress(0, '시작 중...');

  try {
    const result = await depixelate(
      selectedFile,
      {},   // full frame, auto cell-size detection
      (stage, pct) => setProgress(pct, stage)
    );
    showResult(result);
  } catch (err) {
    showError(err.message || String(err));
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

function showResult({ blob, reconData, cellH, cellW, frameCount }) {
  if (resultBlobUrl) { URL.revokeObjectURL(resultBlobUrl); resultBlobUrl = null; }
  if (resultImgUrl)  { URL.revokeObjectURL(resultImgUrl);  resultImgUrl  = null; }

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

  // Static PNG fallback
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
