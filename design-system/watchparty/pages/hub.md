# Hub page

Implemented 2026-11-14. This page overrides the older hub outline in MASTER.md and shares the player page's semantic palette, system font, SVG icons, shared controls, and native dialogs.

Palette update 2026-11-17: the current MASTER.md uses burgundy #790D16, sand #E5D3AF, ivory #F5EFE1, and blue #AEC4D4. Light mode uses ivory canvas, sand controls, burgundy actions, and blue count badges; dark mode uses warm charcoal/rose/ivory/blue roles. Earlier violet research is historical and does not override these tokens.

## Hierarchy and behavior

- Compact brand header with theme control and the current name. The name/pencil button opens Edit display name with a labeled optional field, Save, Cancel, initial field focus, and focus return. Save persists the local preference; leaving it blank uses the existing guest-name behavior when joining.
- One h1, Watch together, one explanatory sentence, and one primary Create room action. Remove decorative eyebrow labels, repeated introductions, the large permanent profile form, and the repeated footer tagline.
- Rooms heading and contextual count, followed by a labeled search field. Search matches room names and video filenames locally and preserves its query during directory refreshes.
- Browsing toolbar: six native sort choices (most/fewest people, name A–Z/Z–A, newest/oldest), a Filters disclosure with an active count, and Cards/List buttons with pressed states. Filters combine Access (all/open/protected) and Video (all/selected/waiting) with search. A selected video is a nonempty filename, not an assertion that playback is running. Narrowed results show X of Y rooms and Clear all, which resets search/filters while retaining sort/layout.
- Default to cards and most people first. Remember only valid layout/sort preferences in browser storage; search and filters reset on reopening. Preserve selections across directory refreshes and retry. Sort ties use case-insensitive room name then ID. Creation timestamps come from the directory API; missing/invalid timestamps sort last in both recency orders. The default room is not pinned.
- List view reuses the same keyed room components and Join actions, with small 16:9 previews, wrapping text, access labels in the body, and participant counts. Keep the chosen view on mobile. Initial placeholders also follow the chosen layout.
- Cards reserve a 16:9 preview. Distinguish Waiting for a video from Preview unavailable; use the existing video thumbnail when available. Password-protected rooms carry a solid, readable badge. Room names and filenames wrap instead of relying on hover-only disclosure. Each card has participant count and a named Join room action; only the selected room shows Joining while other entry actions are disabled.
- The create dialog explains local video selection and public room metadata before submission. The join dialog focuses the password field, connects errors to it, retains the password after rejection, and supports retry. Existing invitation, admission, cancellation, and room-expiry behavior is preserved.
- Initial loading reserves card placeholders. Empty directory, no search results, blocked/expired invitations, and refresh failure have distinct feedback. Refresh failure retains previously fetched rooms and offers Try again. Keep directory privacy information visible; omit implementation-oriented refresh-interval copy.

## Layout and accessibility

- Maximum width 1280px; 32px desktop, 24px tablet, and 16px phone gutters. Three card columns at 1100px+, two at 768–1099px, one below 768px. Heading/actions stack on phones. Header can wrap for enlarged text and long names.
- Semantic theme tokens, 16px input text, 14px supporting text, 44px minimum controls, visible focus, skip link, one h1, and associated form labels. Counts are contextual for screen readers. Search results announce a complete phrase without moving focus.
- No decorative animation, remote fonts, image-generation assets, or new packages. Reduced motion continues to use the shared tokens.

## Research and interpretation

The requested skill's `social video streaming room directory --design-system` returned Feature-Rich Showcase / Vibrant & Block-based. Its marketing sections, rose rebrand, and font pairing do not match this existing application. The single narrower retry, `video streaming cinema --design-system`, returned Dark Mode (OLED), Inter, and a hero-centric marketing structure. The restrained cinema direction fits; the full-bleed marketing hero, red palette, and light-mode discouragement are not applied. No matching directory layout was found; the hierarchy above uses the skill's Quick Reference and product-specific judgment, retaining the established violet design system and both themes.

## Validation

Room browsing update: 65 UI tests, 9 room/API tests, and the production build passed. New coverage includes all sorting choices, combined search/filters, timestamp fallbacks and stability, immutable directory data, preferences/storage failures, refresh preservation, resets, and open/protected joining in both layouts. Chromium verified combined access/video filters, newest sorting, reload restoring layout/sort while clearing filters, dark/light list layouts, and card/list controls at desktop, mobile, tablet, and landscape widths. The 375px list also passed doubled text sizing; sampled controls stayed at least 44px high without horizontal overflow. No browser console errors were found.

51 UI tests and production build passed. New tests cover room/video search, clearing no results, editing and cancelling the name preference, persistence, and focus return. Existing tests cover protected-room password retry, whitespace validation, expired invitations, refresh retry, StrictMode cleanup, and unavailable browser storage.

Local Chromium confirmed name saving/focus return, actual room creation using the saved name, and protected-room admission from an isolated browser. Inspected dark desktop and dark/light mobile captures. At 375×812, 768×1024, 812×375, and 1440×900 with reduced motion, the directory used the expected columns and had no horizontal page overflow or controls below 44px height. The 375px check also passed with doubled root text size. The final hub console had no errors. These are desktop browser emulation checks, not physical-device certification.

Previews: [desktop](../hub-redesign-desktop.png), [mobile](../hub-redesign-mobile.png), [light theme](../hub-redesign-light.png).
