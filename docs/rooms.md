# Room and browser-hosting API

On the root page, the entry dialog lets visitors create a room, join by access code, or continue to the public default room. Invitation URLs containing `?room=CODE` open the Join form with the code prefilled.

## Creating and joining

`POST /api/rooms` accepts a JSON object:

```json
{ "name": "Friday films", "accessCode": "FRIDAY", "password": "optional secret", "displayName": "Alex" }
```

Only `name` is required. Names are 1–80 characters after whitespace normalization. Custom codes are 4–32 ASCII letters, digits, or hyphens, normalized to uppercase; an omitted/empty code generates eight random characters. Passwords are optional, at most 128 characters, and case/whitespace-sensitive. Display names use the existing 24-character room-local naming rules. Passwords are salted and hashed with scrypt in memory.

Success returns `201`, a room-scoped HttpOnly/SameSite=Strict membership cookie, and:

```json
{
  "room": {
    "id": "room-uuid", "name": "Friday films", "accessCode": "FRIDAY",
    "passwordRequired": true, "invitePath": "/?room=FRIDAY", "watchPath": "/?roomId=room-uuid"
  },
  "member": { "clientId": "member-uuid", "role": "host" },
  "endpoints": {
    "session": "/rooms/room-uuid/api/session", "leave": "/rooms/room-uuid/api/leave",
    "websocket": "/rooms/room-uuid/ws", "source": "/rooms/room-uuid/source"
  }
}
```

`POST /api/rooms/join` accepts `{ "accessCode": "FRIDAY", "password": "optional secret", "displayName": "Sam" }`. It redirects with **307** into `/rooms/:roomId/api/join`, preserving the POST body. Browser fetch follows this automatically and attaches any existing cookie within that room's scope. The final response is `200` with the same response shape and a membership cookie. An existing membership is reused without resetting its host identity. Non-browser clients must follow the redirect and maintain a cookie jar.

The entry form asks for a room name when creating, and an access code when joining. A display name is optional in either flow; when omitted, the client supplies its generated `Guest-XXXX` name. After creating a room, the interface shows the access code and invitation link before entering the room. Successful admission then navigates to the returned `room.watchPath`.

For example, in the browser console on the WatchParty origin:

```js
const response = await fetch('/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Friday films', accessCode: 'FRIDAY', password: 'secret' })
});
const session = await response.json();
if (!response.ok) throw new Error(session.error);
location.href = session.room.watchPath;
```

Viewers use `/api/rooms/join` with the code/password, then navigate to the returned watch path. The invitation URL carries only the access code; users still confirm Join and provide a password if required.

`GET /rooms/:roomId/api/session` restores metadata and the current role. `POST /rooms/:roomId/api/leave` revokes the caller's membership and connections and expires the cookie. Requests to other rooms cannot reuse that membership. Cookies have room-specific paths and gain `Secure` over HTTPS. Browser mutations/upgrades require a matching Origin when one is supplied.

The room name appears above the player panel while connected. Use **Invite** to view and copy the private-room access code; the public default room is labeled as having no access code. The private-room header's **Leave room / switch** button calls the leave endpoint and returns to the root room chooser. From the public room, **Choose or create a room** reopens the chooser without creating another public-room connection.

Errors return `{ "error": "message" }`: `400` invalid input, `401` missing membership/incorrect password, `403` forbidden origin, `404` missing room/endpoint, `405` wrong method, `409` code collision, `413` body over 16 KiB, and `429` admission limits. The defaults permit 100 private rooms, 1,000 memberships per room, and 30 admission attempts per address per minute. No public room listing exists.

## Chat, replies, and reactions

Room chat accepts `{ "type": "chat", "message": "Hello" }`, with an optional `requestId` (up to 100 characters) and `replyToId` referencing a retained comment in that room. Messages are trimmed and limited to 300 characters. Accepted messages broadcast `type`, `commentId`, `clientId`, `name`, `message`, `time`, and the supplied request identifier. Ordinary requests without the new fields remain supported.

A reply additionally broadcasts a server-generated `replyTo: { commentId, name, message }` snapshot of its immediate parent. Client-supplied quote text and names are ignored. Unknown, malformed, expired, and foreign-room targets return `{ type: "error", action: "chat", code: "REPLY_UNAVAILABLE", requestId, message }` to the sender without posting the message. The browser keeps its draft and reply selection until acceptance or cancellation.

