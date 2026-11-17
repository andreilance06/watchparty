# WatchParty design system implementation

Live screen/tab shares now render through Movi's `srcObject` API, using the same playback, volume, and fullscreen controls as files. The separate video overlay is removed. Live mode hides seeking, speed, file quality, captions, and file-only indicators, blocks seek gestures/shortcuts, and keeps transport changes local. Source replacement restores permitted file controls and the prior mute preference. `js/player/live-stream.js` isolates Movi 0.4.1's stream-source detection hook; the vendor bundle remains unchanged. Validation: 89 UI/client tests, 65 targeted server/player tests, production build, and a two-context generated-stream WebRTC check covering live decoding, seek/rate guards, native theater fullscreen with chat, and file replacement with tracks/peers released.

The capture provider now has Settings → Screen sharing with staged Resolution and Frame rate choices, Apply/pending states, inline errors, and reported capture quality. Changes use the existing track for all peers; options follow capture capabilities. Native Settings navigation, light/dark themes, and scrollable compact sheets are retained. Empty section headings are removed in live and file menus. Validation: 95 UI/capture tests, 82 player/quality regressions, and production build. Browser QA applied native canvas-track constraints for 720p/15 fps and 1080p/60 fps while a WebRTC viewer stayed connected, verified light/mobile controls, and restored file Settings after replacement. Native OS capture/platform behavior still requires device-specific validation.

The reaction bar, preset editor, ready checks, countdowns, and readiness badges have been removed. Obsolete reaction presets are cleared on startup. Chat reactions, movie polls, playback, and the paired palette remain. Earlier dated sections below preserve implementation history.

Removal validation: 69 UI tests and 109 targeted server/player tests pass; the production build succeeds.

The player now uses the [theater layout](pages/theater.md): edge-to-edge video with a collapsible right-side chat dock, a persistent unread-aware edge toggle, and the same dock in fullscreen. Chat stays mounted through toggles and fullscreen; phone portrait stacks it below the picture. Latest theater validation: 71 UI tests, 41 player/chat regression tests, production build, and browser review of both themes, native fullscreen, portrait, landscape, and reduced motion.

The dock is now resizable with drag/keyboard controls and persisted width/open state. Room identity and connection share the logo bar; invite and host permissions are icons beside the display name. The separate room bar and Leave room action are removed. Latest validation: 73 UI tests, 41 player/chat regression tests, production build, and browser checks of dragging, reload persistence, compact mobile layout, and fullscreen permissions/focus return.

The edge expand button now also handles resizing, tucks away until hover/focus, and suppresses collapse after a drag. Name editing is inline with a checkmark and Escape cancellation; the pencil sits directly beside the name. Tab counts stay grouped with their labels at narrow widths. Latest validation: 74 UI tests, 41 player/chat regression tests, production build, and browser checks of hover/drag, inline save/focus, 280px badge alignment, touch, and reduced motion.

Room-name editing now also uses an inline textbox/checkmark in the logo bar. Host-only access, server acknowledgment, rejected draft retention, Escape cancellation, and focus return remain; mobile editing frees space within the same bar. Validation: 75 UI tests and production build, plus a browser-confirmed rename through the checkmark.

Clicking the logo during video now asks for leave confirmation, with an explicit room-wide playback warning for the supplying browser. Cancellation preserves the session and returns focus; confirmed departures acknowledge the leave request before disconnecting/navigation, with pending protection and retryable errors. Validation: 78 UI tests and production build.

Logo and Browse rooms share that confirmation. Connected video providers now also receive a native refresh/tab-close warning; cancelling preserves their stream, and a successful confirmed in-app leave bypasses duplicate native prompting. Listeners follow ownership and are removed when no longer needed. Validation: 83 UI tests and production build. A browser refresh test dismissed the native warning and verified the same document, connected session, and shared clip remained intact.

