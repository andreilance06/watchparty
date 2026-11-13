# WatchParty design system implementation

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

## Current previews

- Hub: [dark desktop](hub-redesign-desktop.png), [dark mobile](hub-redesign-mobile.png), [light mobile](hub-redesign-light.png).
- Player: [dark desktop](player-current-desktop.png), [dark mobile](player-current-mobile.png), [light desktop](player-current-light.png).
- Dialog examples: [individual permissions](individual-permissions-mobile.png), [block confirmation](block-confirmation-mobile.png), [host transfer](transfer-confirmation-light.png).