The server retains text, original author names, and reaction targets for the latest 500 comments per room, pruning them together. There is no chat history replay or disk persistence. A reply's quoted snapshot remains readable in clients even after its original message leaves their local history.

Global reactions use `{ "type": "reaction", "emoji": "..." }`; message reactions use `{ "type": "comment-reaction", "commentId": "...", "emoji": "..." }`, with `null` to remove the sender's message reaction. Both accept one validated emoji grapheme. The single composer picker has Message emoji and Global reaction tabs using the same searchable catalog. Message reactions are also available through the message context menu. Each message permits one reaction per verified browser identity, with the existing connection-ID fallback for clients without one. Selecting a different emoji replaces the previous reaction, including across tabs or reconnects. Reaction snapshots keep the existing `reactions: [{ clientId, name, emoji }]` list and add recipient-specific `myReaction` (an emoji or `null`). Raw browser identities are never sent. Counts and highlights follow these authoritative snapshots. All broadcasts stay within the admitted room.

## Movie suggestions and posters

`GET /api/movies/search?q=Arrival` searches Wikipedia through its keyless MediaWiki Action API. Queries are normalized, limited to 80 characters, and cached in memory for ten minutes. The API returns up to eight article matches with a title, short description, article URL, and optional Wikimedia thumbnail URL. Requests use the existing admission rate limit.

The current host starts an empty movie poll with `{ "type": "start-video-poll" }`. Each `party-state` includes `poll: { id, status, result }`, initially `{ id: null, status: "idle", result: null }`. Starting a poll creates a new ID and sets its status to `open`. While open, all admitted participants may suggest titles and vote. Use that poll's ID in every suggestion, vote, removal, and finish command; inactive polls and stale IDs are rejected.

To add a selected result to an open poll, send the result's metadata:

```json
{
  "type": "suggest-video",
  "pollId": "current-poll-id",
  "title": "Arrival (film)",
  "movie": {
    "pageId": 23270459,
    "title": "Arrival (film)",
    "pageUrl": "https://en.wikipedia.org/wiki/Arrival_(film)",
    "posterUrl": "https://upload.wikimedia.org/wikipedia/en/example.jpg",
    "description": "A science fiction film."
  }
}
```

The server verifies that the selection came from a recent search, accepts only HTTPS Wikipedia article links and Wikimedia upload/thumbnail image URLs, and shares the selected details in party-state snapshots. `posterUrl` may be `null`; title-only suggestions remain supported. Poster availability and reuse terms vary by image; follow the linked article for source details.

The server records the original suggester using its verified browser identity, with a membership/connection identity fallback when no browser cookie is available. Each suggestion includes `ownerId`, `ownerName`, `votes`, and a personalized `canRemove` flag. Identity keys stay private. The first submission owns a title; submitting a duplicate preserves that ownership and casts the submitter's vote for the existing suggestion. Every new suggestion also casts its owner's vote automatically. Cast or replace a vote with `{ "type": "vote-video", "pollId": "current-poll-id", "suggestionId": 1 }`.

Active suggestions' `ownerName` values follow accepted display-name changes and rejoining connections with the same verified owner identity. Rejected names do not change attribution. Completed poll results retain their recorded names and counts.

To remove an entry, send `{ "type": "remove-video-suggestion", "pollId": "current-poll-id", "suggestionId": 1 }`. The server permits the current host or original suggester and clears all votes targeting that entry. Ownership survives browser restarts and room leave/rejoin while the same browser profile retains its cookie, the origin stays the same, and the room/server remains alive. Display names and client-supplied owner fields do not grant ownership. Votes themselves retain their existing connection lifetime.

The current host concludes voting with `{ "type": "finish-video-poll", "pollId": "current-poll-id" }`. The resulting `party-state` has status `closed`, an empty active suggestion list, and a frozen `poll.result: { suggestions, totalVotes, winnerIds }`. All highest-voted entries are winners; `winnerIds` is empty when no votes were cast. Clients hide the pinned card and post the result once per poll in chat. The latest result is included in subsequent snapshots for reconnecting/new participants until the host starts a fresh poll. Starting again clears the prior result and creates an empty round. Polls are room-scoped and in memory; finishing does not select or change the shared video.

## Control connection and file declaration

