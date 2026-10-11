const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = __dirname;
const SEGMENT_SECONDS = 4;
const MAX_SEGMENTS_AHEAD = 2;
const clients = new Map();
const segmentJobs = new Map();
const captionJobs = new Map();
let hostId = null;
let mediaPath = null;
let mediaVersion = 0;
let mediaDuration = 0;
let mediaReady = false;
let mediaProcessing = false;
let captionTracks = [];
let hlsDirectory = null;
let selectedEncoder = "Detecting hardware";
let playback = { paused: true, time: 0, rate: 1, updatedAt: Date.now() };

let FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
try { FFMPEG_PATH = require("ffmpeg-static") || FFMPEG_PATH; } catch {}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
  ".ass": "text/x-ssa; charset=utf-8", ".ssa": "text/x-ssa; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8", ".ttml": "application/ttml+xml; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl", ".vtt": "text/vtt; charset=utf-8",
  ".ts": "video/mp2t"
};

const CPU_ENCODER = {
  name: "libx264", label: "CPU fallback (libx264)", input: [],
  args: ["-preset", "veryfast", "-crf", "18"]
};

function testEncoder(name) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=black:s=64x64:d=0.05", "-frames:v", "1",
      "-c:v", name, "-f", "null", "-"
    ], { windowsHide: true });
    let settled = false;
    const finish = (works) => { if (!settled) { settled = true; clearTimeout(timer); resolve(works); } };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 5000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function detectVideoEncoder() {
  if (process.env.WATCHPARTY_ENCODER) {
    return { name: process.env.WATCHPARTY_ENCODER, label: process.env.WATCHPARTY_ENCODER, input: [], args: [] };
  }
  const candidates = [
    {
      name: "h264_nvenc", label: "NVIDIA NVENC (h264_nvenc + CUDA decode)",
      input: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
      args: ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0", "-spatial_aq", "1", "-temporal_aq", "1"]
    },
    {
      name: "h264_qsv", label: "Intel Quick Sync (h264_qsv + QSV decode)",
      input: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"],
      args: ["-preset", "slow", "-global_quality", "19"]
    },
    {
      name: "h264_amf", label: "AMD AMF (h264_amf + D3D11VA decode)",
      input: ["-hwaccel", "d3d11va"],
      args: ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20", "-qp_b", "22"]
    },
    {
      name: "h264_videotoolbox", label: "Apple VideoToolbox",
      input: ["-hwaccel", "videotoolbox"], args: ["-q:v", "80"]
    }
  ];
  for (const candidate of candidates) if (await testEncoder(candidate.name)) return candidate;
  return CPU_ENCODER;
}

const encoderPromise = detectVideoEncoder();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, exceptId = null) {
  for (const [id, client] of clients) if (id !== exceptId) send(client.ws, payload);
}

function currentTime() {
  const time = playback.paused
    ? playback.time
    : playback.time + ((Date.now() - playback.updatedAt) / 1000) * playback.rate;
  return mediaDuration ? Math.min(mediaDuration, Math.max(0, time)) : Math.max(0, time);
}

function sessionState(syncMode = "tick") {
  return {
    type: "session-state", hasVideo: Boolean(mediaPath && mediaReady),
    processing: mediaProcessing,
    mediaUrl: mediaPath && mediaReady ? `/hls/master.m3u8?v=${mediaVersion}` : null,
    captions: captionTracks,
    fileName: mediaPath ? path.basename(mediaPath) : null,
    duration: mediaDuration, encoder: selectedEncoder,
    paused: playback.paused, time: currentTime(), playbackRate: playback.rate,
    syncMode
  };
}

function isWatchPartyTempDirectory(directory) {
  if (!directory) return false;
  const resolved = path.resolve(directory);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("watchparty-hls-");
}

function removeTempDirectory(directory) {
  if (isWatchPartyTempDirectory(directory)) fs.rm(directory, { recursive: true, force: true }, () => {});
}

