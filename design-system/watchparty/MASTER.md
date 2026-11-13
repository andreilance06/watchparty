# WatchParty design system — proposal

Status: foundations, social actions/permissions, player page, and hub redesign implemented. Updated: 2026-11-14. See [watch-page overrides](pages/watch.md), [hub overrides](pages/hub.md), and [implementation and validation](IMPLEMENTATION.md).

## Direction

**A shared cinema with a welcoming lounge.** Preserve the existing violet identity, logo, dark surfaces, room previews, and video-first composition. Make controls, status, and social features easier to discover. Keep the existing light theme as a first-class option.

Product: a responsive web app for friends, classmates, and small groups watching a host's local video. Stack: React 19, Vite, Tailwind 4, specialized CSS, and a Movi player adapter.

Principles:

1. The video has the highest visual priority once playback starts.
2. Every important action is discoverable through a visible, named control.
3. Explain who controls playback and whether the room is connected.
4. Keep chat drafts, votes, and navigation state stable through responsive changes.
5. Use one shared component language across the hub, room, and settings.

## Color tokens

Use primitive palette values through semantic roles, then component roles. For example: violet palette → action background → primary button background. Components should not choose arbitrary colors. Existing CSS variables can remain aliases during migration.

| Semantic role | Dark | Light | Use |
| --- | --- | --- | --- |
| canvas | #0B0D12 | #F4F2F8 | Page background |
| surface | #12151D | #FFFFFF | Cards and panels |
| surface-subtle | #181C26 | #F8F6FC | Inputs and grouped content |
| surface-raised | #202532 | #ECE9F3 | Popovers and selected surfaces |
| text-primary | #F5F7FB | #211D2B | Titles, messages, field values |
| text-secondary | #A8B0C2 | #625D70 | Help, metadata, placeholders |
| border-subtle | #292F3D | #DED9E8 | Decorative dividers and card edges |
| border-control | #778197 | #82798F | Boundaries needed to identify inputs or controls |
| action-primary | #6D4AE6 | #6441D9 | Primary button fill |
| action-primary-hover | #7957EE | #5735C6 | Hover fill |
| action-primary-pressed | #5B38CE | #4B2AB5 | Pressed fill |
| on-action | #FFFFFF | #FFFFFF | Primary button text/icons |
| text-brand | #B9A7FF | #513BB0 | Links and selected text |
| focus-ring | #B9A7FF | #6441D9 | Focus outline, separated from the control |
| text-success | #36D399 | #126B4B | Successful status plus icon/text |
| text-warning | #F5C36B | #805000 | Attention plus icon/text |
| text-danger | #FF8296 | #B42343 | Errors and destructive labels |

Separate action fill from brand text; a single accent token cannot safely serve every role. Never use border-subtle as the sole identifying boundary for a form field. Meaningful icons and control boundaries target 3:1; ordinary text targets 4.5:1.

Measured solid-color pairs using the WCAG relative-luminance formula:

| Pair | Ratio |
| --- | --- |
| White on dark primary / hover | 5.57:1 / 4.76:1 |
| White on light primary | 6.36:1 |
| Dark primary / secondary text on surface-raised | 14.27:1 / 7.04:1 |
| Dark brand text on surface-raised | 7.31:1 |
| Light secondary text on surface-raised | 5.28:1 |
| Dark control border on surface-subtle | 4.36:1 |
| Light control border on white | 4.13:1 |

These checks validate listed pairs, not the whole interface. Measure all rendered states, alpha blends, scrims, and video overlays during implementation. Keep the video canvas black in both themes. Use opaque badge surfaces over previews so image variation cannot undermine readability.

## Typography

Retain the current system sans-serif stack for speed and familiar rendering. Inter is a compatible future option, but a new font dependency is unnecessary for this redesign.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Hub display | 32–48px / 1.1 | 700 |
| Page title | 24–32px / 1.2 | 700 |
| Section title | 20px / 1.3 | 600 |
| Card title | 16–18px / 1.35 | 600 |
| Body, messages, input values | 16px / 1.5 | 400 |
| Control label | 14px / 1.4 | 600 |
| Secondary metadata | 14px / 1.5 | 400 |
| Compact timestamp or badge | 12px / 1.4 | 500 |

