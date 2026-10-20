const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");
const { connectPeer, serveHostFiles } = require("./helpers/peer");

test("HTTP modules, chat names, host-only file sharing, and host handoff work together", async (t) => {
  const app = createApplication({
    config: { port: 0 },
    encoderPromise: Promise.resolve(CPU_ENCODER)
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const host = await connectPeer(base.replace("http", "ws"), "Alex");
  const viewer = await connectPeer(base.replace("http", "ws"), "alex");
  assert.equal(host.role.role, "host");
  assert.equal(viewer.role.role, "viewer");
  assert.equal(viewer.role.nameRejected, "alex");
  assert.notEqual(viewer.role.name, "alex");

  const html = await (await fetch(base)).text();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  assert.equal((html.match(/class="vote-panel"/g) || []).length, 1);
  const modules = ["js/app.js", "js/chat.js", "js/party.js", "js/voting.js", "js/theme.js", "js/connection.js", "js/player/controller.js", "js/player/sync.js", "js/player/fullscreen.js", "js/player/subtitles.js"];
  for (const file of modules) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type"), /javascript/);
  }
  for (const file of ["base", "layout", "player", "chat", "voting", "responsive"]) {
    const response = await fetch(`${base}/css/${file}.css`, { method: "HEAD" });
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type"), /text\/css/);
    assert.equal(await response.text(), "");
  }
  viewer.send({ type: "set-name", name: "Bob" });
  assert.equal((await viewer.next("name-updated")).name, "Bob");
  assert.ok((await host.next("presence", (message) => message.participants.some((participant) => participant.name === "Bob"))).count === 2);
  host.send({ type: "set-name", name: "bOb" });
  assert.equal((await host.next("name-rejected")).name, "Alex");
  viewer.send({ type: "chat", message: "Hi from Bob" });
  assert.equal((await host.next("chat")).name, "Bob");
  viewer.send({ type: "reaction", emoji: "😂" });
  assert.equal((await host.next("reaction")).emoji, "😂");
  viewer.send({ type: "reaction", emoji: "unsupported" });
  assert.equal((await viewer.next("error")).message, "That emoji reaction is not supported.");
  viewer.send({ type: "suggest-video", title: "  Movie   One " });
  await host.next("party-state", (message) => message.suggestions.some((suggestion) => suggestion.title === "Movie One"));
  host.send({ type: "suggest-video", title: "Movie Two" });
  await viewer.next("party-state", (message) => message.suggestions.some((suggestion) => suggestion.title === "Movie Two"));
  viewer.send({ type: "vote-video", suggestionId: 1 });
  await host.next("party-state", (message) => message.suggestions.find((suggestion) => suggestion.id === 1)?.votes === 1);
  host.send({ type: "vote-video", suggestionId: 2 });
  await viewer.next("party-state", (message) => message.suggestions.find((suggestion) => suggestion.id === 2)?.votes === 1);
  viewer.send({ type: "vote-video", suggestionId: 2 });
  const finalVotes = await host.next("party-state", (message) =>
    message.suggestions.find((suggestion) => suggestion.id === 1)?.votes === 0 &&
    message.suggestions.find((suggestion) => suggestion.id === 2)?.votes === 2
  );
  assert.equal(finalVotes.suggestions.find((suggestion) => suggestion.id === 2).votes, 2);
  assert.equal(finalVotes.myVoteId, 2);
  assert.equal((await viewer.next("party-state", (message) =>
    message.myVoteId === 2 && message.suggestions.find((suggestion) => suggestion.id === 2)?.votes === 2
  )).myVoteId, 2);

  const newcomer = await connectPeer(base.replace("http", "ws"), "Newcomer");
  const joined = await newcomer.next("party-state", (message) => message.participants.length === 3);
  assert.equal(joined.myVoteId, null);
  assert.equal(joined.suggestions.find((suggestion) => suggestion.id === 2).votes, 2);
  newcomer.ws.close();
  await host.next("presence", (message) => message.count === 2);

  const denied = await fetch(`${base}/api/select-video`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: viewer.role.clientId })
  });
  assert.equal(denied.status, 410);
  viewer.send({ type: "source-register", video: { id: "file", name: "movie.mkv", size: 100 }, captions: [] });
  assert.match((await viewer.next("error")).message, /Only the room host/);
  host.ws.close();
  await viewer.next("host-left");
  assert.equal((await viewer.next("role")).role, "host");
  const afterHandoff = await viewer.next("party-state", (message) => message.participants.length === 1);
  assert.equal(afterHandoff.participants[0].role, "host");
  assert.equal(afterHandoff.suggestions.find((suggestion) => suggestion.id === 2).votes, 1);
  assert.equal(afterHandoff.myVoteId, 2);
  assert.equal(app.state.videoVotes.has(host.role.clientId), false);
});

