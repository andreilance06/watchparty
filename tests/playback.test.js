const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble, captionItems, selectedCaption, pickCaption } = require('./helpers/browser');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const webCodecsInfo = { mime: 'video/x-matroska', videoCodec: 'h264', bitDepth: 8, pixelFormat: 'yuv420p',
 width: 1920, height: 1080, fps: 30, hasAudio: false };

async function playbackHarness({ mode = 'compatibility', paused = true, role = 'host' } = {}) {
 const b = createBrowserDouble(); let now = 1000;
 b.context.performance = { now: () => now };
 const create = b.document.createElement;
 b.document.createElement = tag => { const el = create(tag); if (tag === 'video') el.canPlayType = () => 'probably'; return el; };
 const { getElements } = await b.load('js/dom.js');
 const { createPlayer } = await b.load('js/player/controller.js');
 const elements = getElements(), video = elements.video, sent = [], reports = [];
 video.readyState = 4;
 const state = { role, clientId: role, mediaVersion: 0 };
 const player = createPlayer({ elements, state, send: message => { sent.push(message); }, report: message => reports.push(message),
  files: { setRole() {}, chooseVideo() {}, chooseCaptions() {} } });
 const snapshot = { type: 'session-state', mediaVersion: 1, playbackRevision: 1, hasVideo: true,
  paused, time: 17, playbackRate: 1.25, mediaUrl: '/hls/master.m3u8?v=1&g=0', compatibilityUrl: '/hls/master.m3u8?v=1&g=0',
  captions: [{ id: 'caption', url: '/caption.ass', label: 'Caption', format: 'ass' }],
  ...(mode === 'native' ? { originalUrl: '/media/original?v=1', mediaInfo: { ...webCodecsInfo, mime: 'video/mp4' } } : {}) };
 player.applySessionState(snapshot); await flush(); b.runTimers(100); await flush();
 const requests = () => sent.filter(message => message.type === 'compatibility-request');
 const reply = (values = {}) => player.applyCompatibility({ ...snapshot, type: 'compatibility-ready',
  requestId: requests().at(-1)?.requestId, url: snapshot.compatibilityUrl, ...values });
 return { b, player, state, video, elements, sent, reports, snapshot, requests, reply,
  advance: ms => { now += ms; }, source: () => video.children.find(child => child.tagName === 'source') };
}

test('long pauses and foreground return give active playback a fresh five-second stall window', async () => {
 for (const role of ['host', 'viewer']) {
  const h = await playbackHarness({ mode: 'native', role });
  for (let attempt = 0; attempt < 2; attempt++) {
   h.advance(180000); h.b.runTimers(1000); assert.equal(h.requests().length, 0);
   await h.video.play(); h.player.applySessionState({ ...h.snapshot, paused: false, syncMode: 'play' }); await flush();
   h.b.runTimers(1000); h.advance(4999); h.b.runTimers(1000);
   assert.equal(h.requests().length, 0, 'paused time must not count as a playback stall');
   h.video.currentTime += 1; h.b.runTimers(1000);
   h.video.pause(); h.player.applySessionState({ ...h.snapshot, time: h.video.currentTime, syncMode: 'pause' }); await flush();
  }
  await h.video.play(); h.player.applySessionState({ ...h.snapshot, paused: false, syncMode: 'play' }); await flush();
  h.b.runTimers(1000); h.b.document.hidden = true; h.b.document.dispatch('visibilitychange');
  h.advance(180000); h.b.runTimers(1000); assert.equal(h.requests().length, 0);
  h.b.document.hidden = false; h.b.document.dispatch('visibilitychange'); h.b.runTimers(1000);
  h.advance(4999); h.b.runTimers(1000); assert.equal(h.requests().length, 0);
  h.advance(1); h.b.runTimers(1000);
  assert.equal(h.requests().length, 1, 'a genuine active stall still falls back');
 }
});

test('startup and seek timeouts still trigger compatibility fallback', async () => {
 for (const phase of ['startup', 'seek']) {
  const h = await playbackHarness({ mode: 'native' });
  if (phase === 'startup') {
   h.video.readyState = 0;
   h.player.applySessionState({ ...h.snapshot, mediaVersion: 2, originalUrl: '/media/original?v=2' }); await flush();
  } else {
   h.video.seeking = true; h.video.dispatch('seeking');
  }
  h.advance(5001); h.b.runTimers(1000);
  assert.equal(h.requests().length, 1, phase);
 }
});