function cancelSegmentJobs(includeWaiting = true) {
  for (const [index, job] of segmentJobs) {
    if (!includeWaiting && !job.started) continue;
    job.cancelled = true;
    if (job.process && job.process.exitCode === null) job.process.kill();
    segmentJobs.delete(index);
  }
}

function stopMediaWork() {
  cancelSegmentJobs();
  for (const job of captionJobs.values()) if (job.process && job.process.exitCode === null) job.process.kill();
  captionJobs.clear();
}

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function probeMedia(sourcePath) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, ["-hide_banner", "-i", sourcePath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const output = String(stderr || "");
      const duration = parseDuration(output);
      if (!duration) { reject(new Error(error?.message || "Could not determine the video duration.")); return; }
      const subtitles = [];
      for (const line of output.split(/\r?\n/)) {
        const match = /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Subtitle:/.exec(line);
        if (!match || subtitles.length >= 8) continue;
        const codec = (/Subtitle:\s*([a-zA-Z0-9_]+)/.exec(line)?.[1] || "").toLowerCase();
        subtitles.push({ input: sourcePath, map: `0:${match[1]}`, codec, lang: match[2] || "und", label: `Embedded ${subtitles.length + 1}${match[2] ? ` (${match[2]})` : ""}` });
      }
      resolve({ duration, subtitles });
    });
  });
}

function findSidecarSubtitles(sourcePath) {
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase();
  const supported = new Set([".srt", ".vtt", ".ass", ".ssa", ".ttml"]);
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.toLowerCase().startsWith(`${stem}.`) && supported.has(path.extname(name).toLowerCase()))
      .slice(0, 8)
      .map((name) => ({ input: path.join(directory, name), map: null, codec: path.extname(name).slice(1).toLowerCase(), label: path.basename(name, path.extname(name)), lang: "und" }));
  } catch { return []; }
}

function captionFormat(codec) {
  const normalized = String(codec || "").toLowerCase();
  if (normalized === "subrip" || normalized === "srt") return "srt";
  if (normalized === "webvtt" || normalized === "vtt") return "vtt";
  if (normalized === "ass") return "ass";
  if (normalized === "ssa") return "ssa";
  if (normalized === "ttml" || normalized === "dfxp") return "ttml";
  return null;
}

function writePlaylists() {
  const count = Math.ceil(mediaDuration / SEGMENT_SECONDS);
  const video = [
    "#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-INDEPENDENT-SEGMENTS"
  ];
  for (let index = 0; index < count; index += 1) {
    const duration = Math.min(SEGMENT_SECONDS, mediaDuration - index * SEGMENT_SECONDS);
    if (index) video.push("#EXT-X-DISCONTINUITY");
    video.push(`#EXTINF:${duration.toFixed(3)},`, `segment_${String(index).padStart(6, "0")}.ts?v=${mediaVersion}`);
  }
  video.push("#EXT-X-ENDLIST", "");
  fs.writeFileSync(path.join(hlsDirectory, "video.m3u8"), video.join("\n"));

  const master = ["#EXTM3U", "#EXT-X-VERSION:3"];
  master.push("#EXT-X-STREAM-INF:BANDWIDTH=25200000,CODECS=\"avc1.640028,mp4a.40.2\"");
  master.push(`video.m3u8?v=${mediaVersion}`, "");
  fs.writeFileSync(path.join(hlsDirectory, "master.m3u8"), master.join("\n"));
}

