'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
const YTDlpWrap = require('yt-dlp-wrap').default;

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = 3003;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const BIN_PATH = path.join(__dirname, 'bin', 'yt-dlp');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'bin'))) fs.mkdirSync(path.join(__dirname, 'bin'), { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Job store: { status, progress, filename, filepath, error, title }
const jobs = new Map();

let ytDlp = null;

async function downloadYtDlpBinary() {
  const https = require('https');
  const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(BIN_PATH);
    const follow = (url) => {
      https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(RELEASE_URL);
  });
  fs.chmodSync(BIN_PATH, '755');
}

async function getYtDlp() {
  if (ytDlp) return ytDlp;
  if (!fs.existsSync(BIN_PATH)) {
    console.log('Downloading yt-dlp binary...');
    try {
      await YTDlpWrap.downloadFromGithub(BIN_PATH);
    } catch {
      await downloadYtDlpBinary();
    }
    if (fs.existsSync(BIN_PATH)) fs.chmodSync(BIN_PATH, '755');
    console.log('yt-dlp ready.');
  }
  ytDlp = new YTDlpWrap(BIN_PATH);
  return ytDlp;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  if (/^\d+$/.test(timeStr)) return parseInt(timeStr);
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function secondsToTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cleanOldFiles() {
  const oneHour = 60 * 60 * 1000;
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt && now - job.createdAt > oneHour) {
      if (job.filepath && fs.existsSync(job.filepath)) {
        try { fs.unlinkSync(job.filepath); } catch {}
      }
      const dir = path.join(DOWNLOADS_DIR, jobId);
      if (fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(jobId);
    }
  }
}

setInterval(cleanOldFiles, 15 * 60 * 1000);

// GET /api/health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// POST /api/info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });

  try {
    const yt = await getYtDlp();
    const metadata = await yt.getVideoInfo(url);
    res.json({
      title: metadata.title,
      duration: metadata.duration,
      thumbnail: metadata.thumbnail,
      uploader: metadata.uploader || metadata.channel,
      description: (metadata.description || '').slice(0, 200),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch video info', details: String(err.message || err) });
  }
});

// POST /api/download
app.post('/api/download', async (req, res) => {
  const { url, startTime, endTime } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });

  const jobId = uuidv4();
  const outputDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    status: 'queued',
    progress: 0,
    filename: null,
    filepath: null,
    error: null,
    title: null,
    createdAt: Date.now(),
    hasTrim: !!(startTime || endTime),
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  // Run download asynchronously
  (async () => {
    try {
      const yt = await getYtDlp();
      job.status = 'downloading';

      const rawPath = path.join(outputDir, 'raw.mp4');

      await new Promise((resolve, reject) => {
        const args = [
          url,
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
          '--merge-output-format', 'mp4',
          '-o', rawPath,
          '--no-playlist',
        ];

        const proc = yt.execStream(args);

        proc.on('progress', (p) => {
          if (p.percent) job.progress = Math.round(p.percent * 0.8);
        });

        let titleFound = false;
        proc.on('ytDlpEvent', (eventType, eventData) => {
          if (!titleFound && eventType === 'info') {
            try {
              const info = JSON.parse(eventData);
              if (info.title) { job.title = info.title; titleFound = true; }
            } catch {}
          }
        });

        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      job.progress = 80;

      const startSec = timeToSeconds(startTime);
      const endSec = timeToSeconds(endTime);
      const needsTrim = startSec !== null || endSec !== null;

      if (needsTrim) {
        job.status = 'trimming';
        const trimmedPath = path.join(outputDir, 'trimmed.mp4');

        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(rawPath);
          if (startSec !== null) cmd = cmd.setStartTime(secondsToTime(startSec));
          if (endSec !== null && startSec !== null) {
            cmd = cmd.setDuration(secondsToTime(endSec - startSec));
          } else if (endSec !== null) {
            cmd = cmd.setDuration(secondsToTime(endSec));
          }
          cmd
            .output(trimmedPath)
            .outputOptions(['-c:v copy', '-c:a copy', '-avoid_negative_ts make_zero'])
            .on('progress', (p) => {
              if (p.percent) job.progress = 80 + Math.round(p.percent * 0.19);
            })
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        try { fs.unlinkSync(rawPath); } catch {}
        job.filepath = trimmedPath;
        job.filename = 'demonic_trim.mp4';
      } else {
        job.filepath = rawPath;
        job.filename = 'demonic_download.mp4';
      }

      job.status = 'done';
      job.progress = 100;
    } catch (err) {
      job.status = 'error';
      job.error = String(err.message || err);
      console.error('Job error:', err);
    }
  })();
});

// GET /api/status/:jobId
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    filename: job.filename,
    title: job.title,
    error: job.error,
    hasTrim: job.hasTrim,
  });
});

// GET /api/file/:jobId
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'File not ready' });
  if (!job.filepath || !fs.existsSync(job.filepath)) {
    return res.status(404).json({ error: 'File missing' });
  }
  const safeName = (job.title || 'video').replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().slice(0, 60) || 'video';
  const suffix = job.hasTrim ? '_trimmed' : '';
  res.download(job.filepath, `${safeName}${suffix}.mp4`);
});

app.listen(PORT, () => {
  console.log(`Demonic YouTube Downloader running on port ${PORT}`);
  getYtDlp().catch(console.error);
});