test('compatibility errors reload locally once and preserve shared transport and captions', async () => {
 for (const paused of [true, false]) {
  const h = await playbackHarness({ paused }); const original = h.source();
  h.video.dispatch('error', { detail: { message: 'Network error: fragLoadTimeOut' } });
  h.video.dispatch('errordisplay', { detail: { message: 'Duplicate fatal notification' } });
  h.video.dispatch('pause'); h.video.dispatch('seeking'); h.video.dispatch('ratechange');
  assert.equal(h.requests().length, 1); assert.equal(h.reports.length, 0);
  assert.equal(h.elements.syncStatus.textContent, 'Reconnecting playback…');
  h.reply({ time: 42, paused, playbackRate: 1.5 }); await flush(); h.b.runTimers(100); await flush();
  assert.notEqual(h.source(), original);
  assert.equal(h.video.currentTime, 42); assert.equal(h.video.paused, paused); assert.equal(h.video.playbackRate, 1.5);
  assert.equal(selectedCaption(h.video), 'caption');
  assert.equal(h.sent.filter(message => message.type === 'video-state').length, 0);
  assert.equal(h.video.watchpartyMetrics.recoveryAttempts, 1);
  assert.doesNotMatch(h.elements.syncStatus.textContent, /Reconnecting/);
  assert.equal(h.state.sourceSwitching, false); assert.equal(h.state.suppressVideoEvents, false);
  assert.equal([...h.b.timers.values()].filter(timer => timer.delay === 10000).length, 0);
  h.video.dispatch('error', { detail: { message: 'Replacement failed' } }); h.video.dispatch('errordisplay');
  assert.equal(h.requests().length, 1); assert.deepEqual(h.reports, ['Replacement failed']);
 }
});

test('recovery ignores retired-player readiness and duplicate errors until the replacement arrives', async () => {
 const h = await playbackHarness();
 const native = h.b.document.createElement('video'); Object.assign(native, { readyState: 4, paused: true, currentTime: 17 });
 const oldPlayer = { getHLSVideoElement: () => native }; h.video.player = oldPlayer;
 h.video.dispatch('error'); h.reply(); h.b.runTimers(100); await flush();
 assert.equal(h.state.sourceSwitching, true);
 h.video.dispatch('errordisplay'); assert.equal(h.reports.length, 0); assert.equal(h.requests().length, 1);
 const replacement = h.b.document.createElement('video'); Object.assign(replacement, { readyState: 0, paused: true, currentTime: 17 });
 h.video.player = { getHLSVideoElement: () => replacement }; h.b.runTimers(100);
 replacement.readyState = 4; h.b.runTimers(100); await flush(); h.b.runTimers(100);
 assert.equal(h.state.sourceSwitching, false); assert.equal(h.reports.length, 0);
 assert.equal([...h.b.timers.values()].filter(timer => timer.delay === 10000).length, 0);
});

test('same-URL recovery explicitly reloads Movi and ignores obsolete load failures', async () => {
 for (const superseded of [false, true]) {
  const h = await playbackHarness(); let rejectLoad, loads = 0;
  h.video.load = () => { loads++; return new Promise((resolve, reject) => { rejectLoad = reject; }); };
  h.video.dispatch('error'); h.reply(); await flush(); assert.equal(loads, 1);
  if (superseded) { h.player.applySessionState({ ...h.snapshot, mediaVersion: 2 }); await flush(); }
  rejectLoad(new Error('Reload failed')); await flush();
  assert.deepEqual(h.reports, superseded ? [] : ['Reload failed']);
 }
});

test('recovery request and replacement loading each stop after ten seconds', async () => {
 for (const phase of ['request', 'loading']) {
  const h = await playbackHarness(); h.video.dispatch('error');
  if (phase === 'loading') { h.video.readyState = 0; h.reply(); }
  h.b.runTimers(10000); h.video.dispatch('errordisplay');
  assert.equal(h.reports.length, 1); assert.match(h.reports[0], /could not reconnect/);
  assert.equal(h.elements.syncStatus.textContent, 'Could not play this video');
  assert.equal(h.requests().length, 1); const source = h.source();
  h.reply(); h.b.runTimers(100); await flush();
  assert.equal(h.source(), source, 'a late reply cannot revive timed-out playback');
  assert.equal(h.sent.filter(message => message.type === 'video-state').length, 0);
 }
});

