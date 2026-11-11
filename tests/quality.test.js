const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');
const { bitrateRange, qualityOptions, resolveQuality } = require('../server/media/quality');
const { createEncoderBudget } = require('../server/media/encoder-budget');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('finite quality profiles preserve aspect ratio, never upscale, and reject unbounded values', () => {
  const info = { width: 1920, height: 1080 };
  assert.deepEqual(qualityOptions(info).map(option => option.quality), ['1080','720','480','360']);
  assert.deepEqual(resolveQuality(info, '720', 1500000), { quality:'720',width:1280,height:720,bitrate:1500000,id:'1280x720_1500000' });
  assert.equal(resolveQuality(info, 'auto').quality, '720');
  assert.deepEqual(qualityOptions({width:320,height:180})[0], {quality:'180',width:320,height:180,bitrate:260000});
  assert.equal(qualityOptions({width:640,height:480})[0].quality,'480','4:3 sources retain their supported height');
  assert.equal(qualityOptions({width:1080,height:1920})[0].quality,'1080','portrait sources retain their supported height');
  for (const [quality, bitrate] of [['2160','auto'],['720',1],['720','3000000'],['../720','auto'],[{},'auto']])
    assert.throws(() => resolveQuality(info,quality,bitrate));
  const wide = qualityOptions({width:1920,height:800});
  assert.ok(wide.every(option => option.width <= 1920 && option.height <= 800));
});

test('bitrate bounds follow source dimensions, frame rate and bitrate and accept intermediate values', () => {
  const info = { width: 1920, height: 1080, fps: 30, bitrate: 10000000 };
  assert.deepEqual(bitrateRange(info), { min: 500000, max: 10000000, step: 1000 });
  assert.equal(resolveQuality(info, '720', 2345000).id, '1280x720_2345000');
  assert.equal(resolveQuality(info, '720', 500000).bitrate, 500000);
  assert.equal(resolveQuality(info, '720', 10000000).bitrate, 10000000);
  for (const value of [499999, 10000001, NaN, Infinity, -1, 2345000.5, '2345000', {}, null, 'source']) {
    assert.throws(() => resolveQuality(info, '720', value));
  }
  const large = { width: 3840, height: 2160, fps: 60, bitrate: 40000000 };
  assert.ok(bitrateRange(large).max > bitrateRange(info).max);
  assert.ok(bitrateRange({ width: 640, height: 360 }).max < bitrateRange(info).max);
  for (const info of [{}, { width: 2, height: 2, fps: 1 }, { bitrate: Infinity, fps: NaN }]) {
    const range = bitrateRange(info);
    assert.ok(Number.isFinite(range.max) && range.max >= range.min && range.min > 0);
  }
  const profile = resolveQuality(large, 'source', 'source');
  assert.equal(profile.width, 3840); assert.equal(profile.height, 2160);
  assert.equal(profile.rateControl, 'near-lossless'); assert.equal(profile.bitrate, 'source');
  assert.equal(profile.id, '3840x2160_source');
  assert.throws(() => resolveQuality(large, 'source', 'auto'));
});

test('bitrate slider previews intermediate values, survives repaint, and synchronizes Source and Auto', async () => {
  const b = createBrowserDouble(), video = b.elements.get('video');
  const list = b.document.createElement('div'); list.className = 'movi-quality-list'; video.shadowRoot.appendChild(list);
  const { createNativeQualityMenu } = await b.load('js/player/native-quality-menu.js');
  let state = { enabled: true, mediaVersion: 1, quality: 'auto', bitrate: 'auto',
    options: qualityOptions({ width: 1920, height: 1080 }), bitrateRange: { min: 400000, max: 8000000, step: 1000 } };
  const changes = [];
  const menu = createNativeQualityMenu({ video, onChange(next) { changes.push(next); state = { ...state, ...next }; menu.update(state); } });
  menu.update(state);
  const select = list.querySelector('select'), slider = list.querySelectorAll('input').find(input => input.type === 'range');
  const auto = list.querySelectorAll('input').find(input => input.type === 'checkbox');
  const label = list.querySelector('output'), reset = list.querySelector('button');
  assert.equal(select.getAttribute('aria-label'), 'Resolution');
  assert.equal(auto.checked, true); assert.equal(slider.disabled, true); assert.equal(reset.hidden, true);
  auto.checked = false; auto.dispatch('change');
  assert.equal(slider.disabled, false); assert.equal(reset.hidden, false);
  const before = changes.length;
  for (const [value, expected] of [[1499000,'Low'], [1500000,'Medium'], [2999000,'Medium'], [3000000,'High'], [4999000,'High'], [5000000,'Very high']]) {
    slider.value = String(value); slider.dispatch('input'); assert.match(label.textContent, new RegExp(`^${expected}`));
  }
  slider.value = '2345000'; slider.dispatch('input');
  assert.equal(label.textContent, 'Medium · 2.345 Mbps');
  assert.equal(slider.getAttribute('aria-valuetext'), label.textContent);
  menu.update({ ...state, status: 'Telemetry update' });
  assert.equal(slider.value, '2345000'); assert.equal(changes.length, before);
  assert.equal(list.children[0].dispatch('keydown', { key: 'ArrowRight' }).propagationStopped, true);
  slider.dispatch('change'); assert.equal(state.bitrate, 2345000); assert.equal(changes.length, before + 1);
  select.value = '720'; select.dispatch('change');
  slider.value = slider.max; slider.dispatch('input'); assert.equal(label.textContent, 'Source'); slider.dispatch('change');
  assert.equal(select.value, 'source'); assert.equal(state.bitrate, 'source'); assert.equal(reset.hidden, false);
  slider.value = '2000000'; slider.dispatch('input'); slider.dispatch('change');
  assert.equal(select.value, '720'); assert.equal(state.bitrate, 2000000);
  auto.checked = true; auto.dispatch('change'); assert.equal(reset.hidden, false, 'manual resolution still needs reset');
  reset.click(); assert.equal(reset.hidden, true); assert.equal(slider.disabled, true); assert.equal(select.value, 'auto');
  auto.checked = false; auto.dispatch('change'); assert.equal(state.bitrate, 2000000, 'remember the previous manual bitrate');
  slider.value = '3000000'; slider.dispatch('input');
  state = { ...state, mediaVersion: 2, bitrate: 1000000, bitrateRange: { min: 25000, max: 1000000, step: 1000 } };
  menu.update(state); assert.equal(slider.value, '1000000');
});