Before opening a control socket, call `POST /api/viewer-identity` (no body required). It returns `{ "ready": true }` and sets or refreshes a persistent `watchparty-browser` cookie (`Path=/`, `HttpOnly`, `SameSite=Strict`, and `Secure` under HTTPS). The cookie is signed with a per-process secret and has a rolling 400-day browser lifetime. It identifies a browser for room permissions only; it does not grant room admission. Invalid signatures or a server restart cause a fresh identity on the next bootstrap. Clients without this cookie use their server-known membership or connection identity and cannot retain public-room grants after reconnecting.

Open `endpoints.websocket`, then send the existing `{ "type": "join", "name": "Alex" }` message. Membership/role comes from the server cookie, not a client-provided ID or role. Existing playback, chat, participant, reaction, and voting messages apply only inside this room. The creator's host slot is reserved even when a viewer connects first.

### Host reconnection and creator priority

After an unexpected host control-socket disconnect, the server reserves hosting for 15 seconds (`hostReconnectGraceMs: 15000` in server configuration). A reconnect with the same verified browser identity, or the same authenticated membership when no browser identity is available, restores hosting before the deadline. Public default-room reconnects require the browser cookie because their connection IDs change. Client-supplied IDs, roles, and names cannot claim a reservation. After timeout, the next connected participant becomes host; a former temporary host returning afterward becomes a viewer.

Each private room records its creator using the verified browser identity, with the original authenticated membership as fallback. Whenever the creator reconnects, they reclaim the sole host role even after the grace period or a deliberate transfer; the replacement host becomes a viewer with default playback permissions. A deliberate transfer remains in effect while the creator stays on their existing connection. Other hosts cannot block the creator. An explicit Leave request releases the current host immediately, including when its reconnect reservation is pending. The public default room has no permanent creator.

Every `party-state` includes `host: { clientId, name, status, reconnectUntil }`. Status is `connected`, `reconnecting`, or `vacant`; `reconnectUntil` is the deadline in epoch milliseconds during a reservation and `null` otherwise. The private room's initial, not-yet-connected creator slot can have a client ID while status is `vacant`. Identity keys are never included. Clients hydrate a reconnecting notice from this snapshot. The existing `host-left` event is sent on actual release/handoff, not on a successfully restored refresh. Pending reservations delay empty-room expiry and are cancelled on restoration, explicit handoff, destruction, or shutdown.

Connected participant snapshots include an `isCreator` flag so temporary hosts can offer transfer back to the creator without offering a block action. The server independently enforces this protection.

The reservation preserves the host role, not browser File objects. Refreshing the browser supplying video still ends its source; a source supplied by another connected browser survives role changes. Creator identity and reservations are in memory, scoped to each room, and require retained cookies and the same origin to recognize a returning browser.

The host opens a standard browser file chooser and retains the `File` objects. Declare one video and up to eight sidecar files:

```json
{
  "type": "source-register", "requestId": "client-request-id",
  "video": { "id": "video-file-id", "name": "movie.mkv", "size": 12345678, "type": "video/x-matroska" },
  "captions": [{ "id": "caption-file-id", "name": "English.srt", "size": 1234 }]
}
```

IDs must be unique ASCII alphanumeric/hyphen strings of 1–64 characters. Sizes must be positive safe integers. Names are limited to 255 characters; directory components are discarded. No filesystem path or arbitrary source URL is accepted. Caption extensions are SRT, VTT, ASS, or SSA.

Only the current connected host may register or edit files. A new registration invalidates the previous source generation, pending reads, and media. The reply is `{ type: "source-registered", requestId, sourceId, token, relayPath }`. The token is a private, single-use attachment credential; never place it in a URL or share it with viewers.

Open a separate WebSocket at `relayPath` and send `{ type: "source-attach", sourceId, token }`. Private rooms also require their membership cookie. Attachment must begin within 5 seconds of opening this socket and within 30 seconds of registration. Successful attachment receives `source-attached`, then the existing processing/ready `session-state` messages arrive on the control socket.

## Comment reactions

Broadcast `chat` messages include a server-generated UUID `commentId`. Send `{ type: "comment-reaction", commentId, emoji }` with one emoji grapheme to set or replace your reaction, or `emoji: null` to remove it. The server broadcasts `{ type: "comment-reaction", commentId, reactions: [{ clientId, name, emoji }] }` to everyone in the room, including the sender. This array replaces the comment's previous reaction state. Each participant has at most one reaction per comment.

