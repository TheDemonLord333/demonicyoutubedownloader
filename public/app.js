'use strict';

// ─── Particles ───────────────────────────────────────────────
(function spawnParticles() {
  const container = document.getElementById('particles');
  const COLORS = ['#5865F2', '#8B1FE0', '#1DB954', '#FF4444', '#ffffff'];
  function mkParticle() {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 4 + 1, color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const left = Math.random() * 100, dur = Math.random() * 14 + 8, delay = Math.random() * 15;
    p.style.cssText = `width:${size}px;height:${size}px;background:${color};box-shadow:0 0 ${size*2}px ${color};left:${left}vw;bottom:-10px;animation-duration:${dur}s;animation-delay:${delay}s;`;
    container.appendChild(p);
    setTimeout(() => p.remove(), (dur + delay) * 1000 + 1000);
  }
  for (let i = 0; i < 35; i++) mkParticle();
  setInterval(mkParticle, 600);
})();

// ─── DOM refs ────────────────────────────────────────────────
const urlInput     = document.getElementById('url-input');
const fetchBtn     = document.getElementById('fetch-btn');
const videoInfo    = document.getElementById('video-info');
const infoThumb    = document.getElementById('info-thumb');
const infoTitle    = document.getElementById('info-title');
const infoUploader = document.getElementById('info-uploader');
const infoDuration = document.getElementById('info-duration');

const modeVideoLabel = document.getElementById('mode-video-label');
const modeAudioLabel = document.getElementById('mode-audio-label');
const modeVideoInput = document.getElementById('mode-video');
const modeAudioInput = document.getElementById('mode-audio');
const videoOptions   = document.getElementById('video-options');
const audioOptions   = document.getElementById('audio-options');
const resolutionSel  = document.getElementById('resolution-select');
const audioFmtSel    = document.getElementById('audio-format-select');

const trimToggle   = document.getElementById('trim-toggle');
const trimControls = document.getElementById('trim-controls');
const startTime    = document.getElementById('start-time');
const endTime      = document.getElementById('end-time');

const dlFullBtn    = document.getElementById('dl-full-btn');
const dlFullLabel  = document.getElementById('dl-full-label');
const dlTrimBtn    = document.getElementById('dl-trim-btn');

const progressSec  = document.getElementById('progress-section');
const progressBar  = document.getElementById('progress-bar');
const progressGlow = document.getElementById('progress-glow');
const progressPct  = document.getElementById('progress-pct');
const progressLbl  = document.getElementById('progress-label');
const progressStat = document.getElementById('progress-status');

const readySec     = document.getElementById('ready-section');
const readyLink    = document.getElementById('ready-link');
const readyText    = document.getElementById('ready-text');
const resetBtn     = document.getElementById('reset-btn');

// ─── State ───────────────────────────────────────────────────
let currentJobId  = null;
let pollTimer     = null;
let videoInfoData = null;

// ─── Mode switching ──────────────────────────────────────────
function getMode() { return modeAudioInput.checked ? 'audio' : 'video'; }

function updateModeUI() {
  const isAudio = getMode() === 'audio';
  modeVideoLabel.classList.toggle('mode-active', !isAudio);
  modeAudioLabel.classList.toggle('mode-active', isAudio);
  videoOptions.classList.toggle('hidden', isAudio);
  audioOptions.classList.toggle('hidden', !isAudio);

  // Trim only for video
  trimToggle.closest('.section').style.opacity = isAudio ? '0.4' : '1';
  trimToggle.closest('.section').style.pointerEvents = isAudio ? 'none' : '';

  // Update button label
  dlFullLabel.textContent = isAudio ? 'Download Audio' : 'Download Full Video';
}

modeVideoLabel.addEventListener('click', () => { modeVideoInput.checked = true; updateModeUI(); });
modeAudioLabel.addEventListener('click', () => { modeAudioInput.checked = true; updateModeUI(); });

