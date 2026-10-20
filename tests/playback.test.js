const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDouble, captionItems, selectedCaption, pickCaption } = require('./helpers/browser');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

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
