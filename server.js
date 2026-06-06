'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

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

const jobs = new Map();

// ─── yt-dlp binary setup ──────────────────────────────────────
async function ensureYtDlp() {
  if (fs.existsSync(BIN_PATH)) return;
  console.log('Downloading yt-dlp binary...');
  const https = require('https');
  const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(BIN_PATH);
    const follow = (url) => {
      https.get(url, { headers: { 'User-Agent': 'yt-dlp-node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} fetching yt-dlp`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { file.close(); reject(e); });
    };
    follow(RELEASE_URL);
  });
  fs.chmodSync(BIN_PATH, '755');
  console.log('yt-dlp ready at', BIN_PATH);
}

// ─── Helpers ──────────────────────────────────────────────────
function timeToSeconds(t) {
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function secondsToHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// Parse yt-dlp progress line: "[download]  45.2% of  123.45MiB at  2.50MiB/s ETA 00:30"
function parseProgress(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Cleanup old jobs ─────────────────────────────────────────
setInterval(() => {
  const ttl = 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - (job.createdAt || 0) > ttl) {
      const dir = path.join(DOWNLOADS_DIR, id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      jobs.delete(id);
    }
  }
}, 15 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true, bin: fs.existsSync(BIN_PATH) }));

// GET video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  try {
    await ensureYtDlp();
  } catch (e) {
    return res.status(500).json({ error: 'yt-dlp not available', details: e.message });
  }
  execFile(BIN_PATH, ['--dump-json', '--no-playlist', url], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'Could not fetch info', details: stderr.slice(0, 300) });
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader || info.channel || '',
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// Start download job
app.post('/api/download', async (req, res) => {
  const { url, startTime, endTime } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });

  try {
    await ensureYtDlp();
  } catch (e) {
    return res.status(500).json({ error: 'yt-dlp not available', details: e.message });
  }

  const jobId = uuidv4();
  const outputDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    status: 'downloading',
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

  // Async download pipeline
  (async () => {
    try {
      const rawPath = path.join(outputDir, 'raw.mp4');

      const args = [
        url,
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', rawPath,
        '--no-playlist',
        '--newline',
      ];

      await new Promise((resolve, reject) => {
        const proc = spawn(BIN_PATH, args);
        let stderr = '';

        proc.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            const pct = parseProgress(line);
            if (pct !== null) job.progress = Math.round(pct * 0.8);
            // Extract title
            if (!job.title) {
              const tm = line.match(/\[info\] (.+): Downloading/);
              if (tm) job.title = tm[1];
            }
          }
        });

        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.slice(-400) || `yt-dlp exit code ${code}`));
        });

        proc.on('error', (e) => reject(new Error(`Failed to spawn yt-dlp: ${e.message}`)));
      });

      job.progress = 80;

      const startSec = timeToSeconds(startTime);
      const endSec = timeToSeconds(endTime);

      if (startSec !== null || endSec !== null) {
        job.status = 'trimming';
        const trimmedPath = path.join(outputDir, 'trimmed.mp4');

        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(rawPath);
          if (startSec !== null) cmd = cmd.setStartTime(secondsToHMS(startSec));
          if (endSec !== null) {
            const duration = startSec !== null ? endSec - startSec : endSec;
            cmd = cmd.setDuration(secondsToHMS(Math.max(duration, 1)));
          }
          cmd
            .output(trimmedPath)
            .outputOptions(['-c:v copy', '-c:a copy', '-avoid_negative_ts make_zero'])
            .on('progress', (p) => {
              if (p.percent) job.progress = 80 + Math.round(p.percent * 0.19);
            })
            .on('end', resolve)
            .on('error', (e) => reject(new Error(`ffmpeg: ${e.message}`)))
            .run();
        });

        try { fs.unlinkSync(rawPath); } catch {}
        job.filepath = trimmedPath;
      } else {
        job.filepath = rawPath;
      }

      job.status = 'done';
      job.progress = 100;
    } catch (err) {
      job.status = 'error';
      job.error = String(err.message || err);
      console.error('[job error]', err.message);
    }
  })();
});

// Poll job status
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    title: job.title,
    error: job.error,
    hasTrim: job.hasTrim,
  });
});

// Serve finished file
app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'File not ready' });
  if (!job.filepath || !fs.existsSync(job.filepath)) {
    return res.status(404).json({ error: 'File missing on server' });
  }
  const safeName = (job.title || 'video')
    .replace(/[^\w\s\-]/g, '')
    .trim()
    .slice(0, 60) || 'video';
  const suffix = job.hasTrim ? '_trimmed' : '';
  res.download(job.filepath, `${safeName}${suffix}.mp4`);
});

app.listen(PORT, () => {
  console.log(`Demonic YouTube Downloader running on http://0.0.0.0:${PORT}`);
  ensureYtDlp().catch((e) => console.error('yt-dlp init failed:', e.message));
});