test('replacement errors fail immediately without a second recovery request', async () => {
 const h = await playbackHarness(); h.video.dispatch('error'); h.video.readyState = 0; h.reply();
 h.video.dispatch('error', { detail: { message: 'Decoder failed' } }); h.video.dispatch('errordisplay');
 assert.deepEqual(h.reports, ['Decoder failed']); assert.equal(h.requests().length, 1);
 h.b.runTimers(10000); assert.equal(h.reports.length, 1);
});

test('newer playback revisions and sources supersede recovery replies', async () => {
 const h = await playbackHarness(); h.video.dispatch('error'); const firstRequest = h.requests()[0];
 h.player.applySessionState({ ...h.snapshot, playbackRevision: 2, time: 60, syncMode: 'host-transfer' });
 h.reply({ requestId: firstRequest.requestId });
 assert.equal(h.requests().length, 2); assert.notEqual(h.requests()[1].requestId, firstRequest.requestId);
 const original = h.source(); h.reply({ requestId: firstRequest.requestId, playbackRevision: 2 }); assert.equal(h.source(), original);
 h.reply({ playbackRevision: 2, time: 60 }); await flush(); h.b.runTimers(100);
 assert.equal(h.video.currentTime, 60); assert.equal(h.state.playbackRevision, 2);
 h.player.applySessionState({ ...h.snapshot, mediaVersion: 2 }); await flush();
 const newSource = h.source(); h.reply({ mediaVersion: 1 }); assert.equal(h.source(), newSource);
 h.video.dispatch('error'); assert.equal(h.requests().length, 3, 'a new video gets its own recovery budget');
});

test('stream generation changes supersede pending recovery without reloading twice', async () => {
 const h = await playbackHarness(); h.video.dispatch('error');
 const next = { ...h.snapshot, playbackRevision: 2, time: 60, compatibilityUrl: '/hls/master.m3u8?v=1&g=1', syncMode: 'seek' };
 h.player.applySessionState(next); await flush(); h.b.runTimers(100); await flush();
 const source = h.source(); assert.equal(source.src, next.compatibilityUrl);
 h.reply(); assert.equal(h.source(), source);
 h.player.applySessionState({ ...next, syncMode: 'tick' }); assert.equal(h.source(), source);
 assert.equal(h.requests().length, 1); assert.equal(h.sent.filter(message => message.type === 'video-state').length, 0);
});

test('source removal and server media failures cancel recovery and remain terminal', async () => {
 for (const failure of ['removed', 'server']) {
  const h = await playbackHarness(); h.video.dispatch('error');
  if (failure === 'removed') h.player.showNoVideo('Host disconnected');
  else h.player.showMediaError('The host file is unavailable.');
  const source = h.source(); h.reply(); h.video.dispatch('error'); h.b.runTimers(10000);
  assert.equal(h.source(), source); assert.equal(h.requests().length, 1);
  assert.deepEqual(h.reports, failure === 'server' ? ['The host file is unavailable.'] : []);
 }
});

test('silent WebCodecs playback needs only a video decoder and clears its assessment timer', async () => {
 const b=createBrowserDouble();b.context.isSecureContext=true;b.context.VideoDecoder={};
 const {choosePlayback}=await b.load('js/player/playback.js');
 assert.equal(await choosePlayback(webCodecsInfo),'wasm');
 assert.equal(b.timers.size,0);
 assert.equal(await choosePlayback({...webCodecsInfo,hasAudio:true,audioCodec:'aac'}),'compatibility');
 delete b.context.VideoDecoder;
 assert.equal(await choosePlayback(webCodecsInfo),'compatibility');
});

test('WebCodecs selection requires a smooth browser decoder rather than the standalone WASM decoder', async () => {
 for(const assessment of [
  {playable:true,smooth:true,video:{decoder:'hardware'}},
  {playable:true,smooth:true,video:{decoder:'software'}},
  {playable:true,smooth:true,video:{decoder:'wasm'}},
  {playable:true,smooth:false,video:{decoder:'hardware'}},
  {playable:false,smooth:true,video:{decoder:'hardware'}},
  null
 ]){
  const b=createBrowserDouble({assessPlayback:async()=>assessment});
  b.context.isSecureContext=true;b.context.VideoDecoder={};
  const {choosePlayback}=await b.load('js/player/playback.js');
  const expected=assessment?.playable&&assessment.smooth&&['hardware','software'].includes(assessment.video.decoder)?'wasm':'compatibility';
  assert.equal(await choosePlayback(webCodecsInfo),expected,JSON.stringify(assessment));
  assert.equal(b.timers.size,0);
 }
});

