# HTTPS for local and public viewers

HTTPS enables WebCodecs on remote devices. `http://localhost` is also a secure context, but ordinary `http://LAN-IP` is not. On plain HTTP the app uses native playback where supported and compatibility streaming otherwise.

Caddy terminates TLS and proxies both HTTP range responses and WebSockets to Node. Keep the proxy and Node on the same machine for the supplied configuration. Node trusts forwarded protocol headers only when `TRUST_PROXY=loopback` and the actual peer is loopback.

The supplied Movi bundle works without COOP/COEP headers or SharedArrayBuffer: its WASM demuxer uses ordinary buffers when cross-origin isolation is unavailable. These headers are not required to enable WebCodecs. Trusted HTTPS enables the API; the browser must also support the file's video and audio codecs. Native-compatible files continue to prefer native playback.

## Public hostname

Obtain a domain/subdomain, point its DNS at the server, and forward TCP ports 80 and 443 to Caddy. If your connection is behind CGNAT, a public reverse proxy or VPN with inbound connectivity is needed instead; DNS alone does not provide an inbound route. Caddy obtains/renews the public certificate. Do not expose Node's port directly.

In PowerShell, start Node with:

```powershell
$env:HOST = '127.0.0.1'
$env:TRUST_PROXY = 'loopback'
$env:PUBLIC_ORIGIN = 'https://watch.example.com'
npm.cmd start
```

In another terminal:

```powershell
$env:WATCHPARTY_DOMAIN = 'watch.example.com'
caddy run --config deploy/Caddyfile.public --adapter caddyfile
```

Replace the example hostname in both terminals. The proxy preserves the original Host and supplies `X-Forwarded-Proto`; admitted-room cookies become Secure. Explicit PUBLIC_ORIGIN pins browser POST/WebSocket origin checks to this exact origin (no trailing slash).

The public configuration blocks the legacy default-room media and control endpoints. Use the page's Create Room / Join Room dialog to enter a private room, or use the [room API examples](rooms.md). The room API remains public for admission and uses its existing rate limits.

For LAN access to the same public hostname, use router hairpin NAT or local DNS resolving that hostname to the server's LAN address. The same trusted public certificate then works on phones without installing a private CA.

## Cloudflare named tunnel

When Node and `cloudflared` run directly on the same PC, configure the named tunnel's public hostname to use the service URL `http://127.0.0.1:3000`. Start Node from PowerShell with:

```powershell
$env:HOST = '127.0.0.1'
$env:TRUST_PROXY = 'loopback'
Remove-Item Env:PUBLIC_ORIGIN -ErrorAction SilentlyContinue
npm.cmd start
```

Leave the tunnel's **HTTP Host Header** override unset so it preserves the public hostname, such as `ypothesi.space`. With `PUBLIC_ORIGIN` unset, Node checks each request's origin against its Host and trusted protocol. This supports both `http://localhost:3000` on the host PC and `https://ypothesi.space` on remote devices, while rejecting foreign origins.

In WebStorm's npm run configuration, use `HOST=127.0.0.1;TRUST_PROXY=loopback` and remove `PUBLIC_ORIGIN`, including any inherited setting. Stop the existing Node process and restart it so the change takes effect. Keep your named tunnel running, reload both addresses, and enter the same room to test comments and reactions. Cookies are separate for localhost and the public hostname, so each address needs its own room admission.

For a deployment that should accept only one public origin, set `PUBLIC_ORIGIN` to that exact HTTPS origin, including a port if needed. This pins POST and WebSocket origin checks and intentionally rejects localhost access.

Cloudflare supplies the browser's original protocol through `X-Forwarded-Proto`. Node must explicitly trust the loopback proxy to recognize HTTPS and set Secure cookies. Without proxy trust, the default origin check can compare the browser's HTTPS origin against HTTP and reject `/api/viewer-identity` with `403 Request origin is not allowed.` Identity initialization stops before the reaction buttons and control WebSocket are initialized, so this failure also prevents chat and global reactions. These settings apply to a proxy on the same PC; a container or another machine requires a separately configured trusted connection.

