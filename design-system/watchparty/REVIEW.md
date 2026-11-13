# WatchParty UI/UX review

Historical audit, 2026-11-13. This records the pre-redesign interface and original findings; referenced layouts and code may have since been replaced. See [implementation](IMPLEMENTATION.md), [hub](pages/hub.md), and [watch](pages/watch.md) for the final behavior and validation.

## Evidence and limits

Reviewed current React components in `src/`, the active CSS import chain, player-status presentation modules, the README, and the four repository screenshots for the hub, desktop room, mobile room, and permissions. Screenshots demonstrate existing layouts but may predate the current source. Source confirms React/Vite/Tailwind with layered specialized CSS; current rules, not old screenshot details, determine the findings below.

No live-browser interaction, keyboard journey, screen-reader, rendering, zoom, or performance testing was performed. Mobile recommendations are supported by the supplied 390px screenshot and source structure, not a new responsive test. Light-theme findings come from source values and contrast calculations, not a light-theme screenshot. Treat potential focus/overflow problems as verification needs rather than confirmed runtime failures.

## What works

- Consistent recognizable violet identity, restrained dark surfaces, and clear video prominence.
- Hub card previews reserve a 16:9 area, load lazily, and recover when an image fails (`src/Hub.jsx`, `css/hub.css`).
- Shared native dialog uses showModal; inputs generally have labels and keyboard focus styling (`src/shared.jsx`, `src/Hub.jsx`).
- Lounge tabs support arrows, Home/End, and selected state; many main controls already meet a 44px product target (`src/Watch.jsx`, `css/lounge.css`).
- Chat preserves drafts on failed acknowledgments/disconnects and offers a latest-message action (`src/Chat.jsx`).
- Poll search supports no-result/error recovery with title-only suggestions (`src/Poll.jsx`).
- Caption and quality preparation have independent status rows (`js/player/playback-status.js`). Keep that distinction.

## Prioritized findings

| Priority | Evidence | User impact | Proposed response |
| --- | --- | --- | --- |
| P1 | White text on dark #7C5CFF primary fill is 4.35:1; #9175FF hover is 3.39:1 (`css/base.css`, `css/hub.css`, `css/lounge.css`). Light muted #716C7C on raised #ECE9F3 is 4.23:1. | Ordinary labels miss the 4.5:1 target in these pairs. | Separate action fill, readable brand text, secondary text, and focus tokens; use the measured replacements in MASTER.md. |
| P1 | `ParticipantDetails` directly sends transfer-host and block-participant; a warning exists when the person supplies video (`src/Permissions.jsx`). | A misplaced click can remove someone or stop the room's current video. | Confirmation with the person and consequence; preserve the provider warning. |
| P1 | Admission errors are one form-level Status with no field association; profile invalid state lacks a linked error description (`src/Hub.jsx`, `src/Watch.jsx`). | Users hear feedback but may not know which input needs correction. | Inline linked errors, retained values, and appropriate focus after failed submission; summary for multiple errors. |
| P2 | Chat messages expose context-menu, long-press, and Shift+F10, but no visible actions trigger (`src/Chat.jsx`). | Reply/reaction features are easy to miss. Keyboard shortcuts already exist, so this is a discoverability gap, not total keyboard exclusion. | Visible named Message actions control; retain shortcuts. |
| P2 | Start poll is inside Chat options; collapsed polling exposes Expand poll beside Finish poll (`src/Watch.jsx`, `src/Poll.jsx`). | Creating/voting is less discoverable than closing the poll. | Visible authorized start action; rename expansion to Vote on next movie; visually subordinate Finish poll. |
| P2 | The mobile screenshot stacks header, room bar, video, metadata, full-width Choose Video, and help before chat. Current source preserves this structure. | Chat requires substantial scrolling and has limited connection to the video above. | Compact room/provider metadata and demote replacement controls once a video is selected. Validate composer behavior with a real mobile keyboard. |
| P2 | Individual details render all 19 permission controls inside a maximum 288px popover (`src/shared.jsx`, `src/Permissions.jsx`). Reset links say Room default without the inherited On/Off value. | A long, narrow control list makes scope and inheritance difficult to understand. | Compact details plus a dedicated permission dialog; explicit inherited/custom state per setting. |
| P2 | Privacy notice is after the room list; create-dialog guidance only says an empty password lets anyone join (`src/Hub.jsx`). | A host may assume a password also hides the room title and preview. | Explain directory visibility in the create form before submission. Do not imply the existing password hides metadata. |
| P2 | Metadata and instructions use many .65–.8rem sizes (`css/base.css`, `css/lounge.css`, `css/hub.css`). | Small supporting text is harder to read; some essential guidance is visually subordinate. | 16px message/body/input text, 14px supporting instructions, 12px only for compact metadata. |
| P3 | Hub, lounge, poll, permissions, and player controls have separate style families; base/layout/responsive/lounge rules repeatedly redefine shared components. Hub also imports base.css. | Component states and responsive behavior can drift as features evolve. | Shared component contracts, semantic tokens, documented breakpoints, then deliberate consolidation. Do not assume duplicate imports cause visible bugs without checking compiled CSS. |
| P3 | Hub uses one global busy flag to disable all room-card actions (`src/Hub.jsx`). | The clicked room does not show clear card-local progress for an open-room join. | Keep duplicate-submit prevention; show Joining… on the selected card. |

P1 = fix before visual rollout; P2 = core usability improvements; P3 = consistency and maintainability. These priorities do not imply a security audit.

## Proposed outcome

Adopt the existing identity as a calmer shared cinema: accessible violet actions, readable neutral text, shared controls, named social actions, compact mobile watching chrome, and clear permission scope. See MASTER.md for exact proposed tokens, screen outlines, component states, and verification gates.

No application implementation or test changes were made. The new documents are the reviewable deliverable; implementation remains a separate next step.
