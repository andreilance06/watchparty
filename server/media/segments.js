const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const { encoderAttempts, CPU_ENCODER } = require("../encoders");
const { currentTime, sessionState } = require("../state");
const { segmentSchedule, streamDirectory, writePlaylists } = require("./playlists");
const { isWatchPartyTempDirectory } = require("./temp-files");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function compatibilityFilter(info = {}, profile) {
  const filters = [];
  if (info.hdr) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
  filters.push(profile ? `scale=${profile.width}:${profile.height}` :
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "format=yuv420p");
  return filters.join(",");
}

function renditionEncoderArgs(encoder, profile) {
  if (!profile) return encoder.args;
  // ICQ/CQP and VideoToolbox's quality mode can ignore a bandwidth budget.
  // Select bitrate-based rate control for those encoders; x264 keeps CRF+VBV.
  const qualityFlags = new Set(["-global_quality", "-q:v", "-qp_i", "-qp_p", "-qp_b"]);
  if (encoder.name === "h264_amf") qualityFlags.add("-rc");
  const args = [];
  for (let index = 0; index < encoder.args.length; index++) {
    if (qualityFlags.has(encoder.args[index])) index++;
    else args.push(encoder.args[index]);
  }
  if (encoder.name === "h264_amf") args.push("-rc", "vbr_peak");
  return args;
}

