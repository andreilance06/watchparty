# WatchParty

A local-network watch party that generates shared video segments on demand and gives every browser the same synchronized HLS timeline.

## Features

- Host-only native video picker
- Shared on-demand H.264/AAC segments instead of FFmpeg-WASM work in every browser
- Automatic NVIDIA NVENC, Intel Quick Sync, AMD AMF, or Apple VideoToolbox acceleration with CPU fallback
- The full seekable timeline appears immediately; four-second segments are encoded only when requested
- Original-resolution, high-quality segment cache removed when the session ends or a new video is selected
- MP4, MKV, WebM, MOV, AVI, MPEG-TS, HEVC, VP9, AV1, and other FFmpeg-readable sources
- Pre-extracted ASS tracks for embedded subtitle streams plus matching `.srt`, `.vtt`, `.ass`, and `.ssa` sidecars
- JASSUB/libass WebGL subtitle rendering with a caption selector available to both host and viewers
- Movi Player controls, including volume, aspect ratio, and fullscreen
- Shared play/pause controls; host-only seeking, speed, looping, and Picture-in-Picture controls
- Two-second WebSocket clock updates with gentle drift correction for viewers
- Live chat and automatic host handoff
- LAN and Tailscale access

## Requirements

- Node.js 18+
- Chrome/Edge 110+, Firefox 130+, or Safari 18+

FFmpeg is installed automatically as a platform-specific npm dependency. If necessary, set `FFMPEG_PATH` to an existing FFmpeg executable.

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3000`. Other devices can use `http://YOUR-COMPUTER-IP:3000` on the same LAN, or the computer's Tailscale IPv4/MagicDNS address. Allow Node.js through the firewall if Windows asks.

## Project organization

`js/app.js` and `server.js` only assemble modules and start the application. Feature modules receive their dependencies explicitly; importing a server module does not start a listener or launch a file picker. The latest saved archive's player and subtitle implementation is preserved by this refactor.

| Location | Responsibility |
| --- | --- |
| `js/app.js` | Frontend composition and server-message routing |
| `js/dom.js`, `js/state.js`, `js/utils/client-id.js` | DOM references, per-browser session state, and client identity |
| `js/connection.js` | WebSocket transport and reconnection |
| `js/chat.js` | Chat rendering, display names, and forms |
| `js/player/controller.js` | Source selection, role-based controls, player events, and file-picker request |
| `js/player/sync.js` | Shared playback state and drift correction |
| `js/player/subtitles.js` | Caption selection, rendering, and resize handling |
| `js/player/fullscreen.js` | Fullscreen and mobile fallback behavior |
| `server/application.js` | Backend composition, listener startup, and shutdown |
| `server/config.js`, `server/state.js` | Runtime configuration and shared session/clock state |
| `server/encoders.js`, `server/file-picker.js` | GPU encoder detection/fallback and native file picker |
| `server/realtime.js`, `server/transport.js`, `server/messages.js`, `server/names.js` | WebSocket lifecycle, broadcasting, message permissions, and unique names |
| `server/http/` | Request routing, static assets, and HLS/caption file responses |
| `server/media/` | Probing, caption extraction, playlists, segment jobs, and temporary-file cleanup |
| `css/` | Ordered entry stylesheet plus base, layout, player, chat, and responsive styles |
| `tests/` | Unit tests, frontend wiring tests, and HTTP/WebSocket/FFmpeg regression tests |

The third-party files in `vendor/` remain bundled and unchanged. Do not split or edit those generated bundles when changing application features.

## Tests

After `npm install`, run:

```bash
npm test
```

Tests cover host/viewer permissions, duplicate names, chat, host handoff, frontend module loading, fullscreen wiring, caption delivery, cancellation, seeking, and segment caching. The media integration test creates a tiny temporary video and uses FFmpeg; it skips if the executable is unavailable. Frontend tests use DOM/player doubles to exercise module wiring, not to certify browser decoding or visual subtitle output. The VM-modules experimental warning is expected for these tests.