Only the latest 500 room comments remain valid reaction targets; unknown, evicted, or foreign-room IDs and invalid emoji receive an error. Reaction snapshots may be sent on reconnect; ignore IDs not present in the local chat. Comments are not replayed or persisted.

## Range relay

The server requests `{ type: "source-read", requestId, fileId, offset, length }` on the data connection. Read only `file.slice(offset, offset + length)`. Reply with one binary WebSocket message: a **four-byte unsigned big-endian request ID**, followed by exactly `length` raw bytes. A failed local read replies `{ type: "source-error", requestId }`.

Requests are at most 256 KiB, with four outstanding per room and a bounded queue. Honor browser `bufferedAmount` backpressure. Reads time out after 30 seconds. Unsolicited/expired request IDs cannot fulfill another request; corrupt lengths or invalid attachment close the connection. Source identity is bound to the data socket, so old sockets cannot contribute bytes to a replacement source.

Only server-side FFmpeg receives the capability-protected loopback URL. Viewers receive a room-authenticated `/rooms/:roomId/media/original?v=:mediaVersion` URL supporting GET, HEAD, and single byte ranges (206/416), together with compatibility HLS/caption URLs. No host attachment token or internal URL is exposed. Original bytes use a bounded 16 MiB per-source memory cache with shared in-flight reads; generated segments, captions, and fonts are cached on disk. This is an on-demand relay, not a full-file upload; probing and playback may nevertheless read a large portion or all of the file. Embedded caption preparation uses selective reads that skip audio/video payloads.

## Playback selection and compatibility

`session-state` adds `originalUrl`, `compatibilityUrl`, and `mediaInfo` (MIME type, video/audio codecs, audio presence/sample rate/channels, pixel format, dimensions, fps, bit depth, and HDR flag). `mediaUrl` remains the compatibility playlist URL for older clients. Readiness depends on basic metadata, not encoder detection or subtitle conversion. Initial caption descriptors may refer to tracks not yet extracted; GET of a selected caption starts its extraction. Selective discovery can subsequently publish additional tracks through `captions-updated` without replacing the source or changing existing selections. Unsupported bitmap tracks are omitted.

Embedded caption jobs use an internal exact-range reader over the authenticated file relay. Container adapters read metadata and selected subtitle payloads while skipping audio/video payloads; these reads do not expand to the original-stream cache's 256 KiB pages. Small local subtitle-only inputs are normalized to ASS by FFmpeg. Indexes, pending jobs, completed captions, and fonts are shared per source. The original video URL is never an input to caption conversion, and unsupported extraction never falls back to scanning the video. A failed caption GET returns HTTP 503 with an explanation and an external-caption suggestion; playback remains available.

Providers may advertise `capabilities: ["batch-reads-v1"]` in `source-attach`. The server can then request `{ type: "source-read-batch", requestId, fileId, ranges: [{ offset, length }] }` with at most 64 ranges and a combined body no larger than the configured source chunk size (at most 256 KiB). The reply uses the existing four-byte request ID followed by concatenated bytes in range order. Providers validate the entire batch before reading and allow at most four file operations in flight across their relay sockets. Authentication, provider ownership, cancellation, timeouts, and exact reply-length checks apply to batches as to ordinary reads. Providers without the capability receive ordinary `source-read` requests. Queued playback and caption reads alternate when both are present.

Matroska extraction first uses seek metadata to locate subtitle cues, track statistics, and fonts. Direct caption-block extraction requires valid, unique cue positions matching the selected track's declared frame count and full-precision TrackUID, with block track/timestamp validation. Missing or inconsistent metadata falls back to batched structural traversal, preserving complete tracks. Caption GET responses expose per-source read counters and extraction/index/conversion timings in `X-WatchParty-Caption-Metrics` and `Server-Timing`; the browser retains the selected track's snapshot in `video.watchpartyCaptionMetrics`. These diagnostics never contain file paths or relay credentials.

Selective adapters cover Matroska/WebM text tracks and fonts, MP4/M4V/MOV/3GP/3G2 subtitle samples (including fragmented MP4), AVI/OpenDML text and GAB2 ASS/SRT, and Ogg/OGM text streams. Unsupported layouts/codecs, including bitmap subtitles, Kate, and captions inside video bitstreams, require external captions. See the README caption support table. File extensions are hints; adapters identify the container from its bytes. Public caption URLs, descriptors, and WebSocket messages are unchanged.