test('bitrate drags capture releases outside and discard cancelled previews', async () => {
  const b = createBrowserDouble(), video = b.elements.get('video');
  const list = b.document.createElement('div'); list.className = 'movi-quality-list'; video.shadowRoot.appendChild(list);
  const panel = b.document.createElement('div'); panel.className = 'movi-settings-menu'; video.shadowRoot.appendChild(panel);
  video.openSettingsPage = page => { video._settingsPage = page; };
  video.closeSettingsPage = () => { video._settingsPage = null; };
  const { createNativeQualityMenu } = await b.load('js/player/native-quality-menu.js');
  let state = { enabled: true, mediaVersion: 1, quality: '720', bitrate: 2000000,
    options: qualityOptions({ width: 1920, height: 1080 }), bitrateRange: { min: 400000, max: 8000000, step: 1000 } };
  const changes = [];
  const menu = createNativeQualityMenu({ video, onChange(next) { changes.push(next); state = { ...state, ...next }; menu.update(state); } });
  menu.update(state);
  const slider = list.querySelectorAll('input').find(input => input.type === 'range');
  const captured = new Set();
  slider.setPointerCapture = id => captured.add(id);
  slider.hasPointerCapture = id => captured.has(id);
  slider.releasePointerCapture = id => { captured.delete(id); slider.dispatch('lostpointercapture', { pointerId: id }); };
  const down = () => slider.dispatch('pointerdown', { pointerId: 7, button: 0 });
  video.openSettingsPage('quality');
  assert.equal(panel.getAttribute('data-watchparty-resolution'), '');
  assert.equal(down().defaultPrevented, false, 'native range behavior remains enabled');
  assert.equal(captured.has(7), true);
  slider.value = '3000000'; slider.dispatch('input');
  menu.update({ ...state, status: 'New telemetry while dragging' });
  assert.equal(slider.value, '3000000');
  slider.dispatch('pointerup', { pointerId: 8 });
  assert.equal(captured.has(7), true, 'unrelated pointer cannot finish drag');
  slider.dispatch('pointerup', { pointerId: 7, clientX: -100, clientY: -100 });
  slider.dispatch('change');
  assert.equal(changes.length, 1); assert.equal(state.bitrate, 3000000); assert.equal(captured.size, 0);
  assert.equal(slider.value, '3000000', 'lost capture after release cannot revert committed value');
  for (const type of ['pointercancel', 'lostpointercapture', 'blur']) {
    down(); slider.value = '4000000'; slider.dispatch('input');
    slider.dispatch(type, { pointerId: 7 });
    assert.equal(captured.size, 0); assert.equal(slider.value, '3000000');
    slider.dispatch('change'); assert.equal(changes.length, 1, 'cancel cannot commit a preview');
  }
  down(); slider.value = '5000000'; slider.dispatch('input');
  state = { ...state, mediaVersion: 2, bitrate: 1000000 }; menu.update(state);
  assert.equal(captured.size, 0); assert.equal(slider.value, '1000000');
  slider.dispatch('change'); assert.equal(changes.length, 1, 'old gesture cannot commit to new media');
  slider.dispatch('keydown', { key: 'ArrowRight' }); slider.value = '1001000'; slider.dispatch('input'); slider.dispatch('change');
  assert.equal(state.bitrate, 1001000); assert.equal(changes.length, 2);
  // Some browsers commit change before delivering pointerup.
  down(); slider.value = '2000000'; slider.dispatch('input'); slider.dispatch('change');
  slider.dispatch('pointerup', { pointerId: 7 });
  assert.equal(changes.length, 3); assert.equal(state.bitrate, 2000000); assert.equal(captured.size, 0);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    const event = slider.dispatch(type);
    assert.equal(event.propagationStopped, true); assert.equal(event.defaultPrevented, false);
  }
  video.closeSettingsPage();
  assert.equal(panel.getAttribute('data-watchparty-resolution'), null);
  menu.update(state);
  assert.equal(video.shadowRoot.querySelectorAll('[data-watchparty-settings-style]').length, 1);
});

