# HTTPS for local and public viewers

HTTPS enables WebCodecs on remote devices. `http://localhost` is also a secure context, but ordinary `http://LAN-IP` is not. On plain HTTP the app uses native playback where supported and compatibility streaming otherwise.

Caddy terminates TLS and proxies both HTTP range responses and WebSockets to Node. Keep the proxy and Node on the same machine for the supplied configuration. Node trusts forwarded protocol headers only when `TRUST_PROXY=loopback` and the actual peer is loopback.

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

The public configuration blocks the legacy unauthenticated default-room media and control endpoints. Use the existing private-room API to create/join a room and open its returned watch path; see [room API examples](rooms.md). The room API remains public for admission and uses its existing rate limits. Create/Join UI is a separate feature.

For LAN access to the same public hostname, use router hairpin NAT or local DNS resolving that hostname to the server's LAN address. The same trusted public certificate then works on phones without installing a private CA.

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

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [WebCodecs secure-context requirement](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder).
