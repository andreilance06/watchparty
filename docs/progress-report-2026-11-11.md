# WatchParty

## Daily Project Progress Report

**Project title:** WatchParty: A Browser-Based Synchronized Video Viewing Application  
**Report date:** November 11, 2026 (Asia/Manila)  
**Package version:** 1.0.0  
**Project team:** Jobert Aguirre, Andrei Lance Asuncion, and Justin Mandapat  
**Repository:** [andreilance06/watchparty](https://github.com/andreilance06/watchparty)  
**Implementation commit:** `da46290` — Fix chat ownership and name conflicts after reconnecting  
**Previous report:** [November 10 technical documentation and project progress report](progress-report.md)

## 1. Progress Summary

Today's work focused on deploying WatchParty publicly through Render, resolving custom-domain admission errors, and improving chat behavior during unstable connections. Two reconnect-related defects were fixed and covered by automated regression tests.

The project owner confirmed that joining rooms worked at `https://ypothesi.space` after correcting the public origin setting. The latest chat fixes have been committed, but their deployment and behavior on the public site have not been independently verified. Multi-viewer playback and an error encountered after selecting a large video remain under investigation.

## 2. Work Completed

| Area | Work performed | Result and evidence |
| --- | --- | --- |
| Render deployment | Established Node.js build/start commands and environment settings for the existing HTTP/WebSocket application. | Public deployment reported by the project owner at `https://ypothesi.space`, using Render service `watchparty-05k2.onrender.com`. |
| Custom-domain admission | Identified the exact-origin check rejecting requests after the hostname changed. Set the expected origin to `https://ypothesi.space`. | The project owner confirmed that joining rooms worked after this correction. |
| Chat alignment | Recorded message ownership when a message arrives instead of recalculating it against the current connection ID. | Previously sent messages remain right-aligned when reconnecting changes the client ID. |
| Reconnect name conflicts | Added a reconnect hint using the previous server-assigned client ID. The server replaces a lingering public-room socket only when its verified browser identity matches. | A reconnecting browser can keep its name without being rejected as a duplicate of its own old connection. |
| Regression coverage | Added checks for message alignment, reconnect replacement, host/viewer continuity, independent tabs, and unauthorized replacement attempts. | Relevant automated checks and the production build passed. |
| Source control | Committed the two chat fixes and their regression tests. | Commit `da46290`; the local `origin/master` reference also points to this commit at report preparation time. This does not establish the revision running on Render. |

### Chat ownership correction

Previously, the interface compared each stored message's sender ID with the current client ID whenever it rendered. A reconnect could change that ID, making an older outgoing message appear incoming even though its displayed sender name had not changed.

The reducer now stores an `isOwn` flag when receiving a chat message, and the chat component uses that flag for alignment. Ownership requires a nonempty matching client ID; matching display names do not establish ownership. Reactions, renames, and role updates preserve the recorded flag. The server chat protocol and the existing 500-message retention limit remain unchanged.

### Reconnect name correction

During a network interruption, the server may not immediately detect that the old connection is unusable. A new public-room connection previously received a new client ID while the old connection still reserved the original name, resulting in a guest-name fallback.

The client now sends `resumeClientId` as a WebSocket query parameter on reconnect after receiving a server-assigned role. The server accepts replacement only when the existing room client belongs to the same identity verified through the signed browser cookie. The previous socket is closed, and its later close handler cannot remove the replacement. Different browsers, missing cookies, and tampered cookies cannot use this mechanism to take over another connection. Separate tabs without a reconnect hint continue to receive separate connections. Private-room membership authentication remains unchanged.

## 3. Deployment Configuration

The Render configuration discussed today is:

```text
Build command: npm install --include=dev && npm run build
Start command: npm start
```

```dotenv
NODE_VERSION=24
NODE_ENV=production
PUBLIC_ORIGIN=https://ypothesi.space
WATCHPARTY_MAX_ENCODERS=1
WATCHPARTY_ENCODER=libx264
```

Render supplies `PORT`; the application defaults to listening on `0.0.0.0`. The VPS-specific `TRUST_PROXY=loopback` setting is not required for this Render configuration. `PUBLIC_ORIGIN` supports one exact origin, so the `www` hostname should redirect to the selected apex hostname rather than serve a second independent origin.

The supplied Cloudflare DNS records pointed both apex and `www` CNAMEs at `watchparty-05k2.onrender.com` with proxying enabled. Switching the application hostname to **DNS only** was recommended to isolate the additional proxy layer during troubleshooting. Completion of that DNS change and the `www` redirect has not been confirmed.

## 4. Testing and Validation

| Check | Result | Coverage |
| --- | --- | --- |
| `node --experimental-vm-modules --test tests/rooms.test.js tests/frontend.test.js tests/hosting.test.js tests/permissions.test.js` | 72 passed; 0 failed; 0 skipped. | Room admission, reconnects, connection replacement, hosting, permissions, and browser transport behavior. |
| `npm run test:ui` | 16 passed. | React workflows, including ownership across disconnect/reconnect, identical display names, renaming, host changes, reactions, and missing identity. |
| `npm run build` | Passed. | Production frontend bundling. |
| `git diff --check` before commit | Passed. | Patch whitespace validation. |
| Public room joining | Confirmed by the project owner after the origin correction. | Custom-domain admission only; not a complete deployment acceptance test. |

These results were recorded during today's implementation work. The full backend/media test suite was not run for these changes. Automated socket and DOM tests do not establish real-device playback capacity or recovery under every network condition.

## 5. Issues Still Under Investigation

| Issue | Observation | Status and next evidence needed |
| --- | --- | --- |
| Fourth and later viewers cannot load video | The project owner reported successful playback with up to three simultaneous participants, followed by failures for additional viewers. | Unresolved. There is no explicit three-viewer cap in the reviewed code. Collect Render logs, resource metrics, device/browser details, playback mode, and whether participants used separate devices or tabs. |
| Large-video selection produces an HTML/JSON parsing error | Selecting an approximately 1 GB video reportedly turned the status indicator red with an error resembling an unexpected `<` or `<!DOCTYPE>` token. | Unresolved. This is consistent with HTML being parsed as JSON, but the failed endpoint, HTTP status, response body, and Render logs are needed to identify the source. |
| Production verification of chat fixes | Both fixes pass local regression checks. | Confirm the deployed revision and repeat the unstable-connection scenarios on the public site. |

Render resource limits, provider upload capacity, conversion demand, and proxy failures are diagnostic possibilities, not confirmed causes. `WATCHPARTY_MAX_ENCODERS=1` limits concurrent conversion jobs rather than participants; increasing it is not an established fix for viewer failures. The selected video remains browser-owned and is read in bounded chunks, so the large file observation does not by itself establish a whole-file upload limit.

## 6. Next Steps

1. Confirm that Render deploys commit `da46290`; refresh participating browsers to load the updated client.
2. Test public-room host and viewer reconnects while the old server socket is still present. Confirm names remain intact and old/new outgoing messages stay on the right.
3. Confirm custom-domain HTTPS and the canonical hostname redirect; compare playback with the application DNS record set to DNS only.
4. Reproduce the fourth-viewer failure with a small H.264/AAC MP4 on separate devices, then compare with compatibility playback.
5. Reproduce the large-video error while collecting the failed request's URL, HTTP status, response content type, and corresponding Render logs.
6. Measure provider upload and server resource use before changing encoder limits or choosing a different hosting plan.

## 7. Supporting References

- [Previous technical report](progress-report.md)
- [Project overview and operating instructions](../README.md)
- [Room state and chat reducer](../src/room.jsx)
- [Chat interface](../src/Chat.jsx)
- [Browser connection transport](../js/connection.js)
- [Server connection handling](../server/realtime.js)
- [React regression tests](../src/frontend.test.jsx)
- [Room and reconnect integration tests](../tests/rooms.test.js)

This report distinguishes repository evidence, local automated results, and observations reported by the project owner. No new public-site audit or formal capacity benchmark was performed for this report.