test('encoder budget is shared and releases permits after failure or cancellation', () => {
  const budget = createEncoderBudget(2);
  const a = budget.acquire('a'), b = budget.acquire('b');
  assert.throws(() => budget.acquire('c'), {code:'QUALITY_BUSY'});
  a.sample(1.5); assert.equal(budget.snapshot().encodingRatio,1.5);
  a.release(); const c = budget.acquire('c');
  assert.equal(budget.snapshot().active,2); b.release(); c.release();
  assert.equal(budget.snapshot().active,0);
});

test('automatic policy handles absent speed APIs, constrained viewers, server load, and source upload', async () => {
  const b = createBrowserDouble();
  const { chooseAutomaticQuality: choose } = await b.load('js/player/quality-policy.js');
  const options = qualityOptions({width:1920,height:1080});
  const base = { options, sourceBitrate:10000000,sourceSupported:true };
  assert.equal(choose(base).id,'source');
  assert.equal(choose({...base,sourceSupported:false}).quality,'720');
  assert.equal(choose({...base,bps:4000000}).quality,'480');
  assert.equal(choose({...base,bps:500000}).quality,'360');
  assert.equal(choose({...base,bps:30000000}).id,'source');
  assert.notEqual(choose({...base,bps:30000000,providerBps:3000000}).id,'source');
  assert.equal(choose({...base,bps:30000000,pressure:1}).id,'source','original decoding does not add server encoding work');
  assert.equal(choose({...base,bitrate:1500000,bps:30000000}).bitrate,1500000);
  assert.equal(choose({...base,bitrate:3000000,bps:2000000}).bitrate,750000,'Auto can use less than a manually selected ceiling');
  assert.equal(choose({...base,sourceSupported:false,bps:30000000,encodingRatio:2,current:{id:'720',height:720,bitrate:3000000}}).quality,'480');
});

test('adaptation requires repeated evidence and sustained upgrade headroom', async () => {
  const b = createBrowserDouble(); const { createQualityHysteresis } = await b.load('js/player/quality-policy.js');
  const h = createQualityHysteresis();
  const current = {id:'720',height:720,bitrate:3000000}, low = {id:'360',height:360,bitrate:750000}, high = {id:'1080',height:1080,bitrate:5000000};
  h.reset(1000);
  assert.equal(h.evaluate({now:9000,current,candidate:low}),false);
  assert.equal(h.evaluate({now:11000,current,candidate:low}),true);
  assert.equal(h.evaluate({now:12000,current:low,candidate:high}),false);
  assert.equal(h.evaluate({now:41999,current:low,candidate:high}),false);
  assert.equal(h.evaluate({now:42000,current:low,candidate:high}),true);
});

async function harness({ supported = true, observe = false, role = 'viewer' } = {}) {
  const b = createBrowserDouble(); let clock=1000;
  let resources;
  if(observe)b.context.PerformanceObserver=class{constructor(callback){resources=callback;}observe(){}};
  b.context.performance = {now:()=>clock};
  const { getElements } = await b.load('js/dom.js');
  const { createPlayer } = await b.load('js/player/controller.js');
  const elements = getElements(), video = elements.video;
  const create = b.document.createElement;
  b.document.createElement = tag => { const node=create(tag); if(tag==='video')node.canPlayType=()=>supported?'probably':''; return node; };
  for(const cls of ['movi-quality-list','movi-settings-menu']) { const node=create('div'); node.className=cls; video.shadowRoot.appendChild(node); }
  const state={role,clientId:role,mediaVersion:0}, sent=[], reports=[];
  const player=createPlayer({elements,state,send:m=>{sent.push(m);return true;},report:m=>reports.push(m),files:{setRole(){},chooseVideo(){},chooseCaptions(){}}});
  const snapshot={mediaVersion:1,playbackRevision:1,streamGeneration:0,hasVideo:true,paused:true,time:17,playbackRate:1.25,duration:200,
    originalUrl:'/media/original?v=1',compatibilityUrl:'/hls/master.m3u8?v=1&g=0',captions:[],
    mediaInfo:{mime:'video/mp4',videoCodec:'h264',bitDepth:8,hasAudio:false,width:1920,height:1080,bitrate:10000000,
      qualityOptions:qualityOptions({width:1920,height:1080}),bitrateRange:bitrateRange({width:1920,height:1080,bitrate:10000000})}};
  player.applySessionState(snapshot); await flush();
  const controls=()=>[video.shadowRoot.querySelector('.movi-quality-list').querySelector('select'),
    video.shadowRoot.querySelector('.movi-quality-list').querySelectorAll('input').find(input=>input.type==='range')];
  const change=(quality,bitrate)=>{
    const [q,r]=controls();
    if(quality!==undefined){q.value=quality;q.dispatch('change');}
    if(bitrate!==undefined){r.value=String(bitrate==='source'?r.max:bitrate);r.dispatch('change');}
  };
  const requests=()=>sent.filter(m=>m.type==='compatibility-request');
  const reply=async(values={})=>{
    const request=requests().at(-1), rendition=resolveQuality(snapshot.mediaInfo,request.quality,request.bitrate);
    player.applyCompatibility({...snapshot,type:'compatibility-ready',requestId:request.requestId,rendition,segmentSeconds:2,
      url:`/hls/master.m3u8?v=1&g=0&r=${rendition.id}&rg=0`,...values});
    await flush();await flush();
  };
  return {b,video,state,sent,reports,player,snapshot,change,requests,reply,controls,advance:ms=>clock+=ms,
    resources:entries=>resources({getEntries:()=>entries}),
    source:()=>video.children.find(node=>node.tagName==='source')};
}