function extractCaption(subtitle, version) {
  const outputPath = path.join(hlsDirectory, subtitle.fileName);
  const job = { process: null, promise: null };
  job.promise = new Promise((resolve, reject) => {
    if (!subtitle.map) {
      fs.copyFile(subtitle.input, outputPath, (error) => error ? reject(error) : resolve(outputPath));
      return;
    }
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", subtitle.input];
    if (subtitle.map) args.push("-map", subtitle.map);
    args.push("-c:s", "copy", outputPath);
    job.process = spawn(FFMPEG_PATH, args, { windowsHide: true });
    job.process.once("error", reject);
    job.process.once("exit", (code) => {
      if (version !== mediaVersion) { reject(new Error("Caption extraction was replaced.")); return; }
      if (code === 0) resolve(outputPath); else reject(new Error("Caption extraction failed."));
    });
  }).catch((error) => { job.error = error; return null; });
  captionJobs.set(subtitle.fileName, job);
  return job.promise.then((result) => result ? {
    url: `/hls/${subtitle.fileName}?v=${version}`,
    label: subtitle.label,
    lang: subtitle.lang || "und",
    format: subtitle.format,
    originalFormat: subtitle.format
  } : null);
}

async function prepareMedia(sourcePath) {
  stopMediaWork();
  const oldDirectory = hlsDirectory;
  hlsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-hls-"));
  if (oldDirectory) setTimeout(() => removeTempDirectory(oldDirectory), 15000);
  const version = mediaVersion;
  try {
    const [encoder, probe] = await Promise.all([encoderPromise, probeMedia(sourcePath)]);
    if (version !== mediaVersion || !mediaPath || !hlsDirectory) return;
    selectedEncoder = encoder.label;
    mediaDuration = probe.duration;
    const subtitles = [...probe.subtitles, ...findSidecarSubtitles(sourcePath)]
      .map((subtitle) => ({ ...subtitle, format: captionFormat(subtitle.codec) }))
      .filter((subtitle) => subtitle.format)
      .slice(0, 16);
    subtitles.forEach((subtitle, index) => { subtitle.fileName = `captions_${index}.${subtitle.format}`; });
    writePlaylists();
    const extracted = (await Promise.all(subtitles.map((subtitle) => extractCaption(subtitle, version)))).filter(Boolean);
    if (version !== mediaVersion || !mediaPath || !hlsDirectory) return;
    const languageCounts = new Map();
    captionTracks = extracted.map((track) => {
      const count = (languageCounts.get(track.lang) || 0) + 1;
      languageCounts.set(track.lang, count);
      return { ...track, lang: count === 1 ? track.lang : `${track.lang}-${count}` };
    });
    mediaReady = true;
    mediaProcessing = false;
    broadcast(sessionState("source"));
  } catch (error) {
    if (version !== mediaVersion) return;
    mediaProcessing = false;
    broadcast({ type: "media-error", message: error.message || "The selected video could not be prepared." });
  }
}