Share screen now sits beside Choose/Replace video and switches to Stop sharing during capture. Screen/window/tab streams and optional display audio use WebRTC with room-authorized signaling, existing selection permissions, late joins, retry, and cleanup on source changes/departure. The same theater/chat layout supports live streams. ICE/TURN configuration and browser requirements are documented in [screen sharing](../../docs/screen-sharing.md). Validation: 89 UI/client tests, 64 targeted server/player tests, and production build. A real two-context WebRTC test decoded generated 960x540 frames plus an audio track, verified fullscreen chat, stopped all tracks/peers, and replaced the live source with file playback. Native OS picker/platform audio and deployed TURN paths remain device/deployment-specific checks.

The hub and player redesign is implemented. [MASTER.md](MASTER.md) defines the shared tokens and component contracts; [hub](pages/hub.md) and [watch](pages/watch.md) define the final page behavior. [REVIEW.md](REVIEW.md) preserves the historical audit that led to this work.

## Final implementation

- Shared primitive, semantic, and component tokens cover both themes, readable text, input boundaries, action states, focus, spacing, radius, and motion. Primary text/fill contrast and control boundaries have regression checks.
- Shared buttons, inputs, fields, statuses, native dialogs, and stroke SVG icons serve both pages. Dialogs support initial focus, pending cancellation protection, Escape, linked errors, and focus return.
- The hub has a compact name editor, one Create room action, room/video search, wrapping room titles, stable preview geometry, password badges, and per-room joining feedback. Loading, empty directory, no matches, admission failure, expired invitations, and refresh retry have distinct states.
- The player has a room-title pencil for host-only renaming, direct invitations/permissions/leaving, display-name editing on request, and persistent Chat/People/Up next panels. Circular tab badges show participant and unread counts. The compact composer retains its screen-reader label and visible reply/error/restriction feedback.
- Chat actions are available through visible Reply / react controls as well as keyboard/context shortcuts. Movie polls live under Up next, with a compact invitation in Chat. Individual permissions distinguish inherited defaults from custom overrides and provide resets. Host transfer and blocking use explicit confirmations, including video-provider consequences.
- The player adapter retains stable media and portal containers through tabs, themes, and fullscreen. Captions, quality negotiation, file relay, and vendor lifecycle remain owned by the existing media modules.
- The room-name command validates current-host authorization and the existing 80-character limit, broadcasts room metadata, acknowledges saves, and persists the in-memory name for directory/admission/reconnect responses.

## Repository cleanup

Removed the unused React footer, obsolete UI selectors and layout files, and superseded design captures. Legacy media fixtures, their required styles, vendor distributions/licenses, deployment assets, and existing progress-report deliverables remain. IDE files are ignored and untracked while preserved locally. npm and Bun lockfiles are retained; Bun was regenerated from npm without dependency upgrades. Node.js 24 remains the runtime.

## Validation

- Production build passed. Both npm and Bun frozen/dry-run lockfile checks passed; package.json and package-lock.json were unchanged during synchronization.
- Backend/media: 390 passed, 1 skipped, 0 failures or cancellations with test files serialized. The skip is the NVIDIA HDR/libplacebo capability case; CPU HDR fallbacks passed. An initial parallel run timed out in the existing NVIDIA streaming test; the isolated test and complete serialized run passed without changing tests or runtime behavior.
- UI: 51 tests passed, including hub entry/search/name editing, shared controls, permissions/moderation, room renaming, tab/draft preservation, and theme contrast relationships.
- Local Chromium verified the generated video playing to completion, chat sending, stable player/chat elements and unsent drafts across tabs/fullscreen, provider-leave cancellation, invitations, and focus return. Earlier entry, password retry, themes, and responsive checks are summarized in the page specifications. Screenshots are development fixtures rather than product assets.
- Browser emulation does not establish physical-mobile keyboard or cross-browser decoding behavior.

## Shared moments update — 2026-11-17