test('Settings is lazy; manual changes preserve the room transport and expose both controls', async () => {
  const h=await harness();
  assert.equal(h.requests().length,0); assert.equal(h.b.requests.length,0);
  assert.equal(h.source().src,h.snapshot.originalUrl);
  assert.equal(h.video.settingsRowAvailable('.movi-quality-container'),true);
  const [q,r]=h.controls();assert.equal(q.value,'auto');assert.equal(r.disabled,true);
  h.change('720');assert.equal(h.requests().length,1);assert.equal(h.source().src,h.snapshot.originalUrl,'keep original until rendition is ready');
  await h.reply();
  assert.match(h.source().src,/r=1280x720_3000000/);
  assert.equal(h.video.getAttribute('startat'),'17');
  assert.equal(h.sent.some(m=>m.type==='playback'),false);
  assert.equal(h.sent.some(m=>m.type==='quality-selection'&&m.renditionId==='1280x720_3000000'),true);
  h.change(undefined,1500000);await h.reply();assert.match(h.source().src,/r=1280x720_1500000/);
  h.advance(60000);h.b.runTimers(2000);assert.equal(h.requests().length,2,'manual quality never changes with load');
  h.change('source');assert.equal(h.source().src,h.snapshot.originalUrl);assert.equal(h.controls()[1].disabled,false);
  assert.equal(r.value,r.max);
});

test('busy selections, stale replies, and superseded prefetches cannot replace current playback', async () => {
  const h=await harness();h.change('720');const first=h.requests().at(-1);
  h.player.handleQuality({type:'quality-error',mediaVersion:1,requestId:first.requestId,message:'Server busy'});
  assert.equal(h.source().src,h.snapshot.originalUrl);assert.match(h.reports.at(-1),/busy/);
  h.change('480');const second=h.requests().at(-1);
  h.player.applyCompatibility({...h.snapshot,type:'compatibility-ready',requestId:first.requestId,rendition:resolveQuality(h.snapshot.mediaInfo,'720'),segmentSeconds:2,url:'/obsolete'});
  assert.equal(h.source().src,h.snapshot.originalUrl);
  await h.reply();assert.notEqual(first.requestId,second.requestId);assert.match(h.source().src,/r=854x480_1500000/);
  const before=h.source().src;h.change('360');h.b.runTimers(10000);
  assert.equal(h.source().src,before,'a timed-out choice preserves working playback');
});

test('segment capacity failures preserve current playback and report server busy for bootstrap and current fragments', async () => {
  for (const time of [0, 17]) {
    const h = await harness();
    const previous = h.source().src;
    h.b.context.fetch = async () => ({ ok: false, status: 503,
      json: async () => ({ code: 'QUALITY_BUSY', error: 'The server is busy encoding another quality. Keep the current quality or try Auto again shortly.' }) });
    h.change('720'); await h.reply({ time });
    assert.equal(h.source().src, previous);
    assert.match(h.reports.at(-1), /server is busy encoding another quality/);
    assert.equal(h.video.watchpartyQualityMetrics.pending, null);
    assert.equal(h.video.watchpartyQualityMetrics.preferences.quality, 'auto');
  }
});

test('reset visibility follows pending manual settings and returns to Auto after a rejected selection', async () => {
  const h = await harness(), list = h.video.shadowRoot.querySelector('.movi-quality-list');
  const reset = list.querySelector('button');
  assert.equal(reset.hidden, true);
  h.change('720'); assert.equal(reset.hidden, false);
  h.player.handleQuality({ type: 'quality-error', mediaVersion: 1, requestId: h.requests().at(-1).requestId, message: 'Server busy' });
  assert.equal(reset.hidden, true); assert.equal(h.controls()[0].value, 'auto');
  h.change('source'); assert.equal(reset.hidden, false);
  reset.click(); assert.equal(reset.hidden, true);
});

test('manual Source keeps original playback when supported and falls back to uncapped compatible playback on decoder failure', async () => {
  const h = await harness();
  h.change('source'); assert.equal(h.requests().length, 0); assert.equal(h.source().src, h.snapshot.originalUrl);
  h.state.sourceSwitching = false;
  h.video.dispatch('error', { detail: { message: 'decoder failed' } });
  assert.equal(h.requests().length, 1);
  assert.equal(h.requests()[0].quality, 'source'); assert.equal(h.requests()[0].bitrate, 'source');
  await h.reply();
  assert.match(h.source().src, /r=1920x1080_source/);
  assert.equal(h.video.watchpartyQualityMetrics.preferences.quality, 'source');
  assert.match(h.video.shadowRoot.querySelector('.movi-quality-list').querySelector('p').textContent, /compatible near-lossless/);
  assert.equal(h.sent.some(message => message.type === 'video-state'), false);
});