// ─── Utils ───────────────────────────────────────────────────
function secondsToHMS(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

function setProgress(pct, label, status) {
  const w = `${Math.min(pct, 100)}%`;
  progressBar.style.width  = w;
  progressGlow.style.width = w;
  progressPct.textContent  = `${Math.round(pct)}%`;
  if (label)  progressLbl.textContent  = label;
  if (status) progressStat.textContent = status;
}

function showSection(el) { el.classList.remove('hidden'); }
function hideSection(el) { el.classList.add('hidden'); }

// ─── Time input formatter ────────────────────────────────────
[startTime, endTime].forEach(input => {
  input.addEventListener('input', () => {
    let v = input.value.replace(/[^0-9]/g, '');
    if (v.length > 6) v = v.slice(0, 6);
    if (v.length >= 5) v = v.slice(0,2) + ':' + v.slice(2,4) + ':' + v.slice(4);
    else if (v.length >= 3) v = v.slice(0,2) + ':' + v.slice(2);
    input.value = v;
  });
});

// ─── Trim toggle ─────────────────────────────────────────────
trimToggle.addEventListener('change', () => {
  if (trimToggle.checked) {
    showSection(trimControls);
    showSection(dlTrimBtn);
    dlTrimBtn.disabled = !videoInfoData;
  } else {
    hideSection(trimControls);
    hideSection(dlTrimBtn);
  }
});

// ─── Fetch info ───────────────────────────────────────────────
fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchInfo(); });

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return shake(urlInput);
  fetchBtn.disabled  = true;
  fetchBtn.innerHTML = '<span class="btn-icon">☽</span><span>Summoning…</span>';
  hideSection(videoInfo);
  try {
    const res  = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.details || 'Unknown error');
    videoInfoData = data;
    infoTitle.textContent    = data.title    || '—';
    infoUploader.textContent = data.uploader || '—';
    infoDuration.textContent = data.duration ? secondsToHMS(data.duration) : '—';
    if (data.thumbnail) infoThumb.src = data.thumbnail;
    showSection(videoInfo);
    dlFullBtn.disabled = false;
    if (trimToggle.checked) dlTrimBtn.disabled = false;
  } catch (err) {
    alert(`Fehler beim Laden:\n${err.message}`);
  } finally {
    fetchBtn.disabled  = false;
    fetchBtn.innerHTML = '<span class="btn-icon">☽</span><span>Summon</span>';
  }
}

// ─── Download ─────────────────────────────────────────────────
dlFullBtn.addEventListener('click', () => startDownload(false));
dlTrimBtn.addEventListener('click', () => startDownload(true));

async function startDownload(withTrim) {
  const url = urlInput.value.trim();
  if (!url) return shake(urlInput);

  const mode = getMode();
  const payload = {
    url,
    mode,
    resolution: resolutionSel.value,
    audioFormat: audioFmtSel.value,
  };

  if (withTrim && mode === 'video') {
    const st = startTime.value.trim();
    const et = endTime.value.trim();
    if (st) payload.startTime = st;
    if (et) payload.endTime   = et;
  }

  dlFullBtn.disabled = true;
  dlTrimBtn.disabled = true;
  hideSection(readySec);
  showSection(progressSec);
  setProgress(0, 'Starting', 'Contacting the void…');

  try {
    const res  = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.details || 'Unknown error');
    currentJobId = data.jobId;
    pollStatus();
  } catch (err) {
    alert(`Download fehlgeschlagen:\n${err.message}`);
    resetUI();
  }
}

// ─── Poll ─────────────────────────────────────────────────────
function pollStatus() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(checkStatus, 1500);
}

async function checkStatus() {
  if (!currentJobId) return;
  try {
    const res  = await fetch(`/api/status/${currentJobId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    const pct = data.progress || 0;
    const labels = {
      queued:      ['Queued',      'Dein Auftrag wartet…'],
      downloading: ['Downloading', 'Greife nach dem Video…'],
      trimming:    ['Trimming',    'Schneide nach deinem Willen…'],
      done:        ['Complete',    'Das Ritual ist vollbracht.'],
      error:       ['Error',       data.error || 'Etwas ging schief.'],
    };
    const [lbl, stat] = labels[data.status] || ['Working', '…'];
    setProgress(pct, lbl, stat);

    if (data.status === 'done') {
      setProgress(100, 'Complete', 'Das Ritual ist vollbracht.');
      hideSection(progressSec);
      readyLink.href = `/api/file/${currentJobId}`;
      const isAudio = data.ext && data.ext !== 'mp4';
      readyText.textContent = isAudio ? 'Deine Audiodatei wurde beschworen.' : 'Dein Video wurde beschworen.';
      showSection(readySec);
      return;
    }

    if (data.status === 'error') {
      alert(`Fehler: ${data.error}`);
      resetUI();
      return;
    }
    pollStatus();
  } catch {
    pollStatus();
  }
}

// ─── Reset ───────────────────────────────────────────────────
resetBtn.addEventListener('click', resetUI);
function resetUI() {
  if (pollTimer) clearTimeout(pollTimer);
  currentJobId = null; videoInfoData = null;
  hideSection(progressSec); hideSection(readySec); hideSection(videoInfo);
  dlFullBtn.disabled = true; dlTrimBtn.disabled = true;
  urlInput.value = ''; startTime.value = ''; endTime.value = '';
  trimToggle.checked = false; hideSection(trimControls); hideSection(dlTrimBtn);
  setProgress(0, 'Starting', '');
}

// ─── Shake ───────────────────────────────────────────────────
function shake(el) {
  el.style.animation = 'none'; el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
}
const style = document.createElement('style');
style.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`;
document.head.appendChild(style);
