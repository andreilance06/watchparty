# WatchParty

A local-network watch party that generates shared video segments on demand and gives every browser the same synchronized HLS timeline.

## Features

- Independent watch rooms with access codes and optional passwords (backend APIs; Create/Join screens are deferred)
- Host-only browser video picker with on-demand file-range sharing; no host installation or full-file upload
- Shared on-demand H.264/AAC segments instead of FFmpeg-WASM work in every browser
- Automatic NVIDIA NVENC, Intel Quick Sync, AMD AMF, or Apple VideoToolbox acceleration with CPU fallback
- The full seekable timeline appears immediately; four-second segments are encoded only when requested
- Original-resolution, high-quality segment cache removed when the session ends or a new video is selected
- MP4, MKV, WebM, MOV, AVI, MPEG-TS, HEVC, VP9, AV1, and other FFmpeg-readable sources
- Embedded subtitles and explicitly selected `.srt`, `.vtt`, `.ass`, and `.ssa` sidecars
- Host caption additions/removals during playback, preserving each viewer's selection
- JASSUB/libass WebGL subtitle rendering with a caption selector available to both host and viewers
- Movi Player controls, including volume, aspect ratio, and fullscreen
- Shared play/pause controls; host-only seeking, speed, looping, and Picture-in-Picture controls
- Two-second WebSocket clock updates with gentle drift correction for viewers
- Live chat and automatic host handoff
- Live connected-participant list and emoji reactions
- Shared next-video title suggestions with one replaceable vote per participant
- Light/dark theme toggle remembered by each browser
- LAN and Tailscale access

## Requirements

- Node.js 18+
- Chrome/Edge 110+, Firefox 130+, or Safari 18+

Only the server needs Node.js and FFmpeg; room hosts and viewers use their browsers. FFmpeg is installed automatically as a platform-specific npm dependency. If necessary, set `FFMPEG_PATH` to an existing FFmpeg executable.

## Run it

```bash
npm install
npm start
```

Open `http://localhost:3000`. Other devices can use `http://YOUR-COMPUTER-IP:3000` on the same LAN, or the computer's Tailscale IPv4/MagicDNS address. Allow Node.js through the firewall if Windows asks.

The root page retains the default shared room. Private-room creation/joining is available through the [room API](docs/rooms.md); after admission, open the returned `watchPath`. Invitation codes and paths are ready for the later Create/Join screens.

The host selects files on their own device and must keep that page open. Closing/reloading the page or browser suspension can interrupt sharing. A new host must select a file from their own device. Use **Add captions** to select subtitle files during playback; choose a track in the caption selector and use **Remove selected caption** to remove it for the room.

## Project organization

`js/app.js` and `server.js` only assemble modules and start the application. Feature modules receive their dependencies explicitly; importing a server module does not start a listener or launch a file picker. The latest saved archive's player and subtitle implementation is preserved by this refactor.

| Location | Responsibility |
| --- | --- |
| `js/app.js` | Frontend composition and server-message routing |
| `js/dom.js`, `js/state.js`, `js/utils/client-id.js` | DOM references, per-browser session state, and client identity |
| `js/connection.js` | WebSocket transport and reconnection |
| `js/chat.js` | Chat rendering, display names, and forms |
| `js/party.js` | Participant list and emoji reactions |
| `js/voting.js`, `js/theme.js` | Next-video suggestions/votes and per-browser theme preference |
| `js/player/controller.js`, `js/host-files.js` | Role-based player controls, browser file selection, and file-range relay |
| `js/player/sync.js` | Shared playback state and drift correction |
| `js/player/subtitles.js` | Caption selection, rendering, and resize handling |
| `js/player/fullscreen.js` | Fullscreen and mobile fallback behavior |
| `server/application.js` | Backend composition, listener startup, and shutdown |
| `server/config.js`, `server/state.js` | Runtime configuration and shared session/clock state |
| `server/encoders.js` | GPU encoder detection/fallback |
| `server/rooms.js`, `server/source-relay.js` | Room membership/lifecycle, browser byte requests, and private FFmpeg bridge |
| `server/realtime.js`, `server/transport.js`, `server/messages.js`, `server/names.js` | WebSocket lifecycle, participant updates, reactions, voting, message permissions, and unique names |
| `server/http/` | Request routing, static assets, and HLS/caption file responses |
| `server/media/` | Probing, caption extraction, playlists, segment jobs, and temporary-file cleanup |
| `css/` | Ordered entry stylesheet plus base, layout, player, chat, voting, and responsive styles |
| `tests/` | Unit tests, frontend wiring tests, and HTTP/WebSocket/FFmpeg regression tests |