test('unsupported originals can select Source and retain it across media replacement', async () => {
  const h = await harness({ supported: false });
  h.change('source'); assert.equal(h.requests().at(-1).bitrate, 'source');
  await h.reply();
  assert.equal(h.controls()[0].value, 'source'); assert.equal(h.controls()[1].value, h.controls()[1].max);
  h.player.applySessionState({ ...h.snapshot, mediaVersion: 2 }); await flush();
  assert.equal(h.requests().at(-1).quality, 'source'); assert.equal(h.requests().at(-1).bitrate, 'source');
});

test('unsupported originals request only one initial rendition; source replacement cancels pending work', async () => {
  const h=await harness({supported:false});
  assert.equal(h.requests().length,1);assert.equal(h.requests()[0].quality,'720');assert.equal(h.b.requests.length,0);
  assert.equal(h.controls()[0].children.find(option=>option.value==='source').disabled,false);
  const retired=h.requests()[0];
  h.player.applySessionState({...h.snapshot,mediaVersion:2,processing:true,hasVideo:false});
  h.player.applyCompatibility({...h.snapshot,type:'compatibility-ready',requestId:retired.requestId,rendition:resolveQuality(h.snapshot.mediaInfo,'720'),segmentSeconds:2,url:'/obsolete'});
  await flush();assert.equal(h.b.requests.some(request=>request.url==='/obsolete'),false);
});

test('measured downloads drive automatic downgrades and exclude cached transfers and deliberate server wait', async () => {
  const h=await harness({observe:true});
  h.video.readyState=4;h.b.runTimers(100);h.state.sourceSwitching=false;h.video.paused=false;
  h.video.buffered={length:1,start:()=>0,end:()=>100};
  h.player.applySessionState({...h.snapshot,paused:false});
  h.resources([{name:'http://localhost/media/original?v=1',transferSize:0,encodedBodySize:100000,responseStart:100,responseEnd:500}]);
  assert.equal(h.video.watchpartyQualityMetrics.throughputBps,0);
  h.resources([{name:'http://localhost/media/original?v=1',transferSize:100300,encodedBodySize:100000,startTime:0,responseStart:2000,responseEnd:2400}]);
  h.advance(10000);h.b.runTimers(2000);h.advance(2000);h.b.runTimers(2000);
  assert.equal(h.requests().length,1);assert.equal(h.requests()[0].quality,'360');
  assert.equal(h.video.watchpartyQualityMetrics.throughputBps,2000000,'server wait before response headers is excluded');
});

test('ready state from a retired player cannot complete a quality switch and replacement loading is bounded', async () => {
  const h=await harness();const retired={getVideoElement:()=>({readyState:4,currentTime:17,paused:true})};h.video.player=retired;
  h.change('720');await h.reply();
  h.b.runTimers(100);assert.equal(h.state.sourceSwitching,true,'retired readiness is ignored');
  h.b.runTimers(10000);assert.match(h.reports.at(-1),/could not start playback/);
});

// Model Movi's asynchronous player replacement and transport announcements,
// rather than the already-ready video used by the simpler menu tests above.
async function asynchronousPlayer(h) {
  h.video.readyState = 4; h.b.runTimers(100); await flush();
  let active, plays = 0;
  const replace = (loading = true) => {
    active = h.b.document.createElement('video');
    Object.assign(active, { currentTime: Number(h.video.getAttribute('startat')), paused: true,
      seeking: false, readyState: loading ? 1 : 4 });
    h.video.player = { getHLSVideoElement: () => active };
    // Capture this particular native element so retired events stay retired.
    const native = active;
    h.video.player.getHLSVideoElement = () => native;
    h.video.isLoading = loading;
    return native;
  };
  replace(false);
  Object.defineProperties(h.video, {
    paused: { get: () => active.paused },
    currentTime: { get: () => active.currentTime, set: time => { active.currentTime = time; } },
    readyState: { get: () => active.readyState }
  });
  h.video.play = async () => {
    assert.equal(h.video.isLoading, false, 'resume waits for initialization');
    assert.equal(active.seeking, false, 'resume waits for the replacement seek');
    plays++;
    h.video.dispatch('play'); active.paused = false;
  };
  h.video.pause = () => {
    if (!active.paused) { h.video.dispatch('pause'); active.paused = true; }
  };
  const settle = async () => {
    active.readyState = 4; active.seeking = false; h.video.isLoading = false;
    h.b.runTimers(100); await flush();
  };
  return { replace, settle, current: () => active, plays: () => plays };
}

function seekSnapshot(h, index, time, paused, command) {
  return { ...h.snapshot, time, paused, syncMode: 'seek', streamGeneration: index,
    playbackRevision: index + 1, seekSequence: command.commandSequence, commandClientId: 'host',
    compatibilityUrl: `/hls/master.m3u8?v=1&g=${index}` };
}