Each viewer chooses native original playback, Movi WASM/WebCodecs playback, or compatibility streaming independently. A connected room client can send `{ type: "compatibility-request", requestId, mediaVersion }`. A current generation receives only on that client's socket:

```json
{ "type": "compatibility-ready", "requestId": "client-request-id", "mediaVersion": 1,
  "url": "/rooms/room-uuid/hls/master.m3u8?v=1&g=0", "time": 12, "paused": false, "playbackRate": 1,
  "playbackRevision": 1, "streamGeneration": 0 }
```

The client applies this shared clock snapshot while replacing its local playback path. No room media version, caption ID, or playback state changes. Stale generations receive an error with the requestId. Private-room HTTP and WebSocket authentication apply to both paths.

### Quality and bitrate selection

Ready `mediaInfo` includes `sourceSize`, estimated source `bitrate`, `qualityOptions: [{ quality, width, height, bitrate }]`, and `bitrateLimits` in bits per second. These descriptors do not prepare alternative encodes. Resolution choices never upscale the source. Local Source playback uses `originalUrl` without a transcoding request.

To select a rendition, extend the compatibility request with `quality` (one of the advertised string values, or `"auto"`), `bitrate` (`"auto"` or one of the advertised numeric limits), and optionally `automatic: true`. The browser normally resolves Auto against its measurements before sending the concrete profile. For example:

```json
{ "type": "compatibility-request", "requestId": "quality-1-2", "mediaVersion": 1,
  "quality": "720", "bitrate": 3000000, "automatic": false }
```

The existing `compatibility-ready` reply additionally includes `rendition: { id, quality, width, height, bitrate }`, `renditionGeneration`, and the actual frame-aligned `segmentSeconds`. Its URL includes `r` (rendition ID) and `rg` (rendition generation), in addition to source `v` and shared playback generation `g`. Every playlist propagates these identifiers to child playlists and fragments. Invalid or stale selections return `quality-error` with the request ID, source version, message, and `QUALITY_INVALID` or `QUALITY_BUSY` code. Legacy requests without quality settings retain the existing compatibility path.

Selection and playlist requests do not launch FFmpeg. The first fragment request starts the selected rendition, sharing identical profiles across viewers. To preserve working playback, the client prepares the selected current fragment before switching; at nonzero positions it prepares fragment zero first for HLS initialization. It then sends `{ type: "quality-selection", mediaVersion, renditionId }`. Use `renditionId: "source"` when returning to original playback, or `{ type: "quality-release", mediaVersion }` when releasing all local demand. Pending negotiations expire after ten seconds. Connected selection leases are refreshed through telemetry; disconnects release them.

Clients send `{ type: "quality-telemetry", mediaVersion, throughputBps, bufferedSeconds, renditionId }` approximately every two seconds. The server rate-limits processing and replies locally with `quality-status` containing `active`, `limit`, CPU/event-loop `pressure`, observed `encodingRatio`, provider `{ bps, sampledAt, samples }`, and demanded `renditions`. Client-reported measurements are advisory; source-provider throughput and process limits are measured/enforced on the server.

Rendition-local recovery broadcasts `rendition-replaced { mediaVersion, renditionId, url }` or `rendition-error { mediaVersion, renditionId, message }`; clients ignore other renditions. A replacement requires renegotiating the local current profile. Shared seeks still advance `g` and invalidate all earlier fragment URLs. Quality changes never send transport commands or restart another rendition. Source replacement and room shutdown cancel every associated run.

`WATCHPARTY_MAX_ENCODERS` sets the application-wide process limit (default two). Configuration overrides also support `maxEncoders`, `renditionIdleMs` (default 10000), and `renditionCacheBytes` (default 134217728 per room). Idle, interrupted runs restart with fresh rendition generations on reuse; completed inactive output can remain cached until eviction. The limit includes brief bootstrap runs as well as continuous encoders.

Compatibility output uses frame-aligned segments near two seconds, produced by a continuous encoder. AAC is retained across segment boundaries and pause/resume. A private loopback HTTP sink withholds upload permission beyond the shared playhead (plus two segments while playing). Paused playback permits the target, preceding preroll, and a bounded fragment-zero bootstrap; seeks near a segment end may also decode one following fragment. Playlists advertise the shared start position for late joins. Seeks create a new stream generation, cancel old output, and reclaim retired files; clients must use the new compatibility URL. Output is H.264 High/Level 4.1, YUV420/AAC, at most 30 fps and 1920×1080 without upscaling, with HDR-to-SDR tone mapping. Direct playback retains the original source resolution.