test('one assessment deadline bounds video and audio queries, and late rejections are handled', async () => {
 for(const stalled of ['video','audio']){
  let rejectQuery;
  const pending=new Promise((_,reject)=>{rejectQuery=reject;});
  const b=createBrowserDouble({assessPlayback:async()=>stalled==='video'?pending:{playable:true,smooth:true,video:{decoder:'hardware'}}});
  b.context.isSecureContext=true;b.context.VideoDecoder={};
  b.context.AudioDecoder={isConfigSupported:async()=>stalled==='audio'?pending:{supported:true}};
  const {choosePlayback}=await b.load('js/player/playback.js');
  const selection=choosePlayback({...webCodecsInfo,hasAudio:true,audioCodec:'aac'});
  await flush();assert.equal(b.timers.size,1);
  b.runTimers(500);
  assert.equal(await selection,'compatibility',stalled);
  assert.equal(b.timers.size,0);
  rejectQuery(new Error('late capability rejection'));await flush();
 }
});

test('failed video or audio capability checks use compatibility and release the deadline', async () => {
 for(const failed of ['video','audio','both']){
  const b=createBrowserDouble({assessPlayback:async()=>{
   if(failed!=='audio')throw new Error('video configuration rejected');
   return {playable:true,smooth:true,video:{decoder:'hardware'}};
  }});
  b.context.isSecureContext=true;b.context.VideoDecoder={};
  b.context.AudioDecoder={isConfigSupported:()=>{throw new Error('audio configuration rejected');}};
  const {choosePlayback}=await b.load('js/player/playback.js');
  assert.equal(await choosePlayback({...webCodecsInfo,hasAudio:failed!=='video',audioCodec:'aac'}),'compatibility');
  assert.equal(b.timers.size,0);
 }
});

test('measured hardware or software stutter falls back once and preserves transport and captions', async () => {
 for(const software of [false,true]){
  const b=createBrowserDouble();b.context.isSecureContext=true;b.context.VideoDecoder={};
  await b.load('js/app.js');const socket=b.sockets[0],video=b.elements.get('video');
  socket.open();socket.receive({type:'role',role:'host',clientId:'host',name:'Host',viewerCount:1});
  socket.receive({type:'session-state',mediaVersion:1,hasVideo:true,paused:true,time:17,playbackRate:1.25,
   originalUrl:'/media/original?v=1',mediaInfo:webCodecsInfo,
   captions:[{id:'caption',url:'/caption.ass',label:'Caption',format:'ass'}]});
  await flush();
  assert.equal(video.getAttribute('engine'),'wasm native');
  assert.equal(video.watchpartyMetrics.playbackMode,'wasm');
  assert.equal(socket.sent.some(m=>m.type==='compatibility-request'),false);
  const warning=video.dispatch('smoothwarning',{detail:{measured:true,software,media:'video'}});
  assert.equal(warning.defaultPrevented,true);
  video.dispatch('smoothwarning',{detail:{measured:true,software,media:'video'}});
  const requests=socket.sent.filter(m=>m.type==='compatibility-request');assert.equal(requests.length,1);
  assert.equal(video.watchpartyMetrics.fallbackReason,'decoder cannot keep up');
  socket.receive({type:'compatibility-ready',requestId:requests[0].requestId,mediaVersion:1,
   url:'/hls/master.m3u8?v=1',time:17,paused:true,playbackRate:1.25});
  assert.equal(video.currentTime,17);assert.equal(video.paused,true);assert.equal(video.playbackRate,1.25);
  assert.equal(selectedCaption(video),'caption');
  assert.equal(video.watchpartyMetrics.playbackMode,'compatibility');
  assert.equal(socket.sent.filter(m=>m.type==='video-state').length,0);
 }
});

