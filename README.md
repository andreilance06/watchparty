# WatchParty

A browser-hosted watch party with synchronized playback, chat, private rooms, reactions, and next-video voting.

## Run

Requires Node.js 18+. Install dependencies and start the server:

```sh
npm install
npm start
```

Open `http://localhost:3000`. The server installs FFmpeg automatically; hosts and viewers only need a browser. `FFMPEG_PATH` may point to an existing executable. Use [trusted HTTPS](docs/https.md) for LAN and public access to enable WebCodecs on viewers' devices. HTTP still supports native files and compatibility streaming.

The host selects one video and optional SRT, VTT, ASS, or SSA files. Keep that browser page open: its File objects answer bounded byte requests, with no initial full-file upload. Transferring host keeps that browser as the video provider while the new host controls the room. Refreshing, disconnecting, or blocking the provider ends the current video; the host can choose a replacement from their device.

The root page opens a Create Room / Join Room dialog, with an optional initial display name. Creating a room shows its access code and invitation link; leaving the name blank generates a guest name. In a room, the room name appears above the player panel; use **Invite** to view or copy the private-room access code. Visitors can continue to the public default room, reopen room selection there, or leave/switch from a private room using the header control. See the [room API](docs/rooms.md).

Next-video suggestions search Wikipedia through its keyless MediaWiki API. Choose the matching article to include its thumbnail and attribution link in the shared vote; if search is unavailable or there is no match, you can still suggest the title without a poster. Suggesting automatically casts your vote, and only the person who first suggested a title can remove it. Posters are served by Wikimedia, so image availability and licensing depend on each source image. See the [movie search API](docs/rooms.md#movie-suggestions-and-posters).

## Playback

- Each device independently chooses original-file playback or compatibility streaming. Supported MP4/WebM sources use native decoding; other suitable sources use Movi's WASM demuxer and WebCodecs. Original-file playback preserves source resolution.
- WebCodecs selection requires a secure context, smooth browser video decoding, and supported audio at the source's actual channel count and sample rate. Silent videos need only `VideoDecoder`. Video and audio checks share a 500 ms deadline; timeouts and standalone WASM video decoding use compatibility streaming.
- Native capability checks include audio as well as video. Unusual audio, unsupported devices, demanding decoding, runtime decoder errors, and sustained stalls use server compatibility streaming. A source with no audio is handled separately from an audio decoding failure.
- Compatibility output uses H.264, 8-bit YUV420, and stereo 48 kHz AAC, capped at 30 fps. It fits within 1920×1080, preserves aspect ratio, and never upscales. HDR sources are tone mapped to SDR.
- The server publishes the full seekable timeline after probing metadata, without waiting for encoder detection or caption extraction.
- Compatibility segments use a fixed frame count near two seconds. One continuous encoder shares completed segments across the room, retaining AAC state across boundaries and pauses. A private loopback upload sink grants permission before each segment body, bounding production to the shared playhead plus two segments while playing and the target while paused. A paused seek near a segment end may also decode the next fragment; preceding preroll and fragment zero support HLS initialization. Seeks replace the stream generation and discard retired files; hls.js loading is suspended during a pause.
- Host seeks are acknowledged with a new playback revision. Old ticks and HLS recovery seeks cannot reset the room clock. Compatibility clients reload the acknowledged generation while preserving pause, speed, and caption selection.
- Direct streams reuse a bounded 16 MiB byte cache and share concurrent reads. HTTP backpressure, cancelled requests, stale source generations, and room membership apply to original bytes as well as generated media.
- Playback-path switches are local to a viewer and preserve the shared timestamp, pause state, speed, and caption choice. They do not replace the room's source or send synthetic play/pause actions.
- Movi's measured stutter warnings trigger compatibility fallback for hardware and software decoding alike. Browsers may decode supported codecs in software; suitable smooth browser decoding still qualifies for WebCodecs playback.

FFmpeg/HLS remain the compatibility path because browser decoding alone cannot reliably cover every video/audio codec on every phone. The server attempts available hardware encoders, remembers failures for the current source, and falls back to libx264. Conversion uses software decoding so scaling and HDR filters work consistently across encoders.

## Captions and controls

Movi's native **Subtitles/Captions** button, **Settings → Subtitles** page, and context submenu select room captions, including Off. Each viewer chooses independently. Hosts can choose **Add captions** on these surfaces during playback, including when the video has no captions yet; additions preserve existing selections. Cancelling the file picker preserves playback and returns focus to CC. Menus use Movi's own theme, transitions, positioning, and dismissal and show each track's stored name, language, and Default/Forced flags. Tracks without a stored name use “Captions N”; external tracks use their filenames. Subtitle customization/transcript actions are hidden because room captions use the JASSUB renderer.

A valid external subtitle file is attached to the current video regardless of filename. Its timestamps follow the video's clock; unrelated subtitles can show incorrect dialogue or timing. The app does not detect movie matches or automatically align subtitles. Unsupported or unconvertible files report an error and leave the existing captions available.

JASSUB is retained as a libass renderer behind Movi's public renderer/overlay APIs. ASS/SSA styles, positioned signs, karaoke, and embedded font attachments are preserved. Other supported text formats are normalized to ASS. Bitmap subtitles remain unsupported in this version. Selected caption content and fonts begin loading as soon as track descriptors arrive and are cached per browser/source; extraction and renderer initialization never gate the first video frame. A player notice shows “Preparing captions…” followed by “Captions ready” for three seconds, with current status retained in the caption menu. Caption errors leave playback available.

Native/HLS engines use the adapter's clock bridge because Movi's embedded renderer hook only runs on its WASM pipeline. The caption canvas lives inside the player, including fullscreen. Native video Picture-in-Picture cannot include this separate subtitle surface; Document PiP support depends on the browser/player.

Click a name in the chatroom's **Participants** list to open its dropdown. Everyone can inspect playback permissions; the host can grant or revoke **Play/pause**, **Seek**, and **Playback speed** for viewers. The same dropdown offers **Transfer host**, **Kick and block**, and **Unblock**. Viewers start with play/pause enabled and seeking/speed disabled; choosing the shared video and managing room captions remain host-only. Volume, aspect ratio, caption selection, and fullscreen are local. Browsers may require a tap to enable sound or playback.

Blocked viewers stay in the participant list with a dimmed, crossed-out name until a host unblocks them. They cannot reconnect to that room, including through another tab in the same browser profile. Blocks survive host changes and disappear with the room or server restart. Unblocked viewers manually rejoin. Transferring host takes effect immediately and preserves the current video, playhead, speed, pause state, and captions; the former host starts with default viewer permissions and continues supplying the video until it is replaced or their browser disconnects. The new host can add captions or choose a new video.

Permissions are checked on the server and remembered for the same browser profile in each room, including after disconnecting or explicitly leaving and rejoining. Other hosts taking over do not reset grants. A viewer becoming host clears that viewer's stored grants; room expiry and server restart clear all grants. Clearing cookies or changing browsers creates a new identity. Private-room passwords and membership are still required after leaving.

## Chat and reactions

Use the emoji button in chat to insert at the cursor, or the plus button below a comment to react. Selecting your current reaction removes it; selecting another replaces it. Reaction counts and names are shared within the room. The picker closes on selection, Escape, an outside click, or another click on its button.

Chat retains the latest 500 comments per browser; the server retains reaction targets for the latest 500 room comments. There is no chat history replay or persistence. Floating reactions are capped at 30 and respect reduced-motion preferences. Next-video suggestions and voting remain shared within the room.

## Performance and verification

The performance targets are a first playable frame within **3 seconds** of selection and an uncached seek within **2 seconds**, with capable hardware, indexed files, and enough network throughput. These are measured targets, not guarantees for arbitrary codecs, slow uploads, long GOPs, unindexed containers, or CPU-only 4K conversion.

In DevTools, inspect `document.getElementById('video').watchpartyMetrics` for `playbackMode` (`native`, `wasm`, or `compatibility`), first-picture, seek, and fallback timings and `fallbackReason`. Here `wasm` identifies Movi's WASM demuxer with WebCodecs video decoding. First-picture timing includes source preparation after registration; the file-picker interaction is excluded. Measure cold page/asset loading separately. Browser autoplay denial must not be classified as codec failure.

See the [WebCodecs validation results](docs/webcodecs-validation.md) for a three-run comparison of native, WebCodecs, and compatibility playback, resource measurements, and local Caddy HTTPS checks.

```sh
npm test
```

Tests cover room admission/isolation, range validation/cancellation/deduplication, stale generations, fast readiness independent of captions/encoder detection, local fallback negotiation, bounded continuous encoding, AAC timestamps and decoded audio across pause/resume, HEVC Main 10/E-AC-3 conversion, downscaling, encoder failure, seek acknowledgements, caption lifecycle, chat, voting, and proxy trust. Media tests create temporary fixtures and skip if FFmpeg is unavailable. DOM doubles test wiring, not visual decoding.

For release testing, use real desktop Chrome/Edge/Firefox/Safari, Android Chrome, and iPhone/iPad Safari. Check visible motion and audible audio for H.264/AAC MP4, HEVC MKV, VP9/AV1, multichannel/unusual audio, 4K/HDR conversion, and styled ASS. Test cold/warm startup, uncached seeks, fullscreen captions, autoplay gestures, and mixed direct/compatibility viewers in one room.

## Structure and dependencies

`server.js` and `js/app.js` compose the application. Server media modules handle probing, lazy caption extraction, compatibility playlists and continuous encoding runs; `server/source-relay.js` owns browser files and authenticated range serving. Player modules handle source selection, synchronization, Movi controls, and the JASSUB adapter.

Third-party distributions are bundled locally; replace generated distributions as a unit rather than editing them. Movi Player **0.4.1** (slim JS/WASM) is covered by `vendor/MOVI_PLAYER_LICENSE.txt`; JASSUB **2.5.16** and its worker/WASM assets are covered by `vendor/jassub/LICENSE.txt`.

The hls.js pause/resume bridge uses Movi 0.4.1's internal stream-wrapper loader because Movi has no public adaptive-loader pause API. This dependency is isolated in `js/player/compatibility-buffer.js`; verify its integration when upgrading Movi.

Movi 0.4.1 exposes custom controls and overlays but no host-managed subtitle-menu provider. `js/player/native-caption-menu.js` isolates element-level menu hooks for the room's track list, selection, status, and host-only Add action. It reuses native CC/Settings/context surfaces and leaves decoder methods and the generated bundle intact. Verify these hooks against the real player when upgrading Movi; DOM doubles do not exercise its menu lifecycle or CSS.