async function waitForSegmentPermission(index, version) {
  while (version === mediaVersion) {
    const target = Math.floor(currentTime() / SEGMENT_SECONDS);
    if ((!playback.paused && index <= target + MAX_SEGMENTS_AHEAD) || (playback.paused && index === target)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The requested stream was replaced.");
}

function encoderAttempts(encoder) {
  if (encoder.name === "libx264") return [CPU_ENCODER];
  return [
    encoder,
    { ...encoder, label: `${encoder.name} hardware encode`, input: [] },
    CPU_ENCODER
  ];
}

function runSegmentAttempt(job, attempt, start, duration, tempPath, version) {
  return new Promise((resolve, reject) => {
    const videoFilter = attempt.name === "libx264"
      ? ["-vf", "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2':flags=lanczos"]
      : [];
    const args = [
      "-hide_banner", "-loglevel", "warning", "-y", ...attempt.input,
      "-ss", start.toFixed(3), "-i", mediaPath, "-t", duration.toFixed(3),
      "-map", "0:v:0", "-map", "0:a:0?", ...videoFilter,
      "-c:v", attempt.name, ...attempt.args,
      "-maxrate", "25000k", "-bufsize", "50000k", "-pix_fmt", "yuv420p",
      "-g", "120", "-keyint_min", "1", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", "192k", "-ac", "2",
      "-output_ts_offset", start.toFixed(3), "-muxdelay", "0", "-muxpreload", "0",
      "-f", "mpegts", tempPath
    ];
    let errorOutput = "";
    job.process = spawn(FFMPEG_PATH, args, { windowsHide: true });
    job.process.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
    job.process.once("error", reject);
    job.process.once("exit", (code) => {
      if (job.cancelled || version !== mediaVersion) { reject(new Error("Segment encoding was paused or replaced.")); return; }
      if (code === 0) resolve(attempt.label);
      else reject(new Error(errorOutput.trim().split("\n").slice(-2).join(" ") || `${attempt.name} failed.`));
    });
  });
}

async function ensureSegment(index) {
  const version = mediaVersion;
  const outputPath = path.join(hlsDirectory, `segment_${String(index).padStart(6, "0")}.ts`);
  if (fs.existsSync(outputPath)) return outputPath;
  if (segmentJobs.has(index)) return segmentJobs.get(index).promise;

  const job = { process: null, cancelled: false, started: false, promise: null };
  job.promise = (async () => {
    await waitForSegmentPermission(index, version);
    if (job.cancelled || version !== mediaVersion) throw new Error("Segment encoding was cancelled.");
    job.started = true;
    const start = index * SEGMENT_SECONDS;
    const duration = Math.min(SEGMENT_SECONDS, mediaDuration - start);
    const tempPath = `${outputPath}.tmp`;
    const encoder = await encoderPromise;
    let lastError;
    for (const attempt of encoderAttempts(encoder)) {
      try {
        const activeLabel = await runSegmentAttempt(job, attempt, start, duration, tempPath, version);
        if (job.cancelled || version !== mediaVersion) throw new Error("Segment encoding was cancelled.");
        fs.renameSync(tempPath, outputPath);
        if (selectedEncoder !== activeLabel) {
          selectedEncoder = activeLabel;
          broadcast({ type: "transcode-info", encoder: activeLabel });
        }
        return outputPath;
      } catch (error) {
        lastError = error;
        fs.rmSync(tempPath, { force: true });
        if (job.cancelled || version !== mediaVersion) throw error;
      }
    }
    throw lastError || new Error("Segment encoding failed.");
  })().finally(() => { if (segmentJobs.get(index) === job) segmentJobs.delete(index); });
  segmentJobs.set(index, job);
  return job.promise;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": extension === ".m3u8" ? "no-store" : "private, max-age=3600, immutable"
    });
    if (req.method === "HEAD") res.end(); else fs.createReadStream(filePath).pipe(res);
  });
}

async function serveHls(req, res, url) {
  if (!hlsDirectory || !mediaReady || Number(url.searchParams.get("v")) !== mediaVersion) {
    res.writeHead(404); res.end("Stream is not ready"); return;
  }
  const relative = url.pathname.slice("/hls/".length);
  const filePath = path.resolve(hlsDirectory, relative);
  if (!filePath.startsWith(`${path.resolve(hlsDirectory)}${path.sep}`)) { res.writeHead(403); res.end("Forbidden"); return; }
  const segmentMatch = /^segment_(\d{6})\.ts$/.exec(relative);
  try {
    if (segmentMatch) {
      const index = Number(segmentMatch[1]);
      if (index >= Math.ceil(mediaDuration / SEGMENT_SECONDS)) throw new Error("Invalid segment.");
      await ensureSegment(index);
    } else if (/^captions_\d+\.(?:srt|vtt|ass|ssa|ttml)$/.test(relative)) {
      const captionJob = captionJobs.get(relative);
      if (captionJob) await captionJob.promise;
    }
    if (res.destroyed) return;
    serveFile(req, res, filePath);
  } catch (error) {
    if (!res.headersSent) { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }); res.end(error.message); }
  }
}

function updatePresence() { broadcast({ type: "presence", count: clients.size }); }

function sanitizeDisplayName(value, fallback = "Guest") {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
  return name || fallback;
}