test('late WebCodecs selection cannot replace a newer native source or revive a timed-out source', async () => {
 let resolveAssessment;
 const b=createBrowserDouble({assessPlayback:()=>new Promise(resolve=>{resolveAssessment=resolve;})});
 b.context.isSecureContext=true;b.context.VideoDecoder={};
 const create=b.document.createElement;
 b.document.createElement=tag=>{const el=create(tag);if(tag==='video')el.canPlayType=()=> 'probably';return el;};
 await b.load('js/app.js');const socket=b.sockets[0],video=b.elements.get('video');socket.open();
 const snapshot={type:'session-state',mediaVersion:1,hasVideo:true,paused:true,time:0,playbackRate:1,
  originalUrl:'/media/original?v=1',mediaInfo:webCodecsInfo,captions:[]};
 socket.receive(snapshot);await flush();
 socket.receive({...snapshot,mediaVersion:2,originalUrl:'/media/original?v=2',mediaInfo:{...webCodecsInfo,mime:'video/mp4'}});await flush();
 resolveAssessment({playable:true,smooth:true,video:{decoder:'hardware'}});await flush();
 assert.equal(video.children.find(c=>c.tagName==='source').src,'/media/original?v=2');
 assert.equal(video.getAttribute('engine'),'native wasm');assert.equal(video.watchpartyMetrics.playbackMode,'native');
 socket.receive({...snapshot,mediaVersion:3,originalUrl:'/media/original?v=3'});await flush();
 b.runTimers(500);await flush();
 assert.equal(socket.sent.filter(m=>m.type==='compatibility-request').length,1);
 resolveAssessment({playable:true,smooth:true,video:{decoder:'hardware'}});await flush();
 assert.equal(video.children.find(c=>c.tagName==='source').src,'/media/original?v=2');
 assert.equal(socket.sent.filter(m=>m.type==='compatibility-request').length,1);
});

test('a local fallback preserves playback/captions, rejects stale replies, and ignores synthetic control events',async()=>{
 const b=createBrowserDouble();await b.load('js/app.js');const socket=b.sockets[0],video=b.elements.get('video');
 socket.open();socket.receive({type:'role',role:'host',clientId:'host',name:'Host',viewerCount:1});
 const snapshot={type:'session-state',mediaVersion:5,hasVideo:true,paused:true,time:17,playbackRate:1.25,
   originalUrl:'/media/original?v=5',compatibilityUrl:'/hls/master.m3u8?v=5',mediaUrl:'/hls/master.m3u8?v=5',
   mediaInfo:{mime:'video/x-matroska',videoCodec:'hevc',audioCodec:'dts',hasAudio:true,width:1920,height:1080},
   captions:[{id:'caption',url:'/hls/captions_0.ass?v=5',label:'Styled',format:'ass'}]};
 socket.receive(snapshot);await flush();
 const request=socket.sent.find(m=>m.type==='compatibility-request');assert.ok(request);
 socket.receive({type:'compatibility-ready',requestId:request.requestId,mediaVersion:4,url:'/old',time:0,paused:false,playbackRate:1});
 assert.equal(video.children.some(c=>c.tagName==='source'),false);
 socket.receive({type:'compatibility-ready',requestId:request.requestId,mediaVersion:5,url:snapshot.compatibilityUrl,time:17,paused:true,playbackRate:1.25});
 assert.equal(video.currentTime,17);assert.equal(video.paused,true);assert.equal(video.playbackRate,1.25);
 assert.equal(selectedCaption(video),'caption');
 video.dispatch('seeking');video.dispatch('pause');video.dispatch('ratechange');
 assert.equal(socket.sent.filter(m=>m.type==='video-state').length,0);
 const source=video.children.find(c=>c.tagName==='source');
 socket.receive({...snapshot,time:18,syncMode:'tick'});
 assert.equal(video.children.find(c=>c.tagName==='source'),source,'heartbeats keep the local compatibility path');
 pickCaption(video, "off");
 socket.receive({type:'captions-updated',mediaVersion:5,captions:[...snapshot.captions,{id:'new',url:'/new',label:'New'}]});
 assert.equal(selectedCaption(video),'off');
});

test('native and HLS seek bridges follow the active public video surface and detach obsolete listeners',async()=>{
 const b=createBrowserDouble();const {createMediaEventBridge}=await b.load('js/player/media-events.js');
 const v=b.elements.get('video'),first=b.document.createElement('video'),second=b.document.createElement('video');
 let current=first,count=0;v.player={getHLSVideoElement:()=>current};v.addEventListener('seeking',()=>count++);
 const bridge=createMediaEventBridge(v);bridge.connect();first.dispatch('seeking');assert.equal(count,1);
 current=second;bridge.connect();first.dispatch('seeking');assert.equal(count,1);second.dispatch('seeking');assert.equal(count,2);
 current=null;bridge.connect();second.dispatch('seeking');assert.equal(count,2);
});

