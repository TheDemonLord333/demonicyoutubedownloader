'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

const FFMPEG_PATH = ffmpegInstaller.path;
ffmpeg.setFfmpegPath(FFMPEG_PATH);

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

// ─── yt-dlp binary ───────────────────────────────────────────
async function ensureYtDlp() {
  if (fs.existsSync(BIN_PATH)) return;
  console.log('Downloading yt-dlp...');
  const https = require('https');
  const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(BIN_PATH);
    const follow = (url) => {
      https.get(url, { headers: { 'User-Agent': 'yt-dlp-node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); return follow(res.headers.location);
        }
        if (res.statusCode !== 200) { file.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { file.close(); reject(e); });
    };
    follow(URL);
  });
  fs.chmodSync(BIN_PATH, '755');
  console.log('yt-dlp ready.');
}

// ─── Format helpers ───────────────────────────────────────────
function buildVideoFormat(resolution) {
  // Use ONLY combined single-file formats (video+audio already merged).
  // "best[vcodec!=none][acodec!=none]" = formats that have BOTH streams in one file.
  // This avoids any ffmpeg merge step entirely.
  const h = { '360': 360, '480': 480, '720': 720, '1080': 1080 }[resolution];
  if (!h) {
    return 'best[vcodec!=none][acodec!=none][ext=mp4]/best[vcodec!=none][acodec!=none]/best[ext=mp4]/best';
  }
  return (
    `best[vcodec!=none][acodec!=none][height<=${h}][ext=mp4]` +
    `/best[vcodec!=none][acodec!=none][height<=${h}]` +
    `/best[height<=${h}][ext=mp4]` +
    `/best[height<=${h}]` +
    `/best[ext=mp4]/best`
  );
}

function timeToSeconds(t) {
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function secondsToHMS(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function parseProgress(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Cleanup ──────────────────────────────────────────────────
setInterval(() => {
  const ttl = 60 * 60 * 1000, now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - (job.createdAt || 0) > ttl) {
      try { fs.rmSync(path.join(DOWNLOADS_DIR, id), { recursive: true, force: true }); } catch {}
      jobs.delete(id);
    }
  }
}, 15 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true, bin: fs.existsSync(BIN_PATH) }));

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  try { await ensureYtDlp(); } catch (e) {
    return res.status(500).json({ error: 'yt-dlp not available', details: e.message });
  }
  const nodeDir = path.dirname(process.execPath);
  const ffmpegDir = path.dirname(FFMPEG_PATH);
  const infoEnv = {
    ...process.env,
    PATH: `${nodeDir}:${ffmpegDir}:${process.env.PATH || '/usr/bin:/bin'}`,
  };
  execFile(BIN_PATH, ['--dump-json', '--no-playlist', '--extractor-args', 'youtube:player_client=ios,android,web', url], { maxBuffer: 10 * 1024 * 1024, env: infoEnv }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'Could not fetch info', details: stderr.slice(0, 400) });
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader || info.channel || '',
      });
    } catch { res.status(500).json({ error: 'Failed to parse video info' }); }
  });
});

app.post('/api/download', async (req, res) => {
  const { url, startTime, endTime, mode = 'video', resolution = 'best', audioFormat = 'mp3' } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  try { await ensureYtDlp(); } catch (e) {
    return res.status(500).json({ error: 'yt-dlp not available', details: e.message });
  }

  const isAudio = mode === 'audio';
  const ext = isAudio ? audioFormat : 'mp4';
  const jobId = uuidv4();
  const outputDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    status: 'downloading', progress: 0, filepath: null, error: null,
    title: null, createdAt: Date.now(),
    hasTrim: !!(startTime || endTime), ext,
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      const rawPath = path.join(outputDir, `raw.${ext}`);

      // Build yt-dlp args
      const ffmpegDir = path.dirname(FFMPEG_PATH);
      const args = [
        url,
        '--ffmpeg-location', ffmpegDir,
        '--extractor-args', 'youtube:player_client=ios,android,web',
        '--no-playlist',
        '--newline',
        '-o', rawPath,
      ];

      if (isAudio) {
        args.push('-f', 'bestaudio/best');
        args.push('-x', '--audio-format', audioFormat, '--audio-quality', '0');
      } else {
        args.push('-f', buildVideoFormat(resolution));
        // No --merge-output-format: we download combined streams only, no merge needed.
      }

      // Make ffmpeg + node findable via PATH so yt-dlp can use them
      const nodeDir = path.dirname(process.execPath);
      const spawnEnv = {
        ...process.env,
        PATH: `${nodeDir}:${ffmpegDir}:${process.env.PATH || '/usr/bin:/bin'}`,
      };

      await new Promise((resolve, reject) => {
        const proc = spawn(BIN_PATH, args, { env: spawnEnv });
        let stderr = '';

        proc.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            const pct = parseProgress(line);
            if (pct !== null) job.progress = Math.round(pct * 0.8);
            if (!job.title) {
              const tm = line.match(/\[info\] (.+): Downloading/);
              if (tm) job.title = tm[1];
            }
          }
        });
        proc.stderr.on('data', (c) => { stderr += c.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.slice(-600) || `yt-dlp exit code ${code}`));
        });
        proc.on('error', (e) => reject(new Error(`spawn failed: ${e.message}`)));
      });

      job.progress = 80;

      // Trim if requested (video only)
      const startSec = timeToSeconds(startTime);
      const endSec = timeToSeconds(endTime);

      if (!isAudio && (startSec !== null || endSec !== null)) {
        job.status = 'trimming';
        const trimmedPath = path.join(outputDir, `trimmed.mp4`);
        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(rawPath);
          if (startSec !== null) cmd = cmd.setStartTime(secondsToHMS(startSec));
          if (endSec !== null) {
            const dur = startSec !== null ? endSec - startSec : endSec;
            cmd = cmd.setDuration(secondsToHMS(Math.max(dur, 1)));
          }
          cmd.output(trimmedPath)
            .outputOptions(['-c:v copy', '-c:a copy', '-avoid_negative_ts make_zero'])
            .on('progress', (p) => { if (p.percent) job.progress = 80 + Math.round(p.percent * 0.19); })
            .on('end', resolve)
            .on('error', (e) => reject(new Error(`ffmpeg trim: ${e.message}`)))
            .run();
        });
        try { fs.unlinkSync(rawPath); } catch {}
        job.filepath = trimmedPath;
        job.ext = 'mp4';
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

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, title: job.title, error: job.error, hasTrim: job.hasTrim, ext: job.ext });
});

app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'File not ready' });
  if (!job.filepath || !fs.existsSync(job.filepath)) return res.status(404).json({ error: 'File missing' });
  const safeName = (job.title || 'video').replace(/[^\w\s\-]/g, '').trim().slice(0, 60) || 'video';
  const suffix = job.hasTrim ? '_trimmed' : '';
  res.download(job.filepath, `${safeName}${suffix}.${job.ext || 'mp4'}`);
});

app.listen(PORT, () => {
  console.log(`Demonic YouTube Downloader running on http://0.0.0.0:${PORT}`);
  ensureYtDlp().catch((e) => console.error('yt-dlp init failed:', e.message));
});
