# Hub page

Implemented 2026-11-14. This page overrides the older hub outline in MASTER.md and shares the player page's semantic palette, system font, SVG icons, shared controls, and native dialogs.

## Hierarchy and behavior

- Compact brand header with theme control and the current name. The name/pencil button opens Edit display name with a labeled optional field, Save, Cancel, initial field focus, and focus return. Save persists the local preference; leaving it blank uses the existing guest-name behavior when joining.
- One h1, Watch together, one explanatory sentence, and one primary Create room action. Remove decorative eyebrow labels, repeated introductions, the large permanent profile form, and the repeated footer tagline.
- Rooms heading and contextual count, followed by a labeled search field. Search matches room names and video filenames locally, preserves its query during directory refreshes, and provides Clear search for no matches.
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

51 UI tests and production build passed. New tests cover room/video search, clearing no results, editing and cancelling the name preference, persistence, and focus return. Existing tests cover protected-room password retry, whitespace validation, expired invitations, refresh retry, StrictMode cleanup, and unavailable browser storage.

Local Chromium confirmed name saving/focus return, actual room creation using the saved name, and protected-room admission from an isolated browser. Inspected dark desktop and dark/light mobile captures. At 375×812, 768×1024, 812×375, and 1440×900 with reduced motion, the directory used the expected columns and had no horizontal page overflow or controls below 44px height. The 375px check also passed with doubled root text size. The final hub console had no errors. These are desktop browser emulation checks, not physical-device certification.

Previews: [desktop](../hub-redesign-desktop.png), [mobile](../hub-redesign-mobile.png), [light theme](../hub-redesign-light.png).