test('canplay after a host seek does not reapply the previous room timestamp',async()=>{
 const b=createBrowserDouble();await b.load('js/app.js');const socket=b.sockets[0],video=b.elements.get('video');
 socket.open();socket.receive({type:'role',role:'host',clientId:'host',name:'Host',viewerCount:1});
 socket.receive({type:'session-state',mediaVersion:1,hasVideo:true,paused:true,time:0,playbackRate:1,mediaUrl:'/hls/master.m3u8?v=1',captions:[]});
 video.readyState=4;video.dispatch('loadeddata');await flush();
 video.currentTime=40;video.dispatch('seeking');video.dispatch('canplay');
 assert.equal(video.currentTime,40);assert.equal(socket.sent.at(-1).time,40);
});

test('host encoder status survives playing and paused seeks and subsequent transport updates', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video'),syncStatus=b.elements.get('syncStatus');video.readyState=4;
 const state={role:'host',mediaVersion:1,activeMediaUrl:'/stream',activeEncoder:'h264_nvenc hardware encode'};
 const sync=createPlaybackSync({elements:{video,syncStatus},state,send:()=>{}});
 const updates=[
  {syncMode:'source',paused:true,time:0},
  {syncMode:'seek',paused:false,time:40},
  {syncMode:'pause',paused:true,time:40},
  {syncMode:'seek',paused:true,time:80},
  {syncMode:'play',paused:false,time:80},
  {syncMode:'pause',paused:true,time:80}
 ];
 for(const update of updates){
  sync.apply({mediaVersion:1,...update},update.syncMode==='source');await flush();
  assert.equal(syncStatus.textContent,'You control playback • h264_nvenc hardware encode',`${update.syncMode}, paused=${update.paused}`);
 }
});

test('playback status preserves host labels without an encoder and existing viewer messages', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video'),syncStatus=b.elements.get('syncStatus');video.readyState=4;
 const state={role:'host',mediaVersion:1,activeMediaUrl:'/stream',activeEncoder:''};
 const sync=createPlaybackSync({elements:{video,syncStatus},state,send:()=>{}});
 for(const role of ['host','viewer']){
  state.role=role;state.activeEncoder=role==='host'?'':'h264_nvenc hardware encode';
  for(const paused of [true,false]){
   sync.apply({mediaVersion:1,syncMode:'seek',paused,time:40},false);await flush();
   assert.equal(syncStatus.textContent,role==='host'?'You control playback':paused?'Paused':'Synchronized with host');
  }
 }
});

test('caption preparation starts before the first picture, media events reuse it, and Off releases the rendering loop',async()=>{
 const b=createBrowserDouble();const {createSubtitles}=await b.load('js/player/subtitles.js');
 const video=b.elements.get('video');
 const captions=createSubtitles({elements:{video},report:()=>{}});
 captions.setTracks([{id:'one',url:'/one.ass',label:'One'}],{reset:true,key:'1'});
 assert.equal(b.requests.some(r=>r.url==='/one.ass'),true);
 await flush();assert.equal(b.renderers.length,1);
 b.runFrame();await flush();assert.equal(b.renderers[0].lastFrame,undefined,'preparation does not draw over the previous source');
 video.dispatch('loadedmetadata');video.dispatch('loadeddata');video.dispatch('watchparty-picture-ready');
 video.dispatch('trackschange');await flush();assert.equal(b.renderers.length,1);
 assert.equal(b.requests.filter(r=>r.url==='/one.ass').length,1);
 b.runFrame();await flush();assert.ok(b.renderers[0].lastFrame);
 captions.select(null);await flush();assert.equal(b.renderers[0].destroyed,true);
 const last=b.renderers[0].lastFrame;b.runFrame();assert.equal(b.renderers[0].lastFrame,last);
});