Avoid essential instructions below 14px. Use tabular figures for playback timers and counts. Titles and user names wrap where possible; URLs and long filenames use overflow-wrap:anywhere in shrinkable containers. Where truncation is necessary, provide full content on keyboard focus and pointer interaction; a title attribute alone is insufficient. The page title is the h1; the linked brand is not the h1 on every screen.

## Layout and geometry

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64px. Use 8px between neighboring actions, 16–24px inside cards, and 24–32px between major groups.
- Radius: 8px compact elements, 12px controls, 16px panels/dialogs, full radius for status badges only.
- Icon sizes: 16, 20, 24px, consistent 1.75px SVG stroke. Keep the existing logo. Replace emoji used as a picker-control icon with an SVG smile; emoji remain valid message and reaction content.
- Elevation: flat panels; one restrained popover shadow; one modal shadow. Do not highlight noninteractive panel borders on hover.
- Layer roles: content 0, sticky header 10, anchored disclosure 20, floating feedback 30. Native modal dialogs use the browser top layer. Fullscreen overlays must mount inside the fullscreen root.
- Hub maximum width: 1280px. Room maximum width: 1500px. Gutters: 16px on small screens, 24px from 768px, 32px from 1440px.
- Shared responsive thresholds: 768px and 1100px, with 1440px for wider gutters. Test 375, 768, 1024, and 1440px plus short landscape viewports. Treat these as design targets, not device detection.
- Hub cards: one column below 768px, two below 1100px, three above. Keep previews at 16:9 and reserve image dimensions.
- Room at 1100px and above: video + 360–400px lounge; preserve at least 600px for the video column. Below that: video above the lounge. Keep Chat and People as local lounge tabs, not global navigation.
- Mobile: compact the room bar and now-playing metadata. Once a video is active, make Replace video secondary and collapse the long sharing instructions behind an accessible disclosure. Keep a short visible reminder for the video provider.
- Reserve space for fixed elements and respect visualViewport changes when the keyboard opens. Keep the composer visible while the user is interacting with chat. Avoid adding a sticky video until landscape and keyboard behavior are verified.

## Component contract

| Component | Required behavior |
| --- | --- |
| Button | Primary, secondary, quiet, danger variants; default, hover, pressed, focus, pending, disabled states. Target 44px minimum control height across the web product. Do not shrink the hit area with the icon. |
| Primary action | Hub: Create room is the global primary action; Join room is local to its card. Empty host room: Choose video. Active room: Invite; Replace video becomes secondary. Send remains a consistent local composer action. |
| Form field | Persistent visible label, helper text, required/optional indication, connected inline error, invalid semantics. Keep entered data after failure. |
| Room card | Preview, room name, video title, participant count, access badge, Join action. Waiting and unavailable-preview states stay distinct. Mark only the chosen room as Joining… while preventing duplicate submissions. |
| Status | Text plus optional icon; never color alone. Neutral pending, success, warning, error variants. Use polite announcements for routine updates; urgent errors get an appropriate alert. |
| Chat message | Visible Message actions control, also available on focus. Keep context menu and long-press as shortcuts. Reply quote, reactions, and timestamp remain readable. Preserve scroll when reading earlier messages; expose Latest messages. |
| Composer | Visible Message label; input, emoji picker, Send. Show Sending… while pending. Keep draft on disconnect or failure. Explain permission restrictions beside the composer. |
| Poll summary | Named Vote on next movie action, leader, contextual vote count, expanded state. Starting a poll is visible to authorized users in the lounge header. Finish poll is secondary and separated from voting. |
| Poll details | Visible search label, pending/search failure/no-match states, title-only fallback, suggestions, selected vote. State clearly: a poll chooses a title; the host still selects the file. |
| People | Name, You, Host/Viewer, connection state. Quick participant details stay compact; detailed permission editing opens a properly sized dialog rather than placing 19 settings in a narrow popover. |
| Permission setting | Grouped fieldsets and legends. Individual state explicitly reads Room default: On/Off or Custom: On/Off, with Reset to room default. Save immediately, show pending, acknowledge success or revert and explain failure. |
| Modal | Named dialog, initial focus, contained modal focus, close/cancel, Escape, and focus return. Keep the close control available when long settings scroll. Preserve native dialog behavior. |
| Consequential action | Confirm host transfer and Kick and block with person name and consequence; explicitly warn when blocking stops the shared video. Keep routine leaving lightweight unless leaving stops the supplied video. |