test("captions remain separate, seeks encode the requested segment, and segments are cached", async (t) => {
  const ffmpegPath = require("ffmpeg-static");
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) { t.skip("FFmpeg is not installed"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-test-media-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "movie.mkv");
  fs.copyFileSync(path.join(__dirname, "fixtures/movie.style.ass"), path.join(directory, "movie.style.ass"));
  execFileSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-i", path.join(__dirname, "fixtures/captions.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:s", "-t", "12",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s", "srt", source
  ], { timeout: 20000, stdio: "pipe" });

  const app = createApplication({
    config: { port: 0, ffmpegPath },
    encoderPromise: Promise.resolve(CPU_ENCODER)
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const host = await connectPeer(base.replace("http", "ws"), "Host");
  const relay = await serveHostFiles(host, base,
    { name: "movie.mkv", bytes: fs.readFileSync(source) },
    [{ name: "movie.style.ass", bytes: fs.readFileSync(path.join(directory, "movie.style.ass")) }]);
  const ready = await host.next("session-state", (message) => message.hasVideo);
  assert.equal(ready.captions.length, 2);
  const viewer = await connectPeer(base.replace("http", "ws"), "Viewer");
  const viewerState = await viewer.next("session-state", (message) => message.hasVideo);
  assert.deepEqual(viewerState.captions, ready.captions);
  const master = await (await fetch(base + ready.mediaUrl)).text();
  assert.doesNotMatch(master, /SUBTITLES|captions_/);
  for (const track of ready.captions) {
    const caption = await fetch(base + track.url);
    assert.equal(caption.status, 200);
    assert.match(await caption.text(), /\[Events\]/);
  }
  const first = await fetch(`${base}/hls/segment_000000.ts?v=1`);
  assert.equal(first.status, 200);
  assert.ok((await first.arrayBuffer()).byteLength > 188);

  host.send({ type: "video-state", syncMode: "seek", paused: true, time: 8, playbackRate: 1 });
  await viewer.next("session-state", (message) => message.syncMode === "seek");
  const middleUrl = `${base}/hls/segment_000004.ts?v=1`;
  const middle = await fetch(middleUrl);
  assert.equal(middle.status, 200);
  const middleBytes = Buffer.from(await middle.arrayBuffer());
  assert.deepEqual(Buffer.from(await (await fetch(middleUrl)).arrayBuffer()), middleBytes);
  const segments = fs.readdirSync(path.join(app.state.hlsDirectory, `run_${app.state.streamGeneration}`)).filter((file) => file.endsWith(".ts"));
  assert.deepEqual(segments.sort(), ["segment_000003.ts", "segment_000004.ts"]);
  assert.equal((await fetch(`${base}/hls/master.m3u8?v=999`)).status, 404);
  assert.ok(relay.reads.length > 0);
  assert.equal(ready.fileName, "movie.mkv");

  // Caption edits do not replace the stream, playback clock, or cached segments.
  const beforeVersion = app.state.mediaVersion;
  const beforeUrl = require('../server/state').sessionState(app.state).mediaUrl;
  const added = relay.declare({ name: "extra.srt", bytes: fs.readFileSync(path.join(__dirname, "fixtures/captions.srt")) });
  host.send({ type: "captions-add", sourceId: relay.sourceId, files: [added] });
  const updated = await viewer.next("captions-updated", (message) => message.captions.length === 3);
  assert.equal(app.state.mediaVersion, beforeVersion);
  assert.equal(app.state.playback.time, 8);
  assert.equal(app.state.playback.paused, true);
  assert.equal(require('../server/state').sessionState(app.state).mediaUrl, beforeUrl);
  assert.equal((await fetch(base + updated.captions[2].url)).status, 200);
  const removedTrack = updated.captions[0];
  host.send({ type: "caption-remove", sourceId: relay.sourceId, trackId: removedTrack.id });
  await viewer.next("captions-updated", (message) => !message.captions.some((track) => track.id === removedTrack.id));
  assert.equal((await fetch(base + removedTrack.url)).status, 404);
  assert.deepEqual(Buffer.from(await (await fetch(middleUrl)).arrayBuffer()), middleBytes);

  const countBeforeFailure = app.state.captionTracks.length;
  const validCaption = relay.declare({ name: "valid.srt", bytes: fs.readFileSync(path.join(__dirname, "fixtures/captions.srt")) });
  const invalidCaption = relay.declare({ name: "broken.srt", bytes: Buffer.from("This is not a subtitle file") });
  host.send({ type: "captions-add", requestId: "partial-batch", sourceId: relay.sourceId, files: [validCaption, invalidCaption] });
  await host.next("error", (message) => message.requestId === "partial-batch");
  assert.equal(app.state.captionTracks.length, countBeforeFailure, "Failed caption batches leave the active list intact");

  const pendingCaption = relay.declare({ name: "pending.srt", bytes: fs.readFileSync(path.join(__dirname, "fixtures/captions.srt")) });
  host.send({ type: "captions-add", requestId: "source-changing", sourceId: relay.sourceId, files: [pendingCaption] });
  const replaced = await serveHostFiles(host, base, { name: "replacement.mkv", bytes: fs.readFileSync(source) });
  const replacementState = await host.next("session-state", (message) => message.hasVideo && message.fileName === "replacement.mkv");
  assert.notEqual(replacementState.mediaVersion, beforeVersion);
  assert.equal(replacementState.captions.length, 1, "Old caption conversions cannot appear in a replacement source");
  assert.notEqual(replaced.sourceId, relay.sourceId);

  viewer.send({ type: "video-state", syncMode: "play", time: 8, playbackRate: 4 });
  const playing = await host.next("session-state", (message) => message.syncMode === "play");
  assert.equal(playing.paused, false);
  assert.equal(playing.playbackRate, 1);
  viewer.send({ type: "video-state", syncMode: "pause", time: 8 });
  assert.equal((await host.next("session-state", (message) => message.syncMode === "pause")).paused, true);
});