test('device selection checks actual audio channels and routes unusual codecs to compatibility playback',async()=>{
 const b=createBrowserDouble();
 b.context.isSecureContext=true;b.context.VideoDecoder={};let assessedAudio;
 b.context.AudioDecoder={isConfigSupported:async(config)=>{assessedAudio=config;return{supported:config.numberOfChannels<=2};}};
 const {choosePlayback}=await b.load('js/player/playback.js');
 const info={mime:'video/x-matroska',videoCodec:'h264',bitDepth:8,pixelFormat:'yuv420p',width:640,height:360,fps:30,hasAudio:true,audioCodec:'aac',channels:1,sampleRate:44100};
 assert.equal(await choosePlayback(info),'wasm');assert.equal(assessedAudio.numberOfChannels,1);assert.equal(assessedAudio.sampleRate,44100);
 assert.equal(await choosePlayback({...info,channels:6}),'compatibility');
 assert.equal(await choosePlayback({...info,audioCodec:'dts'}),'compatibility');
 assert.equal(await choosePlayback({...info,pixelFormat:'yuv444p'}),'compatibility');
 b.context.isSecureContext=false;assert.equal(await choosePlayback(info),'compatibility');
 const create=b.document.createElement;
 b.document.createElement=tag=>{const el=create(tag);if(tag==='video')el.canPlayType=()=> 'probably';return el;};
 assert.equal(await choosePlayback({...info,mime:'video/mp4'}),'native','plain HTTP can still use native compatible files');
});

test('compatibility buffering stops paused prefetch and resumes for seeks without touching the room clock',async()=>{
 const b=createBrowserDouble();const {createCompatibilityBuffer}=await b.load('js/player/compatibility-buffer.js');
 const video=b.elements.get('video'),calls=[];
 const native={paused:true,seeking:false,readyState:4,currentTime:40};
 const hls={stopLoad:()=>calls.push(['stop']),startLoad:time=>calls.push(['start',time])};
 video.player={streamWrapper:{hls},getHLSVideoElement:()=>native};
 const buffer=createCompatibilityBuffer(video);buffer.update();buffer.update();
 assert.deepEqual(calls,[['stop']]);
 native.seeking=true;native.currentTime=2;video.dispatch('seeking');
 assert.deepEqual(calls.at(-1),['start',2]);
 native.seeking=false;video.dispatch('seeked');assert.deepEqual(calls.at(-1),['stop']);
 native.paused=false;video.dispatch('play');assert.deepEqual(calls.at(-1),['start',2]);
 video.player=null;buffer.update();
});

test('Movi clearing its own subtitle container cannot detach the custom caption surface',async()=>{
 const b=createBrowserDouble();const {createSubtitles}=await b.load('js/player/subtitles.js');
 const video=b.elements.get('video'),internal=b.document.createElement('div');
 video.player={setSubtitleRenderer(){},selectSubtitleTrack:()=>{internal.replaceChildren();return Promise.resolve();}};
 video.setSubtitleRenderer=renderer=>{video.subtitleRenderer=renderer;renderer.mount(internal);};
 const subtitles=createSubtitles({elements:{video},report:()=>{}});
 subtitles.setTracks([{id:'one',url:'/one.ass',label:'One'}],{reset:true,key:'1'});video.dispatch('loadeddata');await flush();
 assert.equal(video.subtitleRenderer.surface.parentNode,video);
 video.dispatch('trackschange');await flush();
 assert.equal(video.subtitleRenderer.surface.parentNode,video);assert.equal(b.renderers[0].destroyed,undefined);
});

test('renderer hooks cannot draw into JASSUB until worker initialization completes',async()=>{
 let initialized;const ready=new Promise(resolve=>{initialized=resolve;});
 const b=createBrowserDouble({rendererReady:ready});const {createJassubAdapter}=await b.load('js/player/jassub-adapter.js');
 const video=b.elements.get('video');const adapter=createJassubAdapter({video,report:()=>{},loadContent:async()=> '[Script Info]\n[Events]'});
 adapter.mount(video);const selection=adapter.select({url:'/one.ass',label:'One'});await flush();
 await adapter.render(1,640,360);assert.equal(b.renderers[0].lastFrame,undefined);
 initialized();await selection;await adapter.render(1,640,360);assert.ok(b.renderers[0].lastFrame);await adapter.destroy();
});

test('native HLS recovery seeks never emit host seek intent and replaced players are restored', async () => {
 const b=createBrowserDouble();const {createMediaEventBridge}=await b.load('js/player/media-events.js');
 const v=b.elements.get('video'),native=b.document.createElement('video');
 const calls=[],intents=[];const original=async(time)=>calls.push(time);
 const player={getHLSVideoElement:()=>native,seek:original};v.player=player;
 v.addEventListener('watchparty-seek-intent',e=>intents.push(e.detail.time));
 const bridge=createMediaEventBridge(v);bridge.connect();bridge.connect();
 native.dispatch('seeking');native.dispatch('seeked');assert.deepEqual(intents,[]);
 await player.seek(40);await player.seek(10,{internal:true});
 assert.deepEqual(intents,[40]);assert.deepEqual(calls,[40,10]);
 v.player=null;bridge.connect();assert.equal(player.seek,original);
});