`session-state` also includes `playbackRevision` and `streamGeneration`. Playback commands include `mediaVersion`, `playbackRevision`, and an increasing per-connection `commandSequence`. An authorized seek advances the revision and broadcasts an acknowledgement to all clients, including its sender, with `seekSequence` matching the command and `commandClientId` identifying its sender. Match both fields when acknowledging pending local seeks; a newer revision from another participant supersedes older pending intent. Hold host ticks until the latest acknowledgement. Ticks from an older revision are rejected. Legacy commands without these fields remain accepted subject to permissions. Native HLS recovery seeks are local events and must not be sent as shared commands. Encoder recovery also advances the compatibility generation, preserving the room clock.

## Viewer permissions

Click a name in the chatroom's Participants list to open its dropdown. Everyone can inspect Play/pause, Seek, and Playback speed permissions; only the host can edit a connected viewer. The dropdown closes on another name, an outside click, or Escape. There is no separate permissions panel below the player. Role messages and participants in presence/party snapshots include effective `permissions: { playPause, seek, playbackRate }`.

Only the current host can send:

```json
{ "type": "set-viewer-permissions", "clientId": "viewer-client-id",
  "permissions": { "playPause": true, "seek": true, "playbackRate": false } }
```

All three values must be booleans, with no additional permission keys. The target must be a connected viewer in that room. Include a `requestId` to correlate UI updates. Success broadcasts `{ type: "permissions-updated", clientId, requestId, permissions }` for each affected connection. Connections from the same browser profile share room grants. Invalid requests return `{ type: "error", action: "set-viewer-permissions", clientId, requestId, message }` to the requester.

Defaults are play/pause enabled, seeking and playback speed disabled. Hosts always have full control. The server checks every viewer command: `play`/`pause` require `playPause`, `seek` requires `seek`, and `rate` requires `playbackRate`; viewer ticks and other modes are rejected. A viewer's command cannot modify other playback properties. Accepted commands are echoed to all room clients. Denied commands receive `{ type: "playback-rejected", commandSequence, message, state }`, where `state` is an authoritative session snapshot with `syncMode: "correction"`; clear matching pending intent and restore shared playback.

Grants survive disconnects, renaming, explicit leave/rejoin, media changes, and another host taking over. They are cleared for a browser when it becomes host, and for the whole room on expiry or server restart. A host who transfers control receives default viewer permissions. The persistent browser cookie survives explicit leave; room membership does not. Clearing cookies, another browser profile, or browser-enforced cookie expiry produces a new identity.

## Participant moderation and host transfer

Hosts can send `{ type, requestId, clientId }`, with `type` equal to `block-participant`, `unblock-participant`, or `transfer-host`. `requestId` must be nonempty text of at most 100 characters. Success returns `{ type: "participant-action-complete", action, requestId, clientId }`; errors return `{ type: "error", action, requestId, clientId, message }`. Only the current connected host may act. Blocking/transferring requires a connected viewer in this room; self/host blocking is rejected, including blocking another tab from the host's own browser identity.

Presence and party snapshots include `connected`, `blocked`, and `suppliesVideo` for participants. A blocked entry retains its last name, permissions, and client ID, stays dimmed/crossed out, and has an Unblock action for the host. It is excluded from the online count and cannot receive permissions or host ownership. Unblocking removes its offline entry and preserves grants; the viewer must manually rejoin. Blocks follow the existing browser identity, affect all matching tabs, survive host changes, and expire with the room or server. Names are never used as credentials.

Blocking closes the viewer's control/source sockets and active media responses. A `room-blocked` notice precedes close code **4003**; stop automatic reconnection and return to room selection. HTTP room admission/media requests return **403** with `{ code: "ROOM_BLOCKED", error }`, and socket upgrades return 403. Private memberships are revoked and must be reacquired after unblock. `GET /api/session` provides default-room admission preflight; private rooms use their existing session endpoint. Room creation and access to other rooms remain available.

