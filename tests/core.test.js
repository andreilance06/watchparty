const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSession, currentTime, sessionState } = require("../server/state");
const { sanitizeDisplayName, displayNameKey, createNameRegistry } = require("../server/names");
const { createMessageHandler } = require("../server/messages");
const { parseDuration } = require("../server/media/probe");
const { encoderAttempts, CPU_ENCODER } = require("../server/encoders");
const { createSegmentService } = require("../server/media/segments");
const { isWatchPartyTempDirectory } = require("../server/media/temp-files");

test("session clocks are isolated and bounded by the video duration", () => {
  const first = createSession(), second = createSession();
  first.playback.time = 20;
  first.mediaDuration = 12;
  assert.equal(currentTime(first), 12);
  assert.equal(currentTime(second), 0);
  first.mediaPath = "/example/movie.mkv";
  first.mediaReady = true;
  first.mediaVersion = 3;
  assert.equal(sessionState(first, "join").mediaUrl, "/hls/master.m3u8?v=3&g=0");
  assert.equal(sessionState(second).hasVideo, false);
});

test("display names stay unique after whitespace, case, and Unicode normalization", () => {
  const clients = new Map([["first", { name: "Alex" }]]);
  const names = createNameRegistry(clients);
  assert.equal(sanitizeDisplayName("  Mary   Jane  "), "Mary Jane");
  assert.equal(displayNameKey("ＡＬＥＸ"), "alex");
  assert.equal(names.isDisplayNameTaken(" alex "), true);
  assert.equal(names.isDisplayNameTaken("Alex", "first"), false);
  clients.set("guest", { name: "Guest-1234" });
  assert.equal(names.availableGuestName("12345678"), "Guest-1234-2");
});

test("viewer play/pause is shared, while seeking and speed changes are host-only", () => {
  const state = createSession();
  state.mediaPath = "movie.mkv";
  state.mediaReady = true;
  state.mediaDuration = 100;
  state.playback.time = 10;
  state.clients.set("host", { role: "host", name: "Host" });
  state.clients.set("viewer", { role: "viewer", name: "Viewer" });
  const broadcasts = [];
  const cancellations = [];
  const handler = createMessageHandler({
    state,
    transport: { send() {}, broadcast: (...args) => broadcasts.push(args) },
    media: { restartStream: (...args) => cancellations.push(args) }
  });
  handler.handleMessage({ clientId: "viewer" }, { type: "video-state", syncMode: "seek", time: 90, playbackRate: 4 });
  assert.equal(state.playback.time, 10);
  handler.handleMessage({ clientId: "viewer" }, { type: "video-state", syncMode: "play", time: 90, playbackRate: 4 });
  assert.equal(state.playback.time, 10);
  assert.equal(state.playback.rate, 1);
  assert.equal(state.playback.paused, false);
  assert.equal(broadcasts.at(-1)[1], null);
  handler.handleMessage({ clientId: "viewer" }, { type: "video-state", syncMode: "pause", time: 10 });
  assert.equal(state.playback.paused, true);
  assert.deepEqual(cancellations, [], "pause retains the encoder and its AAC state");
  handler.handleMessage({ clientId: "host" }, { type: "video-state", syncMode: "seek", time: 60, playbackRate: 1.5, paused: true });
  assert.equal(state.playback.time, 60);
  assert.equal(state.playback.rate, 1.5);
});

test("GPU fallback order and media duration parsing are preserved", () => {
  const hardware = { name: "h264_nvenc", input: ["-hwaccel", "cuda"], args: [], label: "NVENC" };
  const attempts = encoderAttempts(hardware);
  assert.equal(attempts[0], hardware);
  assert.deepEqual(attempts[1].input, []);
  assert.equal(attempts[2], CPU_ENCODER);
  assert.equal(parseDuration("Duration: 01:02:03.500, start: 0"), 3723.5);
});

test("suggestions are normalized, deduplicated, bounded, and validated", () => {
  const state = createSession();
  const ws = { clientId: "host" };
  state.clients.set("host", { ws, role: "host", name: "Host" });
  const sent = [];
  const handler = createMessageHandler({
    state, transport: { send: (_, message) => sent.push(message), broadcast() {} }, media: {}
  });
  const suggest = (title) => handler.handleMessage(ws, { type: "suggest-video", title });
  suggest("  Movie   One ");
  suggest("movie one");
  assert.deepEqual(state.videoSuggestions, [{ id: 1, title: "Movie One" }]);
  suggest("   ");
  assert.equal(sent.at(-1).type, "error");
  assert.equal(state.videoSuggestions.length, 1);
  suggest("x".repeat(120));
  assert.equal(state.videoSuggestions[1].title.length, 100);
  for (let i = 2; i < 30; i++) suggest(`Movie ${i}`);
  suggest("Overflow");
  assert.equal(state.videoSuggestions.length, 30);
  assert.equal(sent.at(-1).message, "The next-video suggestion list is full.");
  suggest("MOVIE ONE");
  assert.equal(sent.at(-1).type, "party-state");

  for (const suggestionId of [null, "invalid", 999, 1.5]) {
    handler.handleMessage(ws, { type: "vote-video", suggestionId });
    assert.equal(sent.at(-1).type, "error");
    assert.equal(state.videoVotes.size, 0);
  }
});

test("votes are replaceable and party snapshots personalize each participant's selection", () => {
  const state = createSession();
  const host = { clientId: "host" }, viewer = { clientId: "viewer" };
  state.clients.set("host", { ws: host, role: "host", name: "Host" });
  state.clients.set("viewer", { ws: viewer, role: "viewer", name: "Viewer" });
  state.videoSuggestions.push({ id: 1, title: "One" }, { id: 2, title: "Two" });
  const latest = new Map();
  const handler = createMessageHandler({
    state, transport: { send: (ws, message) => latest.set(ws.clientId, message), broadcast() {} }, media: {}
  });
  const vote = (ws, suggestionId) => handler.handleMessage(ws, { type: "vote-video", suggestionId });
  vote(host, 1);
  vote(viewer, 2);
  assert.equal(latest.get("host").myVoteId, 1);
  assert.equal(latest.get("viewer").myVoteId, 2);
  assert.deepEqual(latest.get("host").suggestions.map((suggestion) => suggestion.votes), [1, 1]);
  vote(viewer, 1);
  vote(viewer, 1);
  assert.deepEqual(latest.get("host").suggestions.map((suggestion) => suggestion.votes), [2, 0]);
  assert.equal(latest.get("viewer").myVoteId, 1);
  assert.equal(state.videoVotes.size, 2);
  assert.equal(latest.get("viewer").participants.length, 2);
});

test("waiting segment jobs can be cancelled without starting an encoder", async () => {
  const state = createSession();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watchparty-test-cancel-"));
  state.hlsDirectory = directory;
  state.mediaDuration = 20;
  const service = createSegmentService({
    state,
    config: { segmentSeconds: 4, maxSegmentsAhead: 2, ffmpegPath: "must-not-run" },
    encoderPromise: Promise.resolve(CPU_ENCODER),
    broadcast() {}
  });
  try {
    const pending = service.ensure(1);
    service.cancel();
    await assert.rejects(pending, /replaced|cancelled/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("temporary cleanup targets only WatchParty HLS directories", () => {
  assert.equal(isWatchPartyTempDirectory(os.tmpdir()), false);
  assert.equal(isWatchPartyTempDirectory(path.join(os.tmpdir(), "other-app")), false);
  assert.equal(isWatchPartyTempDirectory(path.join(os.tmpdir(), "watchparty-hls-test")), true);
});
