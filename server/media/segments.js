const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { encoderAttempts } = require("../encoders");
const { currentTime } = require("../state");

function createSegmentService({ state, config, encoderPromise, broadcast }) {
  const FFMPEG_PATH = config.ffmpegPath;
  const SEGMENT_SECONDS = config.segmentSeconds;
  const MAX_SEGMENTS_AHEAD = config.maxSegmentsAhead;
  const segmentJobs = new Map();

  function cancelSegmentJobs(includeWaiting = true) {
    for (const [index, job] of segmentJobs) {
      if (!includeWaiting && !job.started) continue;
      job.cancelled = true;
      if (job.process && job.process.exitCode === null) job.process.kill();
      segmentJobs.delete(index);
    }
  }
  
  async function waitForSegmentPermission(index, version, job) {
    while (version === state.mediaVersion && !job.cancelled) {
      const target = Math.floor(currentTime(state) / SEGMENT_SECONDS);
      if ((!state.playback.paused && index <= target + MAX_SEGMENTS_AHEAD) || (state.playback.paused && index === target)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("The requested stream was replaced.");
  }
  
  function runSegmentAttempt(job, attempt, start, duration, tempPath, version) {
    return new Promise((resolve, reject) => {
      const videoFilter = attempt.name === "libx264"
        ? ["-vf", "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2':flags=lanczos"]
        : [];
      const args = [
        "-hide_banner", "-loglevel", "warning", "-y", ...attempt.input,
        "-ss", start.toFixed(3), "-i", state.mediaPath, "-t", duration.toFixed(3),
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
        if (job.cancelled || version !== state.mediaVersion) { reject(new Error("Segment encoding was paused or replaced.")); return; }
        if (code === 0) resolve(attempt.label);
        else reject(new Error(errorOutput.trim().split("\n").slice(-2).join(" ") || `${attempt.name} failed.`));
      });
    });
  }
  
  async function ensureSegment(index) {
    const version = state.mediaVersion;
    const outputPath = path.join(state.hlsDirectory, `segment_${String(index).padStart(6, "0")}.ts`);
    if (fs.existsSync(outputPath)) return outputPath;
    if (segmentJobs.has(index)) return segmentJobs.get(index).promise;
  
    const job = { process: null, cancelled: false, started: false, promise: null };
    job.promise = (async () => {
      await waitForSegmentPermission(index, version, job);
      if (job.cancelled || version !== state.mediaVersion) throw new Error("Segment encoding was cancelled.");
      job.started = true;
      const start = index * SEGMENT_SECONDS;
      const duration = Math.min(SEGMENT_SECONDS, state.mediaDuration - start);
      const tempPath = `${outputPath}.tmp`;
      const encoder = await encoderPromise;
      let lastError;
      for (const attempt of encoderAttempts(encoder)) {
        try {
          const activeLabel = await runSegmentAttempt(job, attempt, start, duration, tempPath, version);
          if (job.cancelled || version !== state.mediaVersion) throw new Error("Segment encoding was cancelled.");
          fs.renameSync(tempPath, outputPath);
          if (state.selectedEncoder !== activeLabel) {
            state.selectedEncoder = activeLabel;
            broadcast({ type: "transcode-info", encoder: activeLabel });
          }
          return outputPath;
        } catch (error) {
          lastError = error;
          fs.rmSync(tempPath, { force: true });
          if (job.cancelled || version !== state.mediaVersion) throw error;
        }
      }
      throw lastError || new Error("Segment encoding failed.");
    })().finally(() => { if (segmentJobs.get(index) === job) segmentJobs.delete(index); });
    segmentJobs.set(index, job);
    return job.promise;
  }

  return { ensure: ensureSegment, cancel: cancelSegmentJobs };
}

module.exports = { createSegmentService };
