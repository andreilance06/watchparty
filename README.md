# WatchParty

A local-network watch party that generates shared video segments on demand and gives every browser the same synchronized HLS timeline.

## Features

- Host-only native video picker
- Shared on-demand H.264/AAC segments instead of FFmpeg-WASM work in every browser
- Automatic NVIDIA NVENC, Intel Quick Sync, AMD AMF, or Apple VideoToolbox acceleration with CPU fallback
- The full seekable timeline appears immediately; four-second segments are encoded only when requested
- Original-resolution, high-quality segment cache removed when the session ends or a new video is selected
- MP4, MKV, WebM, MOV, AVI, MPEG-TS, HEVC, VP9, AV1, and other FFmpeg-readable sources
- Stream-copied embedded text subtitles plus matching `.srt`, `.vtt`, `.ass`, `.ssa`, and `.ttml` sidecars
- Subtitle tracks attached directly to Movi Player, with its built-in menu available to hosts and viewers
- Programmatic Movi Player canvas with play/pause, volume, subtitles, and fullscreen controls
- Host-only seeking and playback-speed controls
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

## How playback works

1. The first connected browser becomes the host and chooses a local file.
2. The original stays in place; it is never uploaded or copied into the project.
3. Node probes and extracts captions first, preserving each original subtitle codec and extension, then publishes a complete VOD playlist before encoding the video.
4. Movi/HLS requests only the four-second segments around the shared playback position. Requests from every browser share the same cached segment.
5. Each uncached request launches FFmpeg with `-ss` at that source timestamp. Seeking halfway through a new file therefore starts encoding halfway through it.
6. Pausing kills active video encoders and blocks requests outside the paused segment. Playing resumes on-demand generation with at most two segments of read-ahead.
7. Host actions and clock heartbeats synchronize every player against the same full-duration timeline.
8. The temporary HLS files are removed on the next selection, when the host session ends, or when the server exits normally.

The quality preset uses CQ/CRF 18 and retains the source resolution, with a 25 Mbps safety ceiling. NVIDIA systems try CUDA decoding with `h264_nvenc`; Intel uses QSV, AMD uses D3D11VA with `h264_amf`, and Apple uses VideoToolbox. If a GPU cannot decode a particular source codec, WatchParty retains hardware encoding with software decoding before falling back to libx264. H.264 output remains broadly playable in Firefox, Chrome, and Safari.

Viewers use the same stream, decoding path, and caption list as the host. Each browser can independently choose or disable captions through the player control bar. Viewers can pause or resume shared playback and control local volume/fullscreen, while seeking and speed remain host-only. On browsers that block autoplay with sound, tapping play or fullscreen supplies the required user gesture.

## Tradeoffs

- The first video and audio streams are included; detected embedded and matching sidecar subtitle tracks appear in Movi Player's subtitle menu.
- Subtitle files remain separate from HLS and are not converted. Movi receives their original format through each track's `data-format` metadata. Bitmap formats such as PGS are skipped.
- Fullscreen targets the complete video shell, while Movi Player owns subtitle display in normal and fullscreen modes.
- Each participant can choose a chat display name. It updates without reconnecting and is remembered by that browser.
- Display names are unique while connected (case-insensitive, first come first served). A rejected duplicate reverts to the participant's current name.
- The chat panel has a responsive fixed height; its message history scrolls independently and automatically follows new messages.
- Phone and tablet layouts explicitly stack the full-width player above the chat; the two-column layout begins only on wider desktop screens.
- Viewers may pause or resume the shared playback. Seeking, playback speed, and video selection remain host-only.
- Seeking is immediate at four-second granularity and restarts FFmpeg from the requested source position.
- Caption extraction completes before Movi receives the video source; video encoding stops while playback is paused.
- The server sends one high-quality stream to each viewer, so original-resolution video can use substantially more bandwidth than the earlier 720p mode.
- Movi Player 0.4.0 is bundled locally under the Apache-2.0 license in `vendor/MOVI_PLAYER_LICENSE.txt`.

## Concepts demonstrated

- Semantic HTML and responsive CSS Grid/Flexbox
- Programmatic `MoviPlayer` canvas API with external track selection
- Node HTTP static/HLS serving
- Child-process media conversion
- WebSocket presence, chat, host actions, and drift correction
- DOM events, native file selection, and fullscreen APIs
