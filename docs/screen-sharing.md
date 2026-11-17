# Screen, window, and tab sharing

Choose **Share screen** beside **Choose video / Replace video**. The browser asks which screen, window, or tab to share. Enable the picker's audio option when offered. The button becomes **Stop sharing** while capture is active; the browser's own stop-sharing control also ends the room's stream. Cancelling the picker leaves the current video unchanged.

The current video-selection permission also authorizes screen sharing; its visible label is **Choose video / share screen**. A provider can stop their capture even after transferring hosting or losing permission to select a new source. The host may replace the live source with a file or a different share. Replacing a source, leaving, disconnecting, blocking the provider, and server shutdown close the old capture/peer connections. Existing leave confirmations and the provider's native refresh/close warning apply to live sharing too.

The same theater and resizable chat dock work with live video, including fullscreen. Movi renders both files and live MediaStreams with the same playback, volume, picture-in-picture (where permitted), and theater fullscreen controls. Live play/pause and volume affect only the local viewer. Seeking, timeline, playback speed, file quality, and captions are unavailable during a live share, including seek gestures and keyboard shortcuts. File controls return when a file replaces the share; a screen share follows its capture in real time. The sharer's local preview is muted to avoid feedback. Movi Settings includes local Aspect choices for the live picture and remains anchored above the controls when the timeline is hidden, including fullscreen. Unsupported file/enhancement settings remain unavailable.

## Capture quality

While supplying a screen share, open **Settings → Screen sharing** in Movi. Choose a **Resolution** limit (360p–2160p where the source supports it, or **Source** for its original size) and a **Frame rate** limit (15, 24, 30, or 60 fps, bounded by reported capabilities), then **Apply**. The share stays connected; changes affect the existing video track for everyone watching, including late joiners. Audio is unchanged. These controls follow the capture provider even after a host transfer; viewers keep local Aspect controls.

The menu shows reported capture dimensions and frame rate. Browser/source limits and network conditions can produce lower quality than requested. Unsupported changes show an inline error and retain the previous selection; unsupported browsers show disabled controls with an explanation. Pending changes cannot be duplicated, and stopped/replaced shares ignore late results. Small players use Movi's scrollable Settings sheet. Empty section headings, including Enhancements when none are available, are removed in both live and file menus. The capture controls use the browser's [applyConstraints API](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints).

## Browser requirements

Screen capture requires HTTPS or localhost, a supported browser, a direct user action, and permission on every capture attempt. Capture/audio support depends on the browser, operating system, and selected surface. Sharing a browser tab with its audio option is typically the appropriate choice for a browser video. The app requests display audio, not microphone access. See [MDN's getDisplayMedia documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

## Connectivity and deployment

Video/audio uses WebRTC directly from the sharer to each viewer. The existing Node/WebSocket service handles signaling and permissions, with no new packages or media recording service. The default ICE configuration uses Cloudflare's [public STUN endpoint](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/). Some NAT/firewall combinations require TURN; a WebSocket HTTPS tunnel alone does not relay WebRTC media.

Set `WATCHPARTY_ICE_SERVERS` before starting the server to provide your deployment's TURN relay. For example, in PowerShell:

```powershell
$env:WATCHPARTY_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"},{"urls":"turns:turn.example.com:5349","username":"browser-user","credential":"browser-password"}]'
npm start
```

Use valid credentials supplied by your TURN provider; the example domain and credentials are placeholders. These are browser-client credentials and are sent to joined participants. Use scoped/short-lived TURN credentials where possible; do not put a TURN provider's administrative API key here. An empty JSON array disables external ICE servers for local-network testing.

This is a small-room peer mesh. The default limit is 16 remote viewers per live share, and each viewer consumes the sharer's upload bandwidth. `createApplication({ config: { rtcMaxViewers, rtcIceServers } })` supports an explicit 1–64 viewer limit and validated ICE configuration. The browser's outgoing video bitrate is capped at approximately 3 Mbps per viewer; actual capture/encoding depends on the browser.

## Room protocol

- `screen-share-start {requestId, surface, audio}` requires `chooseVideo`. `surface` is `browser`, `window`, or `monitor`. Validation happens before replacing the old source. The server acknowledges `screen-share-started {sourceId, requestId, iceServers}` and broadcasts a normal session snapshot with `sourceType: "screen"`, the provider ID, and screen-share metadata.
- `screen-share-watch {sourceId, connectionId}` registers a connected viewer. The provider receives `screen-share-viewer {sourceId, connectionId, clientId}` and creates an offer. Late joiners use the same flow.
- `screen-share-signal {sourceId, connectionId, targetId, description|candidate}` relays bounded SDP/ICE only between the current provider and a registered viewer in the same room. Offers originate at the provider; answers originate at the viewer. Connection IDs prevent obsolete negotiations from reaching a replacement peer. Clients queue ICE until the corresponding remote description has been applied.
- `screen-share-stop {sourceId, requestId}` is restricted to the supplying connection or current host. Replacement/disconnect broadcasts `screen-share-ended`, clears media ownership, and advances the media version. Viewer departure closes its peer at the provider without ending the share.

Control messages retain the existing 16 KiB limit. Screen signaling is limited to 200 messages per client per second, with SDP capped at 14,000 characters and ICE strings at 2,048 characters. TURN credentials are included only in admitted room session/start messages, never in the public room directory. Screen shares do not expose original-file or HLS URLs.

## Validation

89 UI/client tests and 65 targeted server/player tests pass, and the production build succeeds. New coverage includes selection permission checks, cross-room/stale signaling rejection, late joins, permitted viewer capture, host transfer, provider departure, file replacement, picker cancellation, revoked permission during capture, early capture end, ICE ordering, retries, and disposal.

Browser QA used a generated moving canvas and a silent audio track returned through a test capture stub, while exercising actual WebRTC between two isolated browser contexts. The receiver decoded 960×540 live frames with live audio/video tracks; fullscreen retained chat. Stop sharing ended both captured tracks and closed the peer. Replacing the live share with a real file detached the live stream and resumed file playback. The action buttons were reviewed at desktop and 375px phone widths. The native OS picker, system-audio behavior on other platforms, and TURN connectivity require deployment/device-specific validation.