After restarting, reload both browsers and verify in browser DevTools:

- `POST /api/viewer-identity` returns 200 on both addresses and sets an HttpOnly `watchparty-browser` cookie. Through the public HTTPS hostname, both this cookie and the room-scoped `watchparty-member` cookie also have Secure.
- Creating or joining a room succeeds. Its `wss://.../rooms/<roomId>/ws` request upgrades with status 101; selecting a host file also opens the room's `/source` WebSocket.
- Send chat messages and global reactions from each browser and confirm they appear in both. Test video playback, sound, captions, and a seek.

Cloudflare supports WebSockets on all plans. Check that **Network > WebSockets** is enabled for the domain. If a request fails at Cloudflare, inspect its security events for a matching challenge or block, and check any Cloudflare Access policy protecting the hostname. Disable shared caching for session, identity, and authenticated media endpoints; do not apply a Cache Everything rule to them. Run one Node instance for this deployment because room state and signed browser identities are held in memory.

If identity and room admission work but the school PC's WebSocket fails, compare that PC on school Wi-Fi and a permitted mobile hotspot using the same URL. A successful hotspot test with a failing school connection points to school-network filtering; ask its administrator about HTTPS WebSocket access. The app cannot establish its real-time connection through a network that blocks the upgrade.

References: [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/), [Cloudflare Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/).

## Local-only hostname

Run Node with HOST and TRUST_PROXY as above. Set PUBLIC_ORIGIN to the exact local HTTPS origin, and make WATCHPARTY_LOCAL_HOST match that hostname or LAN IP:

```powershell
$env:WATCHPARTY_LOCAL_HOST = 'watchparty.home.arpa'
caddy run --config deploy/Caddyfile.local --adapter caddyfile
```

Create the matching LAN DNS/hosts entry. Caddy uses its internal CA for this configuration. Install and trust that CA's root certificate on **each** viewer device; bypassing a certificate warning is not a substitute for a trusted HTTPS origin. On iOS, enable full trust for the installed root in Certificate Trust Settings. Caddy may trust the CA on the server automatically, but that does not configure phones or other computers.

Alternatively, serve only localhost for development. Tailscale Serve can provide a trusted HTTPS tailnet hostname, but does not by itself provide public access.

## Proxy requirements and checks

- Preserve Range/Content-Range, Accept-Ranges, Content-Length and media MIME types. Do not buffer entire original files or strip query strings.
- Forward WebSocket upgrades for the room control and file-data connections. Allow long-running media responses; avoid short upstream response timeouts.
- Disable shared caching for authenticated original/media responses. Application byte caches remain bounded and room-scoped.
- Keep PUBLIC_ORIGIN consistent with the browser address and send only trusted forwarding headers. For a proxy on another machine, keep forwarding untrusted and terminate HTTPS locally or extend the explicit trusted-proxy configuration deliberately.
- On a viewer, verify `isSecureContext === true`, room creation/joining works, the cookie has Secure, range requests return 206, and both WebSockets connect using wss.
- Run a real playback test with sound, an uncached seek, and captions. TLS configuration alone does not establish decoder compatibility.
- Test a supported H.264/AAC MKV to exercise WebCodecs rather than the native MP4 path. In DevTools, inspect `document.getElementById('video').watchpartyMetrics.playbackMode`: expect `wasm` on a suitable device, `native` for a supported MP4, and `compatibility` for unsupported audio or an insecure remote origin. Silent MKV playback does not require `AudioDecoder`.
- Confirm `/vendor/movi.wasm` returns 200 with `application/wasm`, original-file byte ranges return 206, and compatibility fallback retains the room's time, pause state, speed, and selected captions.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [WebCodecs secure-context requirement](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder).