for (const count of [3, 5, 10, 20]) for (const direction of ['forward', 'backward', 'alternating']) {
  for (const paused of [false, true]) for (const interleaved of [false, true]) test(`${count} ${direction} seeks ${interleaved ? 'during downloads' : 'in one burst'}, ${paused ? 'paused' : 'playing'}, keep only the final Auto target`, async () => {
    const h = await harness({ supported: false, role: 'host' });
    h.b.context.AbortController = AbortController;
    await h.reply();
    const native = await asynchronousPlayer(h);
    if (!paused) await h.video.play();
    const original = h.source().src, obsolete = [], snapshots = [], replacements = [];
    h.b.context.fetch = (url, options) => {
      if (url.includes('segment_000000.ts')) return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
      return new Promise(resolve => obsolete.push({ url, signal: options.signal, resolve }));
    };
    const rendition = h.video.watchpartyQualityMetrics.rendition;
    for (let i = 1; i <= count; i++) {
      const time = direction === 'forward' ? 20 + i * 5 : direction === 'backward' ? 170 - i * 5 : i % 2 ? 140 : 40;
      native.current().currentTime = time;
      h.video.dispatch('watchparty-seek-intent', { detail: { time } });
      const command = h.sent.filter(m => m.type === 'video-state' && m.syncMode === 'seek').at(-1);
      assert.ok(command);
      const snapshot = seekSnapshot(h, i, time, paused, command);
      const replacement = { type: 'rendition-replaced', mediaVersion: 1, playbackRevision: i + 1,
        streamGeneration: i, renditionGeneration: i, renditionId: rendition.id,
        url: `${snapshot.compatibilityUrl}&r=${rendition.id}&rg=${i}` };
      snapshots.push(snapshot); replacements.push(replacement);
      h.player.handleQuality(replacement);
      h.player.handleQuality(replacement);
      if (interleaved) {
        h.player.applySessionState(snapshot);
        await h.reply({ ...snapshot, renditionGeneration: i, url: replacement.url });
        assert.equal(obsolete.length, i, 'one fragment preparation per acknowledged generation');
      }
    }
    if (!interleaved) {
      for (const snapshot of snapshots) h.player.applySessionState(snapshot);
      assert.equal(h.requests().length, 2, 'intermediate acknowledgements do not launch preparation');
      await h.reply({ ...snapshots.at(-1), renditionGeneration: count, url: replacements.at(-1).url });
    }
    const final = obsolete.pop();
    for (let i = 0; i < obsolete.length; i++) {
      const request = obsolete[i];
      assert.equal(request.signal.aborted, true);
      request.resolve({ ok: i % 2 === 0, arrayBuffer: async () => new ArrayBuffer(1) });
    }
    await flush(); await flush();
    assert.equal(h.source().src, original, 'obsolete successes and failures cannot switch players');
    const before = h.requests().length;
    for (const replacement of replacements) h.player.handleQuality(replacement);
    assert.equal(h.requests().length, before, 'stale and duplicate replacements do not restart preparation');
    final.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
    await flush(); await flush();
    assert.equal(h.source().src, replacements.at(-1).url);
    assert.equal(Number(h.video.getAttribute('startat')), snapshots.at(-1).time);
    native.replace(); await native.settle();
    assert.equal(h.video.currentTime, snapshots.at(-1).time);
    assert.equal(h.video.paused, paused);
    assert.equal(h.video.playbackRate, 1.25);
    assert.equal(h.state.sourceSwitching, false);
    assert.equal(h.video.watchpartyQualityMetrics.preferences.quality, 'auto');
    h.b.runTimers(100);
    h.b.runTimers(10000);
    assert.deepEqual(h.reports, []);
  });
}

test('a superseded fragment body cannot commit and a current failure still surfaces', async () => {
  const h = await harness({ supported: false, role: 'host' });
  h.b.context.AbortController = AbortController;
  await h.reply(); const native = await asynchronousPlayer(h);
  let finishBody, signal;
  h.change('480');
  h.b.context.fetch = async (url, options) => url.includes('segment_000000.ts') ?
    { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } :
    { ok: true, arrayBuffer: () => { signal = options.signal; return new Promise(resolve => { finishBody = resolve; }); } };
  await h.reply();
  h.video.dispatch('watchparty-seek-intent', { detail: { time: 0 } });
  assert.equal(signal.aborted, true);
  const command = h.sent.filter(m => m.syncMode === 'seek').at(-1);
  h.player.applySessionState(seekSnapshot(h, 1, 0, true, command));
  finishBody(new ArrayBuffer(1)); await flush();
  assert.doesNotMatch(h.source().src, /854x480/);
  h.b.context.fetch = async () => ({ ok: false });
  await h.reply({ time: 0, playbackRevision: 2, streamGeneration: 1 });
  assert.match(h.reports.at(-1), /could not initialize|unavailable/);
  assert.equal(native.current().paused, true);
});