Transfer demotes the old host, promotes the target, advances `playbackRevision`, sends role messages to both, and broadcasts `session-state` with `syncMode: "host-transfer"`. Clear pending commands from the previous revision. The source, media version, compatibility generation, pause state, rate, time, and caption selections are preserved. Session snapshots include `sourceId` and `sourceOwnerId`; these are metadata, never attachment credentials. The original provider keeps answering declared byte reads after becoming a viewer. A host change does not clear File objects or relay connections. If the provider leaves, refreshes, loses its connection, or is blocked, the current video becomes unavailable and the host can select a replacement.

## Caption changes during playback

`session-state` includes `mediaVersion`. Each caption has a stable `id`, URL, label, language, format, optional source `fileId`, and a `fonts` array of room-scoped attachment URLs. Descriptors also carry an optional stream `title` and boolean `default`/`forced` dispositions. Stream titles (then handler names) supply labels, with “Captions N” as the fallback; external labels remain filenames. Language codes are preserved even when several tracks share a language. Clients accept older descriptors without these fields. The selected track's content, fonts, and renderer start preparing when descriptors arrive, independently of video readiness. Player notices and native CC/Settings/context subtitle menus reflect preparation, readiness, and failure. A caption failure does not invalidate video readiness. Hosts add files through these native surfaces; picker cancellation preserves selection and captions, and late picker results after source/host changes are ignored. Valid external files are accepted regardless of matching video/subtitle filenames and use the video clock without automatic alignment. Caption removal remains supported by the protocol for compatibility.

- Add: `{ type: "captions-add", requestId, sourceId, files: [fileMetadata] }`. Retain the newly declared browser files on the same data connection. One batch accepts up to eight files, with at most 16 active tracks including embedded captions.
- If the current host is not the video provider, first send `{ type: "caption-provider-register", requestId, sourceId, files }`. The host alone receives `caption-provider-registered` with `providerId`, `sourceId`, single-use `token`, and `relayPath`. Attach a separate data socket using `{ type: "source-attach", sourceId, providerId, token }`, then send `captions-add` with that `providerId` and the same file metadata. Requests/replies use the existing bounded byte protocol and cannot satisfy another provider's reads. After normalization the server releases these files and closes the temporary relay; its loss never clears the video. Initial/video-provider captions retain the original flow.
- Remove: `{ type: "caption-remove", requestId, sourceId, trackId }`. Both embedded and added tracks may be removed.
- Success acknowledges `captions-managed` with the caller's `requestId`. Failure sends an `error` with that ID. Failed additions do not alter the active list.
- Successful edits broadcast `{ type: "captions-updated", mediaVersion, captions }` to that room. Ignore stale generations. Do not change the video source, playback time, pause state, or encoded segments.
- Preserve each viewer's selection by track ID, including Off. Removing the selected track switches that viewer to Off; additions never override their choice.
- `source-release-file { sourceId, fileId }` instructs the file's provider to release an unused sidecar `File` object only for that source generation. `source-ended { sourceId }` releases that provider's files and sockets for an invalidated source. A role change alone releases neither.

The player provides Choose Video, Add captions, and Remove selected caption. The last action removes the host's currently selected track for the room; caption selection and Off live in Movi's Captions control and remain local to each viewer. JASSUB renders normalized ASS inside Movi's public overlay/renderer interfaces.

## Lifecycle and configuration

One membership has one active control socket. A reconnect replaces it; replacing the video provider's socket clears its browser source. Host departure promotes a connected viewer and preserves media if its provider remains connected. Provider departure clears media, independently of host ownership. A failed temporary caption relay only cancels its own reads. Heartbeats clean up dead sockets.

The video provider must keep the page open and connected, including after transferring host. Refreshing loses File objects; browser/mobile suspension can interrupt file reads. There is no installed helper, full-file staging, or background hosting service.

Rooms are in memory, expire after 30 minutes without control connections (including rooms whose creator never connects), and disappear on restart. Source sockets, pending reads, encoding/subtitle jobs, memberships, and temporary files are cleared on departure/expiry/shutdown. The default room does not expire.

`createApplication({ config })` supports `roomIdleMs`, `sourceReadTimeoutMs`, `sourceChunkBytes` (default 256 KiB; do not exceed the browser's 256 KiB response limit), and `sourceMaxReads` (default four), primarily for deterministic testing. Encoder detection is shared, but streams, clocks, jobs, and caches are independent. The old `/api/select-video` returns `410`; native server dialogs have been removed.
