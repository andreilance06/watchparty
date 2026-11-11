# Deploy WatchParty on Render

Use a **Node Web Service**, with one running instance. The frontend, WebSockets, and media processing share the same server.

```text
Build: npm ci --include=dev && npm run build
Start: npm start
Health check: /healthz
```

Set these environment variables as separate key/value entries:

```dotenv
NODE_VERSION=24
NODE_ENV=production
PUBLIC_ORIGIN=https://ypothesi.space
WATCHPARTY_LOW_MEMORY=1
WATCHPARTY_MAX_ENCODERS=1
WATCHPARTY_ENCODER=libx264
```

Keep Render's automatic `PORT` and the application's default `HOST=0.0.0.0`. Leave `TRUST_PROXY` unset. Redirect `www` to the origin selected in `PUBLIC_ORIGIN`. Use DNS-only CNAME records to the service hostname when configuring Cloudflare DNS. See [Render's DNS instructions](https://render.com/docs/configure-cloudflare-dns).

The [Blueprint](../render.yaml) provides these defaults for a new service and prompts for `PUBLIC_ORIGIN`. Adding this file does not change an existing manually configured service: retain its current service/domain and update settings in its Render dashboard.

## Memory and troubleshooting

Containers with a detected memory limit of 768 MiB or less automatically use the low-memory profile. `WATCHPARTY_LOW_MEMORY=1` forces it when the platform does not expose a detectable limit; `0` disables it. The profile defaults to one encoder, one decoder/encoder/filter thread, a 4 MiB source cache per room, two concurrent source reads, and earlier retirement of unused encoders. Software conversion uses x264 ultrafast/zerolatency to avoid lookahead buffering. Static assets are streamed rather than loaded fully for each request. The 128 MiB rendition cache is a disk cache, not a RAM reservation.

`WATCHPARTY_FFMPEG_THREADS` overrides the thread count (0 = automatic; 1–64 = explicit). `WATCHPARTY_MAX_ENCODERS` overrides the encoder limit. Do not increase either to resolve an out-of-memory failure on a small instance. The profile reduces memory demand; it cannot guarantee that arbitrary high-resolution/HDR conversion fits within Render Free's resources.

`GET /healthz` returns `status`, the deployed Render `commit` when available, `lowMemory`, `ffmpegThreads`, and `maxEncoders`. Startup logs also identify the selected profile. After deployment, check that the commit is current and `lowMemory` is true on a small instance. No cookies, source tokens, or private room data appear in this endpoint.

Check Render's logs and memory metrics during a failure. A server restart clears rooms and invalidates browser identities/resume tokens; reload to bootstrap a fresh browser identity after a restart. Reloading the browser that supplies a video also releases its File objects, so choose the video again. These are separate from ordinary socket reconnection.

Use a small H.264/AAC MP4 first, then test conversion and additional viewers. Preserve a nonempty HAR with response bodies and WebSocket frames for unresolved client failures; keep it out of the repository because it may contain credentials and conversation content.