for (const target of [0, 200]) test(`20 remote seeks retain manual quality and can finish preparation at ${target}`, async () => {
  const h = await harness({ supported: false, role: 'host' });
  h.change('480'); await h.reply();
  const native = await asynchronousPlayer(h);
  const retired = native.current();
  for (let i = 1; i <= 20; i++) {
    const time = i === 20 ? target : i % 2 ? 150 : 30;
    const snapshot = { ...seekSnapshot(h, i, time, true, { commandSequence: i }), commandClientId: 'another-host' };
    h.player.applySessionState(snapshot);
  }
  const request = h.requests().at(-1);
  assert.equal(request.quality, '480');
  await h.reply({ time: target, playbackRevision: 21, streamGeneration: 20,
    url: '/hls/master.m3u8?v=1&g=20&r=854x480_1500000&rg=20' });
  assert.equal(h.video.getAttribute('startat'), String(target));
  assert.ok(h.b.requests.some(r => r.url.includes(target === 0 ? 'segment_000000.ts?v=1&g=20' : 'segment_000099.ts?v=1&g=20')));
  assert.equal(h.b.requests.some(r => r.url.includes('segment_000100.ts')), false);
  native.replace(); retired.dispatch('canplay');
  assert.equal(h.state.sourceSwitching, true);
  await native.settle(); h.b.runTimers(100); h.b.runTimers(10000);
  assert.equal(h.video.currentTime, target);
  assert.equal(h.video.watchpartyQualityMetrics.preferences.quality, '480');
  assert.deepEqual(h.reports, []);
});

test('a rejected seek resumes preparation against the correction snapshot', async () => {
  const h = await harness({ supported: false, role: 'host' });
  await h.reply(); await asynchronousPlayer(h);
  h.video.dispatch('watchparty-seek-intent', { detail: { time: 50 } });
  const command = h.sent.filter(m => m.syncMode === 'seek').at(-1);
  h.player.rejectPlayback({ commandSequence: command.commandSequence, state: { ...h.snapshot, syncMode: 'correction' } });
  assert.equal(h.requests().length, 2);
  await h.reply();
  assert.equal(h.video.getAttribute('startat'), '17');
  assert.deepEqual(h.reports, []);
});

test('host quality and bitrate switches preserve unacknowledged local play/pause and the actual playhead', async () => {
  const h = await harness({ role: 'host' }), native = await asynchronousPlayer(h);
  await h.video.play(); native.current().currentTime = 32;
  h.change('720');
  assert.equal(h.video.paused, false, 'preparation keeps the current player running');
  await h.reply();
  assert.equal(h.video.getAttribute('startat'), '32', 'use the host clock instead of the old paused snapshot');
  const retired = native.current(), playing = native.replace();
  retired.dispatch('canplay'); h.b.runTimers(100); await flush();
  assert.equal(h.video.paused, true, 'metadata alone cannot resume a loading player');
  playing.readyState = 4; playing.seeking = true; h.b.runTimers(100); await flush();
  assert.equal(h.state.suppressVideoEvents, true);
  await native.settle();
  assert.equal(h.video.paused, false);
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.state.sourceSwitching, false);
  assert.deepEqual(h.sent.filter(m => m.type === 'video-state').map(m => m.syncMode), ['play']);

  h.video.pause();
  h.change(undefined, 1500000); await h.reply(); native.replace(); await native.settle();
  assert.equal(h.video.paused, true, 'a paused quality switch remains paused');
  await h.video.play(); native.current().currentTime = 44;
  h.change('source'); native.replace(); await native.settle();
  assert.equal(h.video.paused, false, 'returning to Original resumes too');
  assert.equal(h.video.currentTime, 44);
  assert.deepEqual(h.sent.filter(m => m.type === 'video-state').map(m => m.syncMode), ['play', 'pause', 'play']);
});

test('automatic viewer downgrade resumes and a newer room pause overrides replacement playback', async () => {
  const h = await harness({ observe: true }), native = await asynchronousPlayer(h);
  h.player.applySessionState({ ...h.snapshot, paused: false, syncMode: 'play' }); await flush();
  native.current().buffered = { length: 1, start: () => 0, end: () => 100 };
  h.resources([{name:'http://localhost/media/original?v=1',transferSize:100300,encodedBodySize:100000,responseStart:2000,responseEnd:2400}]);
  h.advance(10000); h.b.runTimers(2000); h.advance(2000); h.b.runTimers(2000);
  assert.equal(h.requests().at(-1).quality, '360');
  assert.equal(h.video.paused, false);
  await h.reply(); native.replace(); await native.settle();
  assert.equal(h.video.paused, false);
  h.change('720'); await h.reply(); native.replace();
  h.player.applySessionState({ ...h.snapshot, paused: true, time: 48, syncMode: 'pause' });
  await native.settle();
  assert.equal(h.video.paused, true);
  assert.equal(h.video.currentTime, 48);
  assert.equal(h.sent.some(m => m.type === 'video-state'), false, 'replacement transport stays local');
});