## How playback works

1. The first connected browser becomes the host and chooses a local file.
2. The original stays in place; it is never uploaded or copied into the project.
3. Node probes and extracts captions first, then publishes a complete VOD playlist before encoding the video. Original ASS/SSA files are copied unchanged; other text formats are converted to ASS for JASSUB.
4. Movi/HLS requests only the four-second segments around the shared playback position. Requests from every browser share the same cached segment.
5. Each uncached request launches FFmpeg with `-ss` at that source timestamp. Seeking halfway through a new file therefore starts encoding halfway through it.
6. Pausing kills active video encoders and blocks requests outside the paused segment. Playing resumes on-demand generation with at most two segments of read-ahead.
7. Host actions and clock heartbeats synchronize every player against the same full-duration timeline.
8. The temporary HLS files are removed on the next selection, when the host session ends, or when the server exits normally.

The quality preset uses CQ/CRF 18 and retains the source resolution, with a 25 Mbps safety ceiling. NVIDIA systems try CUDA decoding with `h264_nvenc`; Intel uses QSV, AMD uses D3D11VA with `h264_amf`, and Apple uses VideoToolbox. If a GPU cannot decode a particular source codec, WatchParty retains hardware encoding with software decoding before falling back to libx264. H.264 output remains broadly playable in Firefox, Chrome, and Safari.

Viewers use the same stream, decoding path, and caption list as the host. Each browser can independently choose or disable captions through the selector below the player. Viewer volume, aspect-ratio, and fullscreen controls remain available, but playback-changing controls are hidden. On browsers that block autoplay with sound, tapping fullscreen once supplies the required user gesture and retries playback.

## Tradeoffs

- The first video and audio streams are included; detected embedded and matching sidecar subtitle tracks appear in WatchParty's JASSUB caption selector.
- ASS/SSA styling is preserved. SRT and WebVTT must be converted to ASS because JASSUB is a libass renderer. Bitmap formats such as PGS are skipped.
- Fullscreen targets the complete video shell so Movi Player and the JASSUB surface stay together. Its transparent Canvas2D compositor avoids opaque-black subtitle layers on mobile browsers; video encoding still uses the selected GPU encoder.
- Each participant can choose a chat display name. It updates without reconnecting and is remembered by that browser.
- Display names are unique while connected (case-insensitive, first come first served). A rejected duplicate reverts to the participant's current name.
- The chat panel has a responsive fixed height; its message history scrolls independently and automatically follows new messages.
- Phone and tablet layouts explicitly stack the full-width player above the chat; the two-column layout begins only on wider desktop screens.
- Viewers may pause or resume the shared playback. Seeking, playback speed, and video selection remain host-only.
- Subtitle layout is updated only on actual resizes, while JASSUB rendering is capped at 20 FPS on smaller screens and 30 FPS on desktop so playback cannot starve the interface.
- Seeking is immediate at four-second granularity and restarts FFmpeg from the requested source position.
- Caption conversion completes before Movi receives the video source; video encoding stops while playback is paused.
- The server sends one high-quality stream to each viewer, so original-resolution video can use substantially more bandwidth than the earlier 720p mode.
- Movi Player 0.4.0 is bundled locally under the Apache-2.0 license in `vendor/MOVI_PLAYER_LICENSE.txt`.
- JASSUB 2.5.16 and its local worker/WASM assets are bundled under the licenses in `vendor/jassub/LICENSE.txt`.

## Concepts demonstrated

- Semantic HTML and responsive CSS Grid/Flexbox
- Custom media element plus a synchronized JASSUB WebGL subtitle canvas
- Node HTTP static/HLS serving
- Child-process media conversion
- WebSocket presence, chat, host actions, and drift correction
- DOM events, native file selection, and fullscreen APIs