function displayNameKey(value) {
  return sanitizeDisplayName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function isDisplayNameTaken(name, exceptClientId = null) {
  const key = displayNameKey(name);
  for (const [clientId, client] of clients) {
    if (clientId !== exceptClientId && displayNameKey(client.name) === key) return true;
  }
  return false;
}

function availableGuestName(clientId) {
  const token = String(clientId || "user").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "USER";
  const base = `Guest-${token}`;
  if (!isDisplayNameTaken(base)) return base;
  let suffix = 2;
  while (isDisplayNameTaken(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function handleMessage(ws, message) {
  const client = clients.get(ws.clientId);
  if (!client) return;
  switch (message.type) {
    case "join":
      {
        const requestedName = sanitizeDisplayName(message.name, client.name);
        const nameRejected = isDisplayNameTaken(requestedName, ws.clientId);
        if (!nameRejected) client.name = requestedName;
        if (!hostId) { hostId = ws.clientId; client.role = "host"; }
        send(ws, {
          type: "role", role: client.role, hostId, clientId: ws.clientId,
          viewerCount: clients.size, name: client.name,
          ...(nameRejected ? { nameRejected: requestedName } : {})
        });
        send(ws, sessionState("join"));
        updatePresence();
      }
      break;
    case "set-name": {
      const requestedName = sanitizeDisplayName(message.name, client.name);
      if (isDisplayNameTaken(requestedName, ws.clientId)) {
        send(ws, {
          type: "name-rejected", name: client.name, requested: requestedName,
          message: `The display name “${requestedName}” is already in use.`
        });
        break;
      }
      client.name = requestedName;
      send(ws, { type: "name-updated", name: client.name });
      break;
    }
    case "chat": {
      const text = String(message.message || "").trim().slice(0, 300);
      if (!text) return;
      broadcast({ type: "chat", clientId: ws.clientId, name: client.name || "Guest", message: text,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      break;
    }
    case "video-state": {
      const syncMode = String(message.syncMode || "tick");
      if (!mediaPath || !mediaReady) return;
      const viewerPlayPause = client.role === "viewer" && (syncMode === "play" || syncMode === "pause");
      if (client.role !== "host" && !viewerPlayPause) return;
      const wasPaused = playback.paused;
      if (viewerPlayPause) {
        const sharedTime = currentTime();
        const reportedTime = Math.min(mediaDuration, Math.max(0, Number(message.time) || 0));
        const acceptedTime = Math.abs(reportedTime - sharedTime) <= 2 ? reportedTime : sharedTime;
        playback = {
          paused: syncMode === "pause",
          time: acceptedTime,
          rate: playback.rate,
          updatedAt: Date.now()
        };
      } else {
        playback = {
          paused: Boolean(message.paused),
          time: Math.min(mediaDuration, Math.max(0, Number(message.time) || 0)),
          rate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)),
          updatedAt: Date.now()
        };
      }
      if ((!wasPaused && playback.paused) || syncMode === "seek") cancelSegmentJobs(false);
      // Echo viewer play/pause back to its sender so its local shared-state
      // flag is updated too. Host-originated state already matches locally.
      broadcast(sessionState(syncMode), viewerPlayPause ? null : ws.clientId);
      break;
    }
  }
}

function chooseVideoFile(callback) {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms", "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Title = 'Choose a video for WatchParty'",
      "$d.Filter = 'Video files|*.mp4;*.webm;*.mkv;*.mov;*.m4v;*.ogv;*.ogg;*.avi;*.ts;*.mts;*.m2ts;*.mpg;*.mpeg;*.flv;*.wmv|All files|*.*'",
      "$d.Multiselect = $false",
      "if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false }, callback);
    return;
  }
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", "POSIX path of (choose file with prompt \"Choose a video for WatchParty\")"], callback);
    return;
  }
  execFile("sh", ["-c", "command -v zenity >/dev/null && exec zenity --file-selection --title='Choose a video for WatchParty' --file-filter='Video files | *.mp4 *.webm *.mkv *.mov *.m4v *.ogv *.ogg *.avi *.ts *.mts *.m2ts *.mpg *.mpeg *.flv *.wmv'; command -v kdialog >/dev/null && exec kdialog --getopenfilename . '*.mp4 *.webm *.mkv *.mov *.m4v *.ogv *.ogg *.avi *.ts *.mts *.m2ts *.mpg *.mpeg *.flv *.wmv|Video files'; exit 127"], callback);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/hls/") && (req.method === "GET" || req.method === "HEAD")) {
    serveHls(req, res, url); return;
  }
  if (url.pathname === "/api/select-video" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { if (body.length < 10000) body += chunk; });
    req.on("end", () => {
      let requesterId = "";
      try { requesterId = JSON.parse(body).clientId; } catch {}
      if (!requesterId || requesterId !== hostId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only the host can choose a video." })); return;
      }
      chooseVideoFile((error, stdout) => {
        const selectedPath = String(stdout || "").trim();
        if (error || !selectedPath) {
          const unavailable = error && error.code === 127;
          res.writeHead(unavailable ? 500 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(unavailable ? { error: "Install Zenity or KDialog to use the file picker." } : { cancelled: true })); return;
        }
        fs.stat(selectedPath, (statError, stat) => {
          if (statError || !stat.isFile()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "The selected video could not be opened." })); return;
          }
          mediaPath = selectedPath; mediaVersion += 1; mediaDuration = 0; captionTracks = [];
          mediaReady = false; mediaProcessing = true; selectedEncoder = "Detecting hardware";
          playback = { paused: true, time: 0, rate: 1, updatedAt: Date.now() };
          const state = sessionState("source"); broadcast(state);
          res.writeHead(202, { "Content-Type": "application/json" }); res.end(JSON.stringify(state));
          prepareMedia(selectedPath);
        });
      });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD, POST" }); res.end(); return; }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC, requested);
  if (!filePath.startsWith(`${PUBLIC}${path.sep}`) && filePath !== path.join(PUBLIC, "index.html")) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(error.code === "ENOENT" ? 404 : 500); res.end(error.code === "ENOENT" ? "Not found" : "Server error"); return; }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    if (req.method === "HEAD") res.end(); else res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
