const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble } = require('./helpers/browser');
const { qualityOptions, resolveQuality } = require('../server/media/quality');
const { createEncoderBudget } = require('../server/media/encoder-budget');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('finite quality profiles preserve aspect ratio, never upscale, and reject unbounded values', () => {
  const info = { width: 1920, height: 1080 };
  assert.deepEqual(qualityOptions(info).map(option => option.quality), ['1080','720','480','360']);
  assert.deepEqual(resolveQuality(info, '720', 1500000), { quality:'720',width:1280,height:720,bitrate:1500000,id:'1280x720_1500000' });
  assert.equal(resolveQuality(info, 'auto').quality, '720');
  assert.deepEqual(qualityOptions({width:320,height:180})[0], {quality:'180',width:320,height:180,bitrate:750000});
  assert.equal(qualityOptions({width:640,height:480})[0].quality,'480','4:3 sources retain their supported height');
  assert.equal(qualityOptions({width:1080,height:1920})[0].quality,'1080','portrait sources retain their supported height');
  for (const [quality, bitrate] of [['2160','auto'],['720',1],['720','3000000'],['../720','auto'],[{},'auto']])
    assert.throws(() => resolveQuality(info,quality,bitrate));
  const wide = qualityOptions({width:1920,height:800});
  assert.ok(wide.every(option => option.width <= 1920 && option.height <= 800));
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

async function harness({ supported = true, observe = false } = {}) {
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
  const state={role:'viewer',clientId:'viewer',mediaVersion:0}, sent=[], reports=[];
  const player=createPlayer({elements,state,send:m=>{sent.push(m);return true;},report:m=>reports.push(m),files:{setRole(){},chooseVideo(){},chooseCaptions(){}}});
  const snapshot={mediaVersion:1,playbackRevision:1,streamGeneration:0,hasVideo:true,paused:true,time:17,playbackRate:1.25,duration:200,
    originalUrl:'/media/original?v=1',compatibilityUrl:'/hls/master.m3u8?v=1&g=0',captions:[],
    mediaInfo:{mime:'video/mp4',videoCodec:'h264',bitDepth:8,hasAudio:false,width:1920,height:1080,bitrate:10000000,
      qualityOptions:qualityOptions({width:1920,height:1080}),bitrateLimits:[8000000,5000000,3000000,1500000,750000]}};
  player.applySessionState(snapshot); await flush();
  const controls=()=>video.shadowRoot.querySelector('.movi-quality-list').querySelectorAll('select');
  const change=(quality,bitrate)=>{
    const [q,r]=controls();
    if(quality!==undefined){q.value=quality;q.dispatch('change');}
    if(bitrate!==undefined){r.value=String(bitrate);r.dispatch('change');}
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
  const [q,r]=h.controls();assert.equal(q.value,'auto');assert.equal(r.value,'auto');
  h.change('720');assert.equal(h.requests().length,1);assert.equal(h.source().src,h.snapshot.originalUrl,'keep original until rendition is ready');
  await h.reply();
  assert.match(h.source().src,/r=1280x720_3000000/);
  assert.equal(h.video.getAttribute('startat'),'17');
  assert.equal(h.sent.some(m=>m.type==='playback'),false);
  assert.equal(h.sent.some(m=>m.type==='quality-selection'&&m.renditionId==='1280x720_3000000'),true);
  h.change(undefined,1500000);await h.reply();assert.match(h.source().src,/r=1280x720_1500000/);
  h.advance(60000);h.b.runTimers(2000);assert.equal(h.requests().length,2,'manual quality never changes with load');
  h.change('source');assert.equal(h.source().src,h.snapshot.originalUrl);assert.equal(h.controls()[1].disabled,true);
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

test('unsupported originals request only one initial rendition; source replacement cancels pending work', async () => {
  const h=await harness({supported:false});
  assert.equal(h.requests().length,1);assert.equal(h.requests()[0].quality,'720');assert.equal(h.b.requests.length,0);
  assert.equal(h.controls()[0].children.find(option=>option.value==='source').disabled,true);
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
