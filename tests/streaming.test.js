const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { createApplication } = require('../server/application');
const { CPU_ENCODER } = require('../server/encoders');
const { connectPeer, serveHostFiles } = require('./helpers/peer');
const { parseMediaInfo } = require('../server/media/probe');
const { compatibilityFilter } = require('../server/media/segments');
const { streamDirectory } = require('../server/media/playlists');
const { segmentSchedule } = require('../server/media/playlists');
const { requestProtocol, validOrigin } = require('../server/rooms');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { size = '320x180', duration = '12', audio = 'pcm_s16le', video = 'libx264', fps = '15' } = {}) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) { t.skip('FFmpeg is unavailable'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watchparty-test-streaming-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'source.mkv');
  execFileSync(ffmpeg, ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=${fps}`,
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',duration,'-c:v',video,'-preset','ultrafast','-g','30',
    ...(video === 'libx265' ? ['-pix_fmt','yuv420p10le','-x265-params','pools=2:frame-threads=2:log-level=error'] : []),
    '-c:a',audio,...(audio === 'eac3' ? ['-ac','6','-b:a','640k'] : []),filename], { stdio:'pipe', timeout:20000 });
  return { ffmpeg, directory, bytes: fs.readFileSync(filename) };
}
async function application(t, config = {}, encoderPromise = Promise.resolve(CPU_ENCODER)) {
  const app = createApplication({ config: { port:0, ...config }, encoderPromise });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const host = await connectPeer(base.replace('http','ws'), 'Host');
  return { app, base, host };
}

test('original-file ranges are exact, cached, generation checked, and independent of encoder/caption preparation', async t => {
  const source = fixture(t); if (!source) return;
  const { app, base, host } = await application(t, {}, new Promise(() => {}));
  const relay = await serveHostFiles(host, base, {name:'source.mkv',bytes:source.bytes}, [{name:'invalid.ass',bytes:Buffer.from('invalid captions')}]);
  const ready = await host.next('session-state', m=>m.hasVideo);
  assert.equal(ready.mediaInfo.audioCodec, 'pcm_s16le');
  assert.equal(ready.captions.length, 1);
  assert.equal(fs.readdirSync(app.state.hlsDirectory).some(f=>f.endsWith('.ass')), false);
  const url = base + ready.originalUrl;
  const head = await fetch(url,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(Number(head.headers.get('content-length')),source.bytes.length);
  assert.equal(head.headers.get('content-type'),'video/x-matroska');
  assert.equal((await head.arrayBuffer()).byteLength,0);
  for (const [range,start,end] of [['bytes=10-100',10,101],['bytes=-20',source.bytes.length-20,source.bytes.length],['bytes=100-',100,source.bytes.length]]) {
    const response = await fetch(url,{headers:{Range:range}});
    assert.equal(response.status,206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),source.bytes.subarray(start,end));
  }
  const before=relay.reads.length;
  await Promise.all([1,2,3].map(()=>fetch(url,{headers:{Range:'bytes=10-100'}}).then(r=>r.arrayBuffer())));
  assert.equal(relay.reads.length,before);
  for (const range of ['bytes=-0','bytes=0-1,4-5','bytes=9007199254740992-']) assert.equal((await fetch(url,{headers:{Range:range}})).status,416);
  const invalidCaption=await fetch(base+ready.captions[0].url);
  assert.equal(invalidCaption.status,503);
  assert.equal((await fetch(url,{method:'HEAD'})).status,200,'caption failure leaves the video usable');
  const compatible=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','segment_000000.ts'));
  assert.equal(compatible.status,200,'CPU encoding can start before hardware detection resolves');await compatible.arrayBuffer();
  app.media.reset();
  assert.equal((await fetch(url)).status,404);
});

test('compatibility requests are local to a viewer and one run publishes bounded cached segments with continuous AAC audio', async t=>{
  const source=fixture(t); if(!source)return;
  const {app,base,host}=await application(t);
  await serveHostFiles(host,base,{name:'source.mkv',bytes:source.bytes});
  const ready=await host.next('session-state',m=>m.hasVideo);
  const viewer=await connectPeer(base.replace('http','ws'),'Viewer');
  await viewer.next('session-state',m=>m.hasVideo);
  const originalPlayback={...app.state.playback};
  viewer.send({type:'compatibility-request',requestId:'local',mediaVersion:ready.mediaVersion});
  const compatible=await viewer.next('compatibility-ready');
  assert.equal(compatible.url,ready.compatibilityUrl);
  assert.deepEqual(app.state.playback,originalPlayback);
  assert.equal(host.messages.some(m=>m.type==='compatibility-ready'),false);
  viewer.send({type:'compatibility-request',requestId:'old',mediaVersion:ready.mediaVersion-1});
  await viewer.next('error',m=>m.requestId==='old');
  app.state.playback={paused:false,time:0,rate:1,updatedAt:Date.now()};
  const segmentUrl=base+ready.compatibilityUrl.replace('master.m3u8','segment_000000.ts');
  const outputs=await Promise.all([fetch(segmentUrl).then(r=>r.arrayBuffer()),fetch(segmentUrl).then(r=>r.arrayBuffer()),
    fetch(segmentUrl.replace('000000','000001')).then(r=>r.arrayBuffer()),fetch(segmentUrl.replace('000000','000002')).then(r=>r.arrayBuffer())]);
  assert.deepEqual(Buffer.from(outputs[0]),Buffer.from(outputs[1]));
  for(let i=0;i<100&&!fs.existsSync(path.join(streamDirectory(app.state),'segment_000002.ts'));i++)await delay(20);
  assert.equal(fs.readdirSync(streamDirectory(app.state)).filter(f=>f.endsWith('.ts')).length,3);
  await host.next('transcode-info');
  assert.equal(host.messages.filter(m=>m.type==='transcode-info').length,1,'overlapping fragment requests share one continuous encoding run');
  const probe=spawnSync(source.ffmpeg,['-hide_banner','-i',path.join(streamDirectory(app.state),'segment_000000.ts')],{encoding:'utf8',windowsHide:true});
  assert.match(probe.stderr,/Video: h264/);
  assert.match(probe.stderr,/Audio: aac.*48000 Hz, stereo/);
  assert.match(probe.stderr,/320x180/,'lower resolution is preserved');
});

test('compatibility output downscales above 1080p and survives a failed hardware encoder',async t=>{
  const source=fixture(t,{size:'2560x1440',duration:'2'});if(!source)return;
  const encoder={name:'encoder_does_not_exist',label:'Broken GPU',input:[],args:[]};
  const {app,base,host}=await application(t,{},Promise.resolve(encoder));
  await serveHostFiles(host,base,{name:'large.mkv',bytes:source.bytes});
  const ready=await host.next('session-state',m=>m.hasVideo);
  const response=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','segment_000000.ts'));
  assert.equal(response.status,200);
  await response.arrayBuffer();
  const probe=spawnSync(source.ffmpeg,['-hide_banner','-i',path.join(streamDirectory(app.state),'segment_000000.ts')],{encoding:'utf8',windowsHide:true});
  assert.match(probe.stderr,/1920x1080/);
});

test('metadata includes HDR and audio information, and compatibility tone maps before encoding',()=>{
  const info=parseMediaInfo('Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 24 fps\nStream #0:1: Audio: dts, 48000 Hz, 5.1','film.mkv');
  assert.equal(info.hdr,true);assert.equal(info.bitDepth,10);assert.equal(info.audioCodec,'dts');
  assert.match(compatibilityFilter(info),/tonemap=.*scale=/);
});

test('HTTPS forwarding is accepted only from an explicitly trusted loopback proxy',()=>{
  const req={headers:{host:'watch.example.com',origin:'https://watch.example.com','x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(requestProtocol(req),'http:');
  assert.equal(validOrigin(req),false);
  assert.equal(requestProtocol(req,{trustProxy:'loopback'}),'https:');
  assert.equal(validOrigin(req,{trustProxy:'loopback'}),true);
  req.socket.remoteAddress='192.168.1.2';
  assert.equal(requestProtocol(req,{trustProxy:'loopback'}),'http:');
  assert.equal(validOrigin(req,{publicOrigin:'https://other.example.com'}),false);
});

test('embedded font attachments are published lazily with styled captions', async t=>{
  const source=fixture(t,{duration:'3'});if(!source)return;
  const styled=path.join(source.directory,'styled.mkv');
  execFileSync(source.ffmpeg,['-y','-hide_banner','-loglevel','error','-i',path.join(source.directory,'source.mkv'),
    '-i',path.join(__dirname,'fixtures/movie.style.ass'),'-map','0:v','-map','0:a','-map','1:s','-c','copy',
    '-attach',path.join(__dirname,'../vendor/jassub/default.woff2'),'-metadata:s:t','mimetype=application/x-truetype-font',
    '-metadata:s:t','filename=caption-font.ttf',styled],{stdio:'pipe',timeout:20000});
  const {app,base,host}=await application(t);
  await serveHostFiles(host,base,{name:'styled.mkv',bytes:fs.readFileSync(styled)});
  const ready=await host.next('session-state',m=>m.hasVideo);
  assert.equal(ready.captions.length,1);assert.equal(ready.captions[0].fonts.length,1);
  assert.equal(fs.readdirSync(app.state.hlsDirectory).some(f=>f.startsWith('font_')),false);
  const caption=await fetch(base+ready.captions[0].url);assert.equal(caption.status,200);assert.match(await caption.text(),/Styled caption/);
  const font=await fetch(base+ready.captions[0].fonts[0]);assert.equal(font.status,200);
  assert.deepEqual(Buffer.from(await font.arrayBuffer()),fs.readFileSync(path.join(__dirname,'../vendor/jassub/default.woff2')));
});

test('a paused HLS seek can request its preceding fragment and cancelled waits do not launch encoders',async t=>{
  const source=fixture(t);if(!source)return;
  const {app,base,host}=await application(t);
  await serveHostFiles(host,base,{name:'seek.mkv',bytes:source.bytes});
  const ready=await host.next('session-state',m=>m.hasVideo);
  app.state.playback={paused:true,time:8,rate:1,updatedAt:Date.now()};
  const playlist=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','video.m3u8'));
  assert.match(await playlist.text(),/#EXT-X-START:TIME-OFFSET=8\.000,PRECISE=YES/);
  const bootstrap=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','segment_000000.ts'));
  assert.equal(bootstrap.status,200);await bootstrap.arrayBuffer();
  const previous=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','segment_000003.ts'));
  assert.equal(previous.status,200);await previous.arrayBuffer();
  const controller=new AbortController();
  const waiting=app.media.ensureSegment(5,controller.signal);controller.abort();
  await assert.rejects(waiting,/cancelled/);
  assert.equal(fs.existsSync(path.join(streamDirectory(app.state),'segment_000005.ts')),false);
});

test('HDR compatibility conversion produces decodable SDR H264 output',async t=>{
 const source=fixture(t,{duration:'2'});if(!source)return;
 const filename=path.join(source.directory,'hdr.mkv');
 execFileSync(source.ffmpeg,['-y','-hide_banner','-loglevel','error','-i',path.join(source.directory,'source.mkv'),
  '-c:v','ffv1','-pix_fmt','yuv420p10le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-c:a','copy',filename],{stdio:'pipe',timeout:20000});
 const {app,base,host}=await application(t);
 await serveHostFiles(host,base,{name:'hdr.mkv',bytes:fs.readFileSync(filename)});
 const ready=await host.next('session-state',m=>m.hasVideo);assert.equal(ready.mediaInfo.hdr,true);
 const response=await fetch(base+ready.compatibilityUrl.replace('master.m3u8','segment_000000.ts'));
 assert.equal(response.status,200);await response.arrayBuffer();
 const probe=spawnSync(source.ffmpeg,['-hide_banner','-i',path.join(streamDirectory(app.state),'segment_000000.ts'),'-frames:v','1','-f','null','-'],{encoding:'utf8',windowsHide:true});
 assert.equal(probe.status,0,probe.stderr);assert.match(probe.stderr,/Video: h264.*yuv420p/);assert.doesNotMatch(probe.stderr,/smpte2084/);
});

test('fractional-rate segments keep continuous AAC across backpressure, pause, and resume', async t => {
  const { createSegmentService } = require('../server/media/segments');
  const source = fixture(t, { video: 'libx265', fps: '24000/1001', audio: 'eac3' }); if (!source) return;
  const metadata = spawnSync(source.ffmpeg, ['-hide_banner', '-i', path.join(source.directory, 'source.mkv')], { encoding: 'utf8', windowsHide: true });
  const info = { ...parseMediaInfo(metadata.stderr, 'source.mkv'), fps: 24000 / 1001 };
  assert.equal(info.videoCodec, 'hevc'); assert.equal(info.bitDepth, 10);
  assert.equal(info.audioCodec, 'eac3'); assert.equal(info.channels, 6);
  const state = { mediaVersion: 1, streamGeneration: 0, hlsDirectory: source.directory,
    mediaPath: path.join(source.directory, 'source.mkv'), mediaDuration: 12, mediaInfo: info,
    playback: { paused: true, time: 0, rate: 0, updatedAt: Date.now() } };
  const announcements = [], children = [];
  const service = createSegmentService({ state, config: { segmentSeconds: 2, maxSegmentsAhead: 2, ffmpegPath: source.ffmpeg },
    encoderPromise: Promise.resolve(CPU_ENCODER), broadcast: m => announcements.push(m),
    spawnEncoder: (...args) => { const child = require('node:child_process').spawn(...args); children.push(child); return child; } });
  t.after(() => service.cancel());
  const { seconds, count } = segmentSchedule(state);
  assert.equal(seconds, 2.002);
  const first = await service.ensure(0);
  await delay(250);
  const segments = () => fs.readdirSync(streamDirectory(state)).filter(f => f.endsWith('.ts'));
  assert.equal(segments().length, 1, 'paused producer keeps its AAC state without publishing ahead');
  assert.equal(children[0].exitCode, null, 'the encoder must block before future uploads, even for a small file');
  const original = fs.readFileSync(first);
  state.playback.time = seconds - 0.05;
  await service.ensure(1);
  assert.equal(segments().length, 2, 'a paused seek near a boundary permits one following decoder fragment');
  state.playback.time = 0;
  state.playback.paused = false;
  await Promise.all([1, 2].map(i => service.ensure(i)));
  await delay(250);
  assert.equal(segments().length, 3, 'playing producer stops at its read-ahead limit');
  assert.equal(children[0].exitCode, null);
  state.playback.paused = true;
  await delay(150);
  assert.equal(segments().length, 3);
  state.playback = { paused: false, time: 12, rate: 0, updatedAt: Date.now() };
  const outputs = await Promise.all(Array.from({ length: count }, (_, i) => service.ensure(i)));
  assert.deepEqual(fs.readFileSync(first), original, 'published bytes stay immutable');
  assert.equal(announcements.filter(m => m.type === 'transcode-info').length, 1, 'pause/resume keeps the same encoder');
  assert.equal(children.length, 1);
  const joined = path.join(source.directory, 'continuous.ts');
  fs.writeFileSync(joined, Buffer.concat(outputs.map(f => fs.readFileSync(f))));
  const decoded = spawnSync(source.ffmpeg, ['-hide_banner', '-copyts', '-i', joined, '-vn', '-af', 'ashowinfo', '-f', 'f32le', '-ac', '1', '-'],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frames = [...decoded.stderr.toString().matchAll(/pts_time:([\d.\-]+).*nb_samples:(\d+)/g)];
  assert.ok(frames.length > 500);
  for (let i = 1; i < frames.length; i++) {
    const delta = Number(frames[i][1]) - Number(frames[i - 1][1]);
    assert.ok(Math.abs(delta - Number(frames[i - 1][2]) / 48000) < 0.0001, `audio timestamp gap at frame ${i}: ${delta}`);
  }
  const pcm = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.length / 4);
  // A continuous sine should never lose a 20 ms window at a segment boundary.
  for (let sample = 4800; sample < pcm.length - 5760; sample += 960) {
    let energy = 0;
    for (let i = sample; i < sample + 960; i++) energy += pcm[i] ** 2;
    assert.ok(Math.sqrt(energy / 960) > 0.03, `audible gap at ${sample / 48000}s`);
  }
});

test('seek acknowledgements change stream generation and stale ticks cannot roll the room clock back', async t => {
  const source = fixture(t); if (!source) return;
  const { app, base, host } = await application(t);
  await serveHostFiles(host, base, { name: 'source.mkv', bytes: source.bytes });
  const ready = await host.next('session-state', m => m.hasVideo);
  const oldSegment = base + ready.compatibilityUrl.replace('master.m3u8', 'segment_000000.ts');
  await (await fetch(oldSegment)).arrayBuffer();
  host.send({ type: 'video-state', mediaVersion: ready.mediaVersion, playbackRevision: ready.playbackRevision,
    commandSequence: 1, syncMode: 'seek', time: 8, paused: true, playbackRate: 1.25 });
  const sought = await host.next('session-state', m => m.syncMode === 'seek');
  assert.equal(sought.seekSequence, 1);
  assert.equal(sought.playbackRevision, ready.playbackRevision + 1);
  assert.notEqual(sought.compatibilityUrl, ready.compatibilityUrl);
  assert.equal((await fetch(oldSegment)).status, 404);
  const playlist = await (await fetch(base + sought.compatibilityUrl.replace('master.m3u8', 'video.m3u8'))).text();
  assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
  host.send({ type: 'video-state', mediaVersion: ready.mediaVersion, playbackRevision: ready.playbackRevision,
    commandSequence: 2, syncMode: 'tick', time: 2, paused: false, playbackRate: 1 });
  await delay(50);
  assert.equal(app.state.playback.time, 8);
  assert.equal(app.state.playback.paused, true);
  host.send({ type: 'video-state', mediaVersion: ready.mediaVersion, playbackRevision: ready.playbackRevision,
    commandSequence: 3, syncMode: 'seek', time: 3, paused: true, playbackRate: 1.25 });
  assert.equal((await host.next('session-state', m => m.syncMode === 'seek' && m.seekSequence === 3)).time, 3);
});

test('published-run failures recover with fresh URLs and stop after bounded retries', async t => {
  const { createSegmentService } = require('../server/media/segments');
  const source = fixture(t); if (!source) return;
  const state = { mediaVersion: 1, streamGeneration: 0, playbackRevision: 1, mediaReady: true,
    hlsDirectory: source.directory, mediaPath: path.join(source.directory, 'source.mkv'), mediaDuration: 12,
    mediaInfo: { fps: 15 }, playback: { paused: true, time: 0, rate: 1, updatedAt: Date.now() } };
  const events = [], children = [];
  const service = createSegmentService({ state, config: { segmentSeconds: 2, maxSegmentsAhead: 2, ffmpegPath: source.ffmpeg },
    encoderPromise: Promise.resolve(CPU_ENCODER), broadcast: m => events.push(m),
    spawnEncoder: (...args) => { const child = require('node:child_process').spawn(...args); children.push(child); return child; } });
  t.after(() => service.cancel());
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = state.streamGeneration;
    const output = await service.ensure(0);
    const bytes = fs.readFileSync(output);
    const before = events.length;
    children.at(-1).kill();
    for (let i = 0; i < 100 && !events.slice(before).some(m => m.syncMode === 'recovery' || m.type === 'media-error'); i++) await delay(10);
    assert.deepEqual(fs.readFileSync(output), bytes, 'published generation bytes are never overwritten');
    assert.equal(state.playback.time, 0); assert.equal(state.playback.paused, true);
    if (attempt < 2) {
      assert.equal(state.streamGeneration, generation + 1);
      const recovery = events.slice(before).find(m => m.syncMode === 'recovery');
      assert.ok(recovery.compatibilityUrl.endsWith(`g=${generation + 1}`));
      await assert.rejects(service.ensure(0, undefined, generation), /cancelled/);
    } else {
      assert.equal(state.streamGeneration, generation);
      assert.ok(events.slice(before).some(m => m.type === 'media-error'));
    }
  }
});