Use the same button/field/status foundations everywhere instead of separate hub, poll, chat, and permissions visual implementations. Map the player accent at the adapter boundary; do not edit the vendor bundle.

## Feedback and motion

- Feedback must appear promptly. Use 120ms for hover/pressed state changes, 180ms for disclosures, 220ms for modal entry and 140ms exit; these are initial tokens to validate, not mandatory delays.
- Animate opacity and transforms only. Playback must never wait for an animation to complete.
- Reduced motion removes floating travel, scale effects, and decorative movement while preserving status text and reaction acknowledgments.
- Use explicit states: Connecting → Connected → Reconnecting → Disconnected, with recovery instructions when needed. Keep room connection separate from playback readiness and caption/quality preparation.
- Important errors persist with a recovery path. Transient confirmations may clear after 3–5 seconds without moving focus.
- Initial room loading uses reserved card placeholders; refresh failure preserves existing rooms and explains that the list may be out of date. No-room state offers Create room.
- Error messages identify the affected field. After failed submission, focus the first invalid field, or a linked summary for multiple errors. Do not color neutral progress as an error.
- Avoid repeated screen-reader announcements from unchanged poll totals, directory refreshes, and participant lists. Announce a complete contextual phrase when a value changes.

## Screen outlines

**Hub:** compact shared header with name editor → concise introduction and Create room → searchable room directory → room cards → privacy information. The create form explains before submission that a password restricts joining while room names and previews remain visible in the directory.

**Desktop room:** room title/editor and connection, direct Invite/Permissions/Leave actions → video with filename/provider status beside the chatroom → display name/editor and poll action → Chat/People/Up next tabs with contextual badges → active panel. Chat has a compact composer; polls live in Up next without squeezing the conversation.

**Mobile room:** compact header → room name/editor and actions → 16:9 video → filename/action row → the same chatroom header and Chat/People/Up next tabs → active panel and compact chat composer. The host's initial Choose video remains prominent; replacement controls get less emphasis once watching starts.

**Settings:** clear title and scope → grouped permission controls → inline pending/error feedback. Individual permission editing states whose settings are being changed and whether they inherit defaults.

## Implementation sequence after acceptance

1. Introduce semantic tokens and shared button, field, status, and dialog styling; fix contrast in both themes.
2. Add field-linked errors, discoverable message/poll actions, moderation confirmations, and clear inheritance states.
3. Simplify the mobile room hierarchy and unify responsive rules without remounting the chat or player.
4. Consolidate superseded CSS rules and align player-shell styling through supported adapter hooks.
5. Verify representative host/viewer, connection, media, poll, and permissions states in a real browser.

Acceptance checks: full keyboard entry/join/chat/vote/settings journey; modal focus and return; 200% zoom; 375px portrait and short landscape; keyboard-open composer; long room/user/video names; both themes; reduced motion; contrast for all control states; no horizontal page overflow; previews reserve space; existing room/player lifecycle and media tests still pass. Measure loading and playback performance rather than inferring it from screenshots.

## Skill research and interpretation

Read `.agents/skills/ui-ux-pro-max/SKILL.md`. Searches ran with Python 3.14.7 using `py`:

- `social video watch party dark --design-system`: returned Feature-Rich Showcase, Vibrant & Block-based, rose/blue, and a crypto-oriented font description. Rejected as insufficiently matched to this existing watching interface.
- Narrowed once to `video streaming cinema --design-system`: returned Dark Mode (OLED), cinema palette, and Inter. The dark/content-first direction fits; its marketing hero layout, red rebrand, and light-mode discouragement do not fit the existing product. No fully matching application layout was found; layout and retained violet palette above are tailored design judgment.
- `dark mode OLED --domain style`: verified active `dark-mode-oled` category; used restrained surfaces and visible focus guidance. Decorative glow is unnecessary; power/comfort benefits are not asserted for this implementation.
- `keyboard focus modal --domain ux`: Focus States and Focus Not Obscured results fit disclosures, dialogs, and sticky UI.
- `error summary validation --domain ux`: Focusable Error Summary and Error Placement results fit admission/profile/search forms.
- `accessible forms focus --stack react`: focus-management guidance fits React 19. Existing native dialogs and controlled fields already provide a useful foundation.

This document is a curated proposal, not a verbatim generated system or an accessibility certification. Detailed evidence and review limitations are in REVIEW.md. Page overrides should only be added for intentional deviations from this master.