function createSegmentService({ state, config, encoderPromise, broadcast, spawnEncoder = spawn }) {
  const jobs = new Set(), failedEncoders = new Set();
  let preferredEncoder = CPU_ENCODER, failureVersion = -1, cancelEpoch = 0, recoveryFailures = 0;
  encoderPromise.then(encoder => { preferredEncoder = encoder; }).catch(() => {});
  const filename = (directory, index) => path.join(directory, `segment_${String(index).padStart(6, "0")}.ts`);
  const valid = job => !job.cancelled && !job.signal?.aborted && job.epoch === cancelEpoch &&
    job.version === state.mediaVersion && job.generation === (state.streamGeneration || 0);

  function cancel() {
    const retired = [...jobs].map(job => job.promise);
    cancelEpoch++;
    for (const job of jobs) {
      job.cancelled = true;
      job.process?.kill();
      job.sink?.close();
      job.sink?.closeAllConnections();
    }
    jobs.clear();
    return Promise.allSettled(retired);
  }

  function restart(recovery = false) {
    if (!recovery) recoveryFailures = 0;
    const directory = streamDirectory(state), parent = state.hlsDirectory;
    const retired = [...jobs].map(job => job.promise);
    cancel();
    state.streamGeneration = (state.streamGeneration || 0) + 1;
    const { seconds } = segmentSchedule(state, config.segmentSeconds);
    state.compatibilityStartIndex = Math.max(0, Math.floor(currentTime(state) / seconds) - 1);
    writePlaylists(state, config.segmentSeconds);
    // Drain cancelled writes before reclaiming a retired generation. The
    // bootstrap fragment lives separately and remains available to native HLS.
    const renditionDirectory = state.roomState && isWatchPartyTempDirectory(state.roomState.hlsDirectory) &&
      path.dirname(parent) === state.roomState.hlsDirectory && /^r_\d+x\d+_\d+_\d+$/.test(path.basename(parent));
    if ((isWatchPartyTempDirectory(parent) || renditionDirectory) && path.dirname(directory) === parent && /^run_\d+$/.test(path.basename(directory))) {
      Promise.allSettled(retired).then(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => {}));
    }
  }

  async function permission(index, job) {
    while (valid(job)) {
      // Near a boundary, a paused seek needs a little decoded media after its
      // target to finish. Permit at most one following fragment for that case.
      const lead = state.playback.paused ? Math.min(job.schedule.seconds, Math.max(0.25, 2 / job.schedule.fps)) : 0;
      const target = Math.floor((currentTime(state) + lead) / job.schedule.seconds);
      if (index === 0 || index <= target + (state.playback.paused ? 0 : config.maxSegmentsAhead)) return;
      await delay(25);
    }
    throw new Error("Segment encoding was cancelled.");
  }

  async function encode(job, encoder) {
    const permit = config.encoderBudget?.acquire(job);
    let encodedAt = Date.now(), permissionWait = 0;
    const token = crypto.randomBytes(24).toString("hex");
    const partials = new Set(), uploads = new Set();
    // HTTP supplies portable backpressure, retaining the live AAC codec while
    // FFmpeg waits for permission to upload the next segment.
    async function receive(req, res) {
      let partial, name;
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        if (!valid(job) || req.method !== "PUT" || !req.url.startsWith(`/${token}/`)) {
          res.writeHead(403); res.end(); return;
        }
        if (req.headers.expect !== "100-continue") throw new Error("Encoder did not request upload permission.");
        name = req.url.slice(token.length + 2);
        const match = /^segment_(\d{6})\.ts$/.exec(name);
        if (!match && name !== "encoder.m3u8") { res.writeHead(404); res.end(); return; }
        if (match) {
          const index = Number(match[1]);
          if (index < job.index || index >= job.end) throw new Error("Invalid encoder output.");
          req.pause();
          const waitingAt = Date.now();
          await permission(index, { ...job, signal: controller.signal });
          permissionWait += Date.now() - waitingAt;
          if (!valid(job)) throw new Error("Segment encoding was cancelled.");
          res.writeContinue();
          partial = `${filename(job.directory, index)}.partial`;
          partials.add(partial);
          await pipeline(req, fs.createWriteStream(partial));
          if (!valid(job)) throw new Error("Segment encoding was cancelled.");
          fs.renameSync(partial, filename(job.directory, index));
          partials.delete(partial);
          job.published++;
          permit?.sample(Math.max(0, Date.now() - encodedAt - permissionWait) / (job.schedule.seconds * 1000));
          encodedAt = Date.now(); permissionWait = 0;
          if (index === 0) fs.copyFileSync(filename(job.directory, index), path.join(state.hlsDirectory, "bootstrap.ts"));
          if (!job.announced) {
            job.announced = true;
            state.selectedEncoder = encoder.label;
            broadcast({ type: "transcode-info", encoder: encoder.label });
          }
        } else {
          res.writeContinue();
          const chunks = []; let length = 0;
          for await (const chunk of req) {
            if ((length += chunk.length) > 4 * 1024 * 1024) throw new Error("Encoder playlist is too large.");
            chunks.push(chunk);
          }
          const durations = [...Buffer.concat(chunks).toString().matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1]));
          if (durations.slice(0, -1).some(d => Math.abs(d - job.schedule.seconds) > 1 / job.schedule.fps + 0.002)) {
            throw new Error("Encoder segment timing differs from its playlist.");
          }
        }
        res.writeHead(200); res.end();
      } catch (error) {
        error.message = `${name || "encoder output"}: ${error.message}`;
        if (partial) { fs.rmSync(partial, { force: true }); partials.delete(partial); }
        if (valid(job)) { job.outputError = error; job.process?.kill(); }
        if (!res.destroyed) { res.writeHead(503); res.end(); }
      } finally {
        req.removeListener("aborted", abort);
        res.removeListener("close", abort);
      }
    }
    const receiveRequest = (req, res) => {
      const upload = receive(req, res);
      uploads.add(upload);
      upload.finally(() => uploads.delete(upload)).catch(() => {});
    };
    const sink = job.sink = http.createServer(receiveRequest);
    sink.on("checkContinue", receiveRequest);
    sink.requestTimeout = 0;
    sink.timeout = 0;
    sink.keepAliveTimeout = 0;
    try {
      await new Promise((resolve, reject) => {
        sink.once("error", reject);
        sink.listen(0, "127.0.0.1", resolve);
      });
      if (!valid(job)) throw new Error("Segment encoding was cancelled.");
      // An HTTP userinfo component makes FFmpeg's HTTP writer negotiate
      // Expect: 100-continue on every upload (auth remains unset). Withhold
      // that response until permission is granted, before any body is sent.
      const output = `http://encoder@127.0.0.1:${sink.address().port}/${token}`;
      const start = job.index * job.schedule.seconds;
      const duration = Math.min(state.mediaDuration, job.end * job.schedule.seconds) - start;
      const args = ["-hide_banner", "-loglevel", "warning", "-y", ...encoder.input,
        "-ss", start.toFixed(9), ...(state.mediaPath.startsWith("http:") ? ["-rw_timeout", "30000000"] : []),
        "-i", state.mediaPath, "-t", duration.toFixed(9), "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", `${compatibilityFilter(state.mediaInfo, state.rendition)},fps=${job.schedule.fps}`, "-c:v", encoder.name, ...renditionEncoderArgs(encoder, state.rendition),
        ...(state.rendition ? ["-b:v", String(state.rendition.bitrate)] : []),
        "-maxrate", String(state.rendition?.bitrate || 8000000), "-bufsize", String((state.rendition?.bitrate || 8000000) * 2), "-pix_fmt", "yuv420p", "-bf", "0",
        "-r", String(job.schedule.fps), "-profile:v", "high", "-level:v", "4.1",
        "-g", String(job.schedule.frames), "-keyint_min", String(job.schedule.frames),
        "-force_key_frames", `expr:gte(n,n_forced*${job.schedule.frames})`, "-sc_threshold", "0",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        "-output_ts_offset", start.toFixed(9), "-muxdelay", "0", "-muxpreload", "0",
        "-f", "hls", "-hls_time", String(job.schedule.seconds), "-hls_list_size", "3",
        "-hls_flags", "independent_segments", "-start_number", String(job.index),
        "-method", "PUT", "-http_persistent", "1",
        "-hls_segment_filename", `${output}/segment_%06d.ts`, `${output}/encoder.m3u8`];
      await new Promise((resolve, reject) => {
        let stderr = "";
        job.process = spawnEncoder(config.ffmpegPath, args, { windowsHide: true });
        job.process.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
        job.process.once("error", reject);
        job.process.once("close", code => {
          job.process = null;
          if (!valid(job)) reject(new Error("Segment encoding was cancelled."));
          else if (job.outputError) reject(job.outputError);
          else if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `${encoder.name} failed.`));
        });
      });
      // FFmpeg may exit after its final write before Node finishes the atomic
      // rename. Wait for uploads before declaring the run complete.
      while (uploads.size) await Promise.all([...uploads]);
      if (job.outputError) throw job.outputError;
    } finally {
      sink.close(); sink.closeAllConnections();
      while (uploads.size) await Promise.allSettled([...uploads]);
      for (const file of partials) fs.rmSync(file, { force: true });
      permit?.release();
    }
  }

  function start(bootstrap = false) {
    const schedule = segmentSchedule(state, config.segmentSeconds);
    const index = bootstrap ? 0 : state.compatibilityStartIndex || 0;
    const job = { index, end: bootstrap ? 1 : schedule.count, schedule, version: state.mediaVersion,
      generation: state.streamGeneration || 0, epoch: cancelEpoch, directory: streamDirectory(state), published: 0 };
    fs.mkdirSync(job.directory, { recursive: true });
    jobs.add(job);
    job.promise = (async () => {
      if (failureVersion !== job.version) { failedEncoders.clear(); recoveryFailures = 0; failureVersion = job.version; }
      let lastError;
      for (const encoder of encoderAttempts(preferredEncoder).filter(e => !e.input.length)) {
        if (failedEncoders.has(encoder.name)) continue;
        try { await encode(job, encoder); return; }
        catch (error) {
          lastError = error;
          if (error.code === "QUALITY_BUSY") throw error;
          if (!valid(job)) throw error;
          if (encoder.name !== "libx264") failedEncoders.add(encoder.name);
          if (job.published && recoveryFailures++ < 2) {
            // Never change published bytes or splice encoder timelines.
            restart(true);
            broadcast(sessionState(state, "recovery"));
            throw error;
          }
          job.outputError = null;
        }
      }
      if (valid(job)) broadcast({ type: "media-error", message: "Compatibility encoding failed. Check the server encoder or choose another video." });
      throw lastError || new Error("No compatible encoder is available.");
    })();
    job.promise.then(() => { job.done = true; }, error => { job.done = true; job.error = error; });
    return job;
  }

  async function ensure(index, signal, generation = state.streamGeneration || 0) {
    const directory = streamDirectory(state), version = state.mediaVersion;
    const output = filename(directory, index);
    if (generation !== (state.streamGeneration || 0) || signal?.aborted) throw new Error("Segment encoding was cancelled.");
    if (fs.existsSync(output)) return output;
    const bootstrap = index === 0 && state.compatibilityStartIndex > 0;
    const saved = path.join(state.hlsDirectory, "bootstrap.ts");
    if (bootstrap && fs.existsSync(saved)) {
      fs.mkdirSync(directory, { recursive: true }); fs.copyFileSync(saved, output); return output;
    }
    if (index < (state.compatibilityStartIndex || 0) && !bootstrap) throw new Error("Segment belongs to an earlier playback run.");
    const request = { version, generation, epoch: cancelEpoch, signal, schedule: segmentSchedule(state, config.segmentSeconds) };
    await permission(index, request);
    if (!valid(request)) throw new Error("Segment encoding was cancelled.");
    const job = [...jobs].find(j => valid(j) && j.index <= index && index < j.end) || start(bootstrap);
    while (!job.done) {
      if (signal?.aborted || !valid(job) || version !== state.mediaVersion) throw new Error("Segment encoding was cancelled.");
      // Release the brief bootstrap process's budget before the client requests
      // its continuous run, especially when another rendition occupies a slot.
      if (fs.existsSync(output) && !bootstrap) return output;
      await delay(25);
    }
    if (job.error) throw job.error;
    if (!fs.existsSync(output)) throw new Error("Encoder did not produce the requested segment.");
    return output;
  }

  return { ensure, cancel, restart, running: () => [...jobs].some(job => !job.done) };
}

module.exports = { createSegmentService, compatibilityFilter };