wss.on("connection", (ws) => {
  ws.clientId = crypto.randomUUID();
  clients.set(ws.clientId, { ws, role: hostId ? "viewer" : "host", name: availableGuestName(ws.clientId) });
  ws.on("message", (data) => { try { handleMessage(ws, JSON.parse(data.toString())); } catch { send(ws, { type: "error", message: "Invalid message." }); } });
  ws.on("close", () => {
    const wasHost = ws.clientId === hostId; clients.delete(ws.clientId);
    if (wasHost) {
      hostId = null; mediaPath = null; mediaReady = false; mediaProcessing = false; mediaDuration = 0; captionTracks = [];
      playback = { paused: true, time: 0, rate: 1, updatedAt: Date.now() };
      stopMediaWork();
      const abandonedDirectory = hlsDirectory; hlsDirectory = null; removeTempDirectory(abandonedDirectory);
      broadcast({ type: "host-left" });
      const next = clients.entries().next().value;
      if (next) {
        hostId = next[0]; next[1].role = "host";
        send(next[1].ws, { type: "role", role: "host", hostId, clientId: next[0], viewerCount: clients.size });
        send(next[1].ws, sessionState("join"));
      }
    }
    updatePresence();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WatchParty running at http://localhost:${PORT}`);
  try {
    const addresses = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === "IPv4" && !item.internal);
    for (const address of addresses) console.log(`LAN: http://${address.address}:${PORT}`);
  } catch { console.log("LAN: use this computer's IPv4 address with port " + PORT); }
});

function shutdown() {
  stopMediaWork();
  const directory = hlsDirectory; hlsDirectory = null; removeTempDirectory(directory);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