- Added room-owned ready checks and a five-second shared countdown for starting and resuming video. Host-managed checks, individual readiness, safe early-start confirmation, cancellation, reconnection, media changes, and stale playback revisions are covered. Explicit host controls now echo confirmed state so another ready check is available after pausing.
- Added compact React controls with quick choices, full search, a local live-reaction visibility preference, bounded effects, reduced-motion static feedback, and permission/cooldown enforcement. Shared popover behavior serves message emoji and live reactions. Party controls remain available through the existing fullscreen portals; blocked autoplay exposes a local Join playback action.
- Fixed the missing `/source` WebSocket proxy in Vite, discovered while validating a generated video in the default room.
- Validation: 76 UI tests and the production build pass. The serialized full server/media suite passed 402 tests with one existing NVIDIA HDR/libplacebo capability skip. Subsequent targeted regressions passed 109 tests, and the final party/integration/hosting/message/room/player check passed 49 tests after the remaining refinements.
- Two isolated Chromium participants played a generated clip after the same countdown, including fullscreen. Verified early-start confirmation, focus transitions, readiness after pausing, sending/hiding reactions, reduced motion, and mobile light-theme rendering. Sampled 375px portrait, 812px landscape, desktop, and 768px with doubled root text showed no horizontal overflow or party buttons below 44px. A clean reload had no browser console errors.
- Existing stored previews below show the earlier redesign; browser captures for this update were temporary validation artifacts. Browser emulation does not establish physical-device keyboard behavior or all browser autoplay policies.

## Current previews

### Floating reaction bar — 2026-11-17

- Replaced the chat-header reaction launcher with a 262 × 54px in-player toolbar containing four direct-send presets and an Edit control. It follows player chrome, stays visible during hover/focus/editing, and works independently of fullscreen chat visibility. Narrow fullscreen layouts reserve text-scaled rows for the chat toggle, bar, and conversation.
- Added personal preset editing with four preview slots, searchable/batched emoji choices, duplicate swapping, Reset, Save/Cancel, focus return, and draft effect visibility. Preferences persist in browser storage; invalid settings use defaults, and unavailable storage keeps edits for the current visit. Existing wire messages, permissions, cooldowns, and reduced-motion effects are reused.
- Validation: 93 UI tests, 65 player/social/backend regressions, and production build pass. Contrast checks include the near-opaque reaction surface over black/white video extremes. Browser review covered desktop dark, 375px light, preset saving, fullscreen sending with chat hidden, landscape, and enlarged text. Sampled controls meet 44px targets with no horizontal page overflow; a text-size collision found in review was corrected with relative offsets. No browser console errors were observed. Physical mobile keyboards remain outside emulation coverage.

Later dated refinements supersede earlier reaction-placement notes in this implementation history. The stored baseline previews predate the current reaction bar.

### Palette and social layout refinement — 2026-11-17

- Applied the supplied burgundy/sand/ivory/blue palette through shared semantic tokens on both pages. Dark mode uses warm charcoal, ivory text, rose actions, and blue accents. Removed remaining violet CSS accents while retaining the logo and black media canvas. MASTER.md contains the current roles and measured contrast ratios.
- Moved live reactions from the playback toolbar into the chatroom header. The same stable portal travels with fullscreen chat; readiness remains with playback. Poll creation now lives under Up next.
- Rebuilt poll entry, voting choices, progressive movie search, details, results/ties, and finishing confirmation. Kept existing wire behavior, permission checks, and chat drafts. Focus follows starting a poll, opening/closing search, confirming the first suggestion, cancelling/finishing, and starting another poll.
- Validation: 79 UI tests, 65 targeted player/social/backend regressions, and the production build pass. Palette tests cover ordinary/selected surfaces, action states, blue badges, focus/control boundaries, and meter contrast. Light action text is 9.73:1, dark action text 5.55:1, and dark hover text 4.78:1.
- The built app was checked with a generated video and a real movie search: hub and watch themes, selected vote, mobile poll confirmation/results, fullscreen reaction placement and restoration, and an empty browser error console. Sampled 375px portrait, 812px landscape, and doubled root text had no horizontal overflow or undersized poll/reaction controls. Physical-device keyboard and all browser media policies remain outside browser emulation coverage.

The stored baseline previews below predate the palette refinement; temporary captures were used to review the new screens.

- Hub: [dark desktop](hub-redesign-desktop.png), [dark mobile](hub-redesign-mobile.png), [light mobile](hub-redesign-light.png).
- Player: [dark desktop](player-current-desktop.png), [dark mobile](player-current-mobile.png), [light desktop](player-current-light.png).
- Dialog examples: [individual permissions](individual-permissions-mobile.png), [block confirmation](block-confirmation-mobile.png), [host transfer](transfer-confirmation-light.png).