const qualityNotice = h => h.video.overlays.get('watchparty-playback-status')?.content.querySelector('.watchparty-quality-status-text')?.textContent;
function measureSlowConnection(h) {
  h.resources([{name:'http://localhost/media/original?v=1', transferSize:100300, encodedBodySize:100000, responseStart:2000, responseEnd:2400}]);
}
async function automaticDowngrade(h) {
  h.video.readyState=4; h.b.runTimers(100); h.state.sourceSwitching=false; h.video.paused=false;
  h.video.buffered={length:1,start:()=>0,end:()=>100};
  h.player.applySessionState({...h.snapshot,paused:false});
  measureSlowConnection(h);
  h.advance(10000); h.b.runTimers(2000); h.advance(2000); h.b.runTimers(2000);
}

test('initial Auto assessment uses actual transfers, expires without samples, and does not restart on telemetry', async () => {
  const h=await harness({observe:true});
  assert.equal(qualityNotice(h), 'Checking connection speed...');
  h.resources([{name:'http://localhost/media/original?v=1',transferSize:0,encodedBodySize:100000,responseStart:0,responseEnd:500}]);
  assert.equal(qualityNotice(h), 'Checking connection speed...');
  measureSlowConnection(h); assert.equal(qualityNotice(h), 'Connection speed checked');
  h.b.runTimers(3000); assert.equal(qualityNotice(h),undefined);
  h.b.runTimers(2000); assert.equal(qualityNotice(h),undefined);
  const noSample=await harness(); noSample.video.readyState=4; noSample.b.runTimers(100); noSample.state.sourceSwitching=false; noSample.b.runTimers(2000); noSample.b.runTimers(10000);
  assert.equal(qualityNotice(noSample),'Connection estimate unavailable; continuing with Auto');
  noSample.b.runTimers(3000); noSample.b.runTimers(2000);
  assert.equal(qualityNotice(noSample),undefined);
});

test('automatic quality progress waits for the replacement player, then dismisses the selected resolution', async () => {
  const h=await harness({observe:true});
  await automaticDowngrade(h);
  assert.equal(qualityNotice(h),'Adjusting quality...');
  const retired={getVideoElement:()=>({readyState:4,currentTime:17,paused:true})};h.video.player=retired;
  await h.reply(); h.b.runTimers(100);
  assert.equal(qualityNotice(h),'Adjusting quality...','a retired player cannot finish the indicator');
  const native=h.b.document.createElement('video'); Object.assign(native,{readyState:4,currentTime:17,paused:true,playbackRate:1.25});
  h.video.player={getHLSVideoElement:()=>native};
  h.b.runTimers(100); await flush(); h.b.runTimers(2000);
  assert.equal(qualityNotice(h),'Using 360p quality');
  h.b.runTimers(3000); assert.equal(qualityNotice(h),undefined);
});

test('manual quality and bitrate changes, ordinary seeks, resets and disconnects do not leave Auto notices', async () => {
  const h=await harness({observe:true});
  h.change(undefined,2000000); assert.equal(qualityNotice(h),undefined,'manual bitrate with Auto quality stays in Settings');
  h.change('720'); assert.equal(qualityNotice(h),undefined);
  h.player.handleQuality({type:'quality-error',mediaVersion:1,requestId:h.requests().at(-1).requestId,message:'Server busy'});
  assert.equal(qualityNotice(h),undefined);
  const auto=await harness({observe:true});
  await automaticDowngrade(auto); const stale=auto.requests().at(-1);
  auto.player.disconnect(); assert.equal(qualityNotice(auto),undefined);
  auto.player.applyCompatibility({...auto.snapshot,type:'compatibility-ready',requestId:stale.requestId,rendition:resolveQuality(auto.snapshot.mediaInfo,'360'),segmentSeconds:2,url:'/obsolete'});
  auto.b.runTimers(10000); assert.equal(qualityNotice(auto),undefined);
  const seek=await harness({supported:false}); await seek.reply();
  seek.video.readyState=4;seek.b.runTimers(100);seek.b.runTimers(10000);seek.b.runTimers(3000);
  seek.player.applySessionState({...seek.snapshot,time:70,playbackRevision:2,streamGeneration:1,syncMode:'seek'});
  assert.equal(qualityNotice(seek),undefined,'following a shared seek does not restart quality notices');
});

test('automatic failures briefly replace progress and source replacement cancels all pending quality notices', async () => {
  const h=await harness({observe:true}); await automaticDowngrade(h);
  h.player.handleQuality({type:'quality-error',mediaVersion:1,requestId:h.requests().at(-1).requestId,message:'Server busy'});
  assert.equal(qualityNotice(h),'Server busy'); h.b.runTimers(3000); assert.equal(qualityNotice(h),undefined);
  h.player.applySessionState({...h.snapshot,mediaVersion:2,processing:true,hasVideo:false});
  h.b.runTimers(10000); assert.equal(qualityNotice(h),undefined);
});


test('initial Auto preparation errors replace the assessment timeout while manual bitrate failures stay in Settings', async () => {
  const auto=await harness({supported:false});
  auto.b.runTimers(10000);
  assert.match(qualityNotice(auto),/could not be prepared/);
  auto.b.runTimers(3000); assert.equal(qualityNotice(auto),undefined);
  const manual=await harness();manual.change(undefined,2000000);
  manual.b.runTimers(10000);assert.equal(qualityNotice(manual),undefined);
});