The third-party files in `vendor/` remain bundled and unchanged. Do not split or edit those generated bundles when changing application features.

## Tests

After `npm install`, run:

```bash
npm test
```

Tests cover room admission/passwords, credential and broadcast isolation, expiry, reconnects, bounded file ranges, host/viewer permissions, names, chat, reactions, voting, themes, fullscreen, live caption edits, cancellation, seeking, and segment caching. Media integration tests create tiny temporary videos and use FFmpeg; they skip if the executable is unavailable. Frontend tests use DOM/player doubles to exercise module wiring, not to certify browser decoding or visual subtitle output. The VM-modules experimental warning is expected for these tests.

## How playback works

1. The creator hosts a private room; the first connected browser hosts the default room. The host chooses a video and optional captions through their browser.
2. The browser keeps the selected file objects and responds to bounded byte-range requests on a separate WebSocket. A loopback-only HTTP bridge lets server-side FFmpeg probe and seek those ranges. The original file is not staged on the server; requested bytes do pass through it, potentially including the whole file over time.
3. Node probes and extracts captions first, then publishes a complete VOD playlist before encoding the video. ASS/SSA styling is preserved; other text formats are converted to ASS for JASSUB.
4. Movi/HLS requests only the four-second segments around the shared playback position. Requests from browsers in the same room share its cached segment.
5. Each uncached request launches FFmpeg with `-ss` at that source timestamp. Seeking halfway through a new file therefore starts encoding halfway through it.
6. Pausing kills active video encoders and blocks requests outside the paused segment. Playing resumes on-demand generation with at most two segments of read-ahead.
7. Host actions and clock heartbeats synchronize every player against the same full-duration timeline.
8. The temporary HLS files are removed on the next selection, when the host session ends, or when the server exits normally.

The quality preset uses CQ/CRF 18 and retains the source resolution, with a 25 Mbps safety ceiling. NVIDIA systems try CUDA decoding with `h264_nvenc`; Intel uses QSV, AMD uses D3D11VA with `h264_amf`, and Apple uses VideoToolbox. If a GPU cannot decode a particular source codec, WatchParty retains hardware encoding with software decoding before falling back to libx264. H.264 output remains broadly playable in Firefox, Chrome, and Safari.

Viewers use the same stream, decoding path, and caption list as the host. Each browser can independently choose or disable captions through the selector below the player. Viewer volume, aspect-ratio, and fullscreen controls remain available, but playback-changing controls are hidden. On browsers that block autoplay with sound, tapping fullscreen once supplies the required user gesture and retries playback.

## Tradeoffs

- The first video and audio streams are included; detected embedded and explicitly selected sidecar subtitle tracks appear in WatchParty's JASSUB caption selector. Browsers cannot automatically discover neighboring files.
- ASS/SSA styling is preserved. SRT and WebVTT must be converted to ASS because JASSUB is a libass renderer. Bitmap formats such as PGS are skipped.
- Fullscreen targets the complete video shell so Movi Player and the JASSUB surface stay together. Its transparent Canvas2D compositor avoids opaque-black subtitle layers on mobile browsers; video encoding still uses the selected GPU encoder.
- Each participant can choose a chat display name. It updates without reconnecting and is remembered by that browser.
- Participants can suggest video titles and change their vote; the leading title is shared live within their room. The host still chooses the local video.
- Voting appears beneath the player with live counts, percentages, and ties. Suggestions stay in server memory until restart; votes are removed when a participant disconnects.
- The theme toggle updates the page and player. It remembers the choice when browser storage is available and still works when storage is blocked.
- Display names are unique within each room while connected (case-insensitive, first come first served). A rejected duplicate reverts to the participant's current name.
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
- DOM events, browser file selection, and fullscreen APIs