test('metadata polling releases initial suppression and delayed seeks stay suppressed until they settle', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video'),native=b.document.createElement('video'),sent=[];
 Object.assign(native,{readyState:0,seeking:false,paused:true,currentTime:0});
 video.player={getHLSVideoElement:()=>native};
 const state={role:'host',mediaVersion:1,activeMediaUrl:'/stream',sourceSwitching:true};
 const sync=createPlaybackSync({elements:{video,syncStatus:b.elements.get('syncStatus')},state,send:m=>sent.push(m)});
 sync.apply({mediaVersion:1,paused:true,time:0},true);
 native.readyState=4;sync.update();await flush();
 assert.equal(state.suppressVideoEvents,false,'missing wrapper metadata/canplay cannot leave controls suppressed');
 state.sourceSwitching=true;sync.update();assert.equal(state.sourceSwitching,true,'a completed apply cannot clear a later source switch');
 state.sourceSwitching=false;
 native.seeking=true;sync.apply({mediaVersion:1,paused:true,time:40,syncMode:'seek'},false);
 b.runTimers(400);sync.update();sync.broadcast('tick');assert.equal(sent.length,0);
 native.currentTime=40;native.seeking=false;native.dispatch('seeked');
 sync.broadcast('tick');assert.equal(sent.at(-1).time,40);
});

test('rapid seek acknowledgements and stale snapshots cannot undo the latest host target', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video');video.readyState=4;
 const state={role:'host',mediaVersion:1,playbackRevision:2,activeMediaUrl:'/stream'};const sent=[];
 const sync=createPlaybackSync({elements:{video,syncStatus:b.elements.get('syncStatus')},state,send:m=>sent.push(m)});
 sync.broadcast('seek',40);sync.broadcast('seek',80);sync.broadcast('tick');
 assert.deepEqual(sent.map(m=>m.time),[40,80]);
 assert.equal(sync.accept({mediaVersion:1,playbackRevision:3,syncMode:'seek',seekSequence:1}),false);
 assert.equal(sync.accept({mediaVersion:1,playbackRevision:4,syncMode:'seek',seekSequence:2}),true);
 video.currentTime=80;
 sync.apply({mediaVersion:1,playbackRevision:4,syncMode:'tick',time:20,paused:false},false);
 assert.equal(video.currentTime,80,'routine snapshots cannot move the host clock');
 assert.equal(sync.accept({mediaVersion:1,playbackRevision:3,syncMode:'tick'}),false);
 sync.broadcast('tick');assert.equal(sent.at(-1).playbackRevision,4);
});

test('transport intent is shared even when Movi emits it before changing the native video', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video'),native=b.document.createElement('video');
 Object.assign(native,{paused:true,currentTime:8});video.player={getHLSVideoElement:()=>native};
 const state={role:'host',mediaVersion:1,activeMediaUrl:'/stream'},sent=[];
 const sync=createPlaybackSync({elements:{video,syncStatus:b.elements.get('syncStatus')},state,send:m=>sent.push(m)});
 sync.broadcast('play');assert.equal(sent.at(-1).paused,false);assert.equal(state.latestHostPaused,false);
 native.paused=false;sync.broadcast('pause');assert.equal(sent.at(-1).paused,true);assert.equal(state.latestHostPaused,true);
});

test('play immediately after seeking survives the seek acknowledgement', async () => {
 const b=createBrowserDouble();const {createPlaybackSync}=await b.load('js/player/sync.js');
 const video=b.elements.get('video');video.readyState=4;
 const state={role:'host',mediaVersion:1,playbackRevision:1,activeMediaUrl:'/stream'},sent=[];
 const sync=createPlaybackSync({elements:{video,syncStatus:b.elements.get('syncStatus')},state,send:m=>sent.push(m)});
 sync.broadcast('seek',18.5);video.paused=false;sync.broadcast('play');
 assert.equal(sent.length,1,'transport waits for the acknowledged revision');
 const ack={mediaVersion:1,playbackRevision:2,syncMode:'seek',seekSequence:1,paused:true,time:18.5};
 assert.equal(sync.accept(ack),true);sync.apply(ack,false);await flush();
 assert.equal(video.paused,false);assert.equal(sent.at(-1).syncMode,'play');assert.equal(sent.at(-1).playbackRevision,2);
});
