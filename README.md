# WatchParty

A browser-hosted watch party with synchronized playback, chat, private rooms, reactions, and next-video voting.

## Run

Requires Node.js 18+. Install dependencies and start the server:

```sh
npm install
npm start
```

Open `http://localhost:3000`. The server installs FFmpeg automatically; hosts and viewers only need a browser. `FFMPEG_PATH` may point to an existing executable. Use [trusted HTTPS](docs/https.md) for LAN and public access to enable WebCodecs on viewers' devices. HTTP still supports native files and compatibility streaming.

The host selects one video and optional SRT, VTT, ASS, or SSA files. Keep that browser page open: its File objects answer bounded byte requests, with no initial full-file upload. Refreshing, disconnecting, or mobile suspension interrupts hosting. The next host selects a file from their own device.

The root page is a public default room. Private-room Create/Join screens are still deferred; use the [room API](docs/rooms.md), then navigate to the returned `watchPath`.

Next-video suggestions search Wikipedia through its keyless MediaWiki API. Choose the matching article to include its thumbnail and attribution link in the shared vote; if search is unavailable or there is no match, you can still suggest the title without a poster. Suggesting automatically casts your vote, and only the person who first suggested a title can remove it. Posters are served by Wikimedia, so image availability and licensing depend on each source image. See the [movie search API](docs/rooms.md#movie-suggestions-and-posters).

## Playback

- Each device independently chooses original-file playback or compatibility streaming. Supported MP4/WebM sources use native decoding; other suitable sources use Movi's WASM demuxer and WebCodecs. Original-file playback preserves source resolution.
- Native capability checks include audio as well as video. Unusual audio, unsupported devices, demanding decoding, runtime decoder errors, and sustained stalls use server compatibility streaming. A source with no audio is handled separately from an audio decoding failure.
- Compatibility output uses H.264, 8-bit YUV420, and stereo 48 kHz AAC, capped at 30 fps. It fits within 1920×1080, preserves aspect ratio, and never upscales. HDR sources are tone mapped to SDR.
- The server publishes the full seekable timeline after probing metadata, without waiting for encoder detection or caption extraction.
- Compatibility segments use a fixed frame count near two seconds. One continuous encoder shares completed segments across the room, retaining AAC state across boundaries and pauses. A private loopback upload sink grants permission before each segment body, bounding production to the shared playhead plus two segments while playing and the target while paused. A paused seek near a segment end may also decode the next fragment; preceding preroll and fragment zero support HLS initialization. Seeks replace the stream generation and discard retired files; hls.js loading is suspended during a pause.
- Host seeks are acknowledged with a new playback revision. Old ticks and HLS recovery seeks cannot reset the room clock. Compatibility clients reload the acknowledged generation while preserving pause, speed, and caption selection.
- Direct streams reuse a bounded 16 MiB byte cache and share concurrent reads. HTTP backpressure, cancelled requests, stale source generations, and room membership apply to original bytes as well as generated media.
- Playback-path switches are local to a viewer and preserve the shared timestamp, pause state, speed, and caption choice. They do not replace the room's source or send synthetic play/pause actions.

FFmpeg/HLS remain the compatibility path because browser decoding alone cannot reliably cover every video/audio codec on every phone. The server attempts available hardware encoders, remembers failures for the current source, and falls back to libx264. Conversion uses software decoding so scaling and HDR filters work consistently across encoders.

## Captions and controls

The **Captions** button and context-menu row inside Movi select room captions, including Off. Each viewer chooses independently. The host can add captions during playback or remove their selected track for the room; additions preserve existing selections and removing a selected track switches it to Off.

JASSUB is retained as a libass renderer behind Movi's public renderer/overlay APIs. ASS/SSA styles, positioned signs, karaoke, and embedded font attachments are preserved. Other supported text formats are normalized to ASS. Bitmap subtitles remain unsupported in this version. Selected caption content is cached per browser/source; extraction and font loading never gate the first video frame. Caption errors leave playback available.

Native/HLS engines use the adapter's clock bridge because Movi's embedded renderer hook only runs on its WASM pipeline. The caption canvas lives inside the player, including fullscreen. Native video Picture-in-Picture cannot include this separate subtitle surface; Document PiP support depends on the browser/player.

Viewers may pause/resume the shared room; seeking, speed, and video selection remain host-only. Volume, aspect ratio, captions, and fullscreen are local. Browsers may require a tap to enable sound or playback.

## Chat and reactions

Use the emoji button in chat to insert at the cursor, or the plus button below a comment to react. Selecting your current reaction removes it; selecting another replaces it. Reaction counts and names are shared within the room. The picker closes on selection, Escape, an outside click, or another click on its button.

Chat retains the latest 500 comments per browser; the server retains reaction targets for the latest 500 room comments. There is no chat history replay or persistence. Floating reactions are capped at 30 and respect reduced-motion preferences. Next-video suggestions and voting remain shared within the room.

## Performance and verification

The performance targets are a first playable frame within **3 seconds** of selection and an uncached seek within **2 seconds**, with capable hardware, indexed files, and enough network throughput. These are measured targets, not guarantees for arbitrary codecs, slow uploads, long GOPs, unindexed containers, or CPU-only 4K conversion.

In DevTools, inspect `document.getElementById('video').watchpartyMetrics` for first-picture, seek, and fallback timings. First-picture timing includes source preparation after registration; the file-picker interaction is excluded. Measure cold page/asset loading separately. Browser autoplay denial must not be classified as codec failure.

```sh
npm test
```

Tests cover room admission/isolation, range validation/cancellation/deduplication, stale generations, fast readiness independent of captions/encoder detection, local fallback negotiation, bounded continuous encoding, AAC timestamps and decoded audio across pause/resume, HEVC Main 10/E-AC-3 conversion, downscaling, encoder failure, seek acknowledgements, caption lifecycle, chat, voting, and proxy trust. Media tests create temporary fixtures and skip if FFmpeg is unavailable. DOM doubles test wiring, not visual decoding.

For release testing, use real desktop Chrome/Edge/Firefox/Safari, Android Chrome, and iPhone/iPad Safari. Check visible motion and audible audio for H.264/AAC MP4, HEVC MKV, VP9/AV1, multichannel/unusual audio, 4K/HDR conversion, and styled ASS. Test cold/warm startup, uncached seeks, fullscreen captions, autoplay gestures, and mixed direct/compatibility viewers in one room.

## Structure and dependencies

`server.js` and `js/app.js` compose the application. Server media modules handle probing, lazy caption extraction, compatibility playlists and continuous encoding runs; `server/source-relay.js` owns browser files and authenticated range serving. Player modules handle source selection, synchronization, Movi controls, and the JASSUB adapter.

Third-party distributions are bundled locally; replace generated distributions as a unit rather than editing them. Movi Player **0.4.1** (slim JS/WASM) is covered by `vendor/MOVI_PLAYER_LICENSE.txt`; JASSUB **2.5.16** and its worker/WASM assets are covered by `vendor/jassub/LICENSE.txt`.

The hls.js pause/resume bridge uses Movi 0.4.1's internal stream-wrapper loader because Movi has no public adaptive-loader pause API. This dependency is isolated in `js/player/compatibility-buffer.js`; verify its integration when upgrading Movi.
