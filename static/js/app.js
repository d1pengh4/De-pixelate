'use strict';

const $ = id => document.getElementById(id);

// Elements
const dropZone = $('drop-zone');
const fileInput = $('file-input');
const fileInfo = $('file-info');
const fileName = $('file-name');
const fileSize = $('file-size');
const removeFile = $('remove-file');
const processBtn = $('process-btn');

const uploadSection = $('upload-section');
const progressSection = $('progress-section');
const resultSection = $('result-section');
const errorSection = $('error-section');

const progressBar = $('progress-bar');
const progressStage = $('progress-stage');
const progressPct = $('progress-pct');

const resultImg = $('result-img');
const downloadBtn = $('download-btn');
const newBtn = $('new-btn');
const errorMsg = $('error-msg');
const errorRetry = $('error-retry-btn');

let selectedFile = null;
let currentJobId = null;
let evtSource = null;

// ── File selection ──
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

removeFile.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  processBtn.disabled = true;
});

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.classList.remove('hidden');
  dropZone.classList.add('hidden');
  processBtn.disabled = false;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Process button ──
processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFile) return;

  const formData = new FormData();
  formData.append('video', selectedFile);

  // Optional advanced params
  const wx = $('win-x').value;
  const wy = $('win-y').value;
  const ww = $('win-w').value;
  const wh = $('win-h').value;
  const cw = $('cell-w').value;
  const ch = $('cell-h').value;

  if (wx && wy && ww && wh) {
    formData.append('window_pos', JSON.stringify([parseInt(wy), parseInt(wx)]));
    formData.append('window_size', JSON.stringify([parseInt(wh), parseInt(ww)]));
  }
  if (cw && ch) {
    formData.append('cell_size', JSON.stringify([parseFloat(ch), parseFloat(cw)]));
  }

  showSection('progress');
  setProgress(0, '업로드 중...');

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || '업로드 실패');
      return;
    }

    currentJobId = data.job_id;
    listenProgress(currentJobId);
  } catch (err) {
    showError('서버에 연결할 수 없습니다: ' + err.message);
  }
}

function listenProgress(jobId) {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`/progress/${jobId}`);

  evtSource.onmessage = e => {
    const job = JSON.parse(e.data);

    if (job.error) {
      evtSource.close();
      showError(job.error);
      return;
    }

    setProgress(job.progress, job.stage);

    if (job.status === 'done') {
      evtSource.close();
      showResult(jobId);
    } else if (job.status === 'error') {
      evtSource.close();
      showError(job.error || '알 수 없는 오류');
    }
  };

  evtSource.onerror = () => {
    evtSource.close();
    // poll as fallback
    pollStatus(jobId);
  };
}

async function pollStatus(jobId) {
  for (let i = 0; i < 600; i++) {
    await sleep(2000);
    try {
      const res = await fetch(`/status/${jobId}`);
      const job = await res.json();
      setProgress(job.progress, job.stage);
      if (job.status === 'done') { showResult(jobId); return; }
      if (job.status === 'error') { showError(job.error || '오류'); return; }
    } catch (_) {}
  }
  showError('처리 시간 초과');
}

function setProgress(pct, stage) {
  progressBar.style.width = pct + '%';
  progressStage.textContent = stage || '';
  progressPct.textContent = pct + '%';
}

function showResult(jobId) {
  resultImg.src = `/preview/${jobId}?t=${Date.now()}`;
  downloadBtn.onclick = () => { window.location.href = `/download/${jobId}`; };
  showSection('result');
}

function showError(msg) {
  errorMsg.textContent = msg;
  showSection('error');
}

// ── Navigation ──
function showSection(name) {
  uploadSection.classList.add('hidden');
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  errorSection.classList.add('hidden');

  if (name === 'upload') uploadSection.classList.remove('hidden');
  else if (name === 'progress') progressSection.classList.remove('hidden');
  else if (name === 'result') resultSection.classList.remove('hidden');
  else if (name === 'error') errorSection.classList.remove('hidden');
}

newBtn.addEventListener('click', reset);
errorRetry.addEventListener('click', reset);

function reset() {
  if (evtSource) evtSource.close();
  if (currentJobId) {
    fetch(`/cleanup/${currentJobId}`, { method: 'DELETE' }).catch(() => {});
    currentJobId = null;
  }
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  processBtn.disabled = true;
  setProgress(0, '대기 중...');
  showSection('upload');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
