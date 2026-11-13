# Watch page — room, screen, and lounge

Implemented 2026-11-13; header and badge refinements updated 2026-11-14. This page overrides the older screen outlines in MASTER.md.

## Product hierarchy

1. Room identity and connection: the room name is the page h1; connection state sits immediately below it. Hosts have an adjacent pencil opening a focused Edit room name dialog with Save and Cancel. Names are validated to 80 characters and saved through a server-acknowledged command. Updates reach everyone in the room and the directory; viewers cannot rename rooms. No decorative section labels above the room or chatroom.
2. Room actions: Invite friends, Room permissions (hosts), and Leave room are directly available. No general Room options menu. Invitations use a named dialog with a labeled, selectable link and clipboard fallback. Leaving confirms when this browser supplies the video.
3. Shared screen: the video leads the composition. Its compact toolbar contains the filename, a plain-language playback summary, and Choose video / Replace video according to the source state. Keep the provider reminder visible; keep encoder diagnostics and extended instructions in Playback & sharing details.
4. Chatroom identity: the current display name replaces the former Good company / The lounge heading. An adjacent pencil icon with a 44px target opens a focused Edit display name dialog with Save and Cancel. The name is plain text until editing is requested. Save is server-confirmed; validation errors stay connected to the field, and disconnection/restriction messages remain visible. Closing returns focus to the pencil; cancellation discards the draft.
5. Chatroom navigation: Chat, People, and Up next use the same tab structure at every width. People carries the participant count in a small circular badge; Chat carries an identical unread-message badge only when there are unread messages. Counts above 99 display as 99+ while accessible names retain the full count. Read messages clear through the existing attention tracking. Selected tabs and drafts survive width changes. Hidden panels stay mounted; the player and conversation never remount because a tab changed.

## Layout

- Desktop at 1100px+: 1500px maximum container, 32px gutters, 24px gaps, flexible video column plus 380px lounge. Compact header and room masthead; composer stays visible in the sampled 900px-tall desktop viewport.
- Below 1100px: room bar, player, then lounge. Tablet gutters 24px; below 768px use 16px. Mobile room-action labels shorten visibly while their accessible names retain their full context.
- Lounge has a stable height and one relevant content scroller: messages for Chat, roster for People, movie suggestions/results for Up next. The composer remains in the chat panel's flex layout. No sticky video or fixed mobile composer competes with the page's natural scrolling.
- The chatroom heading uses 8px top / 4px bottom padding, 12px horizontal insets, and 44px controls. Tabs have a 44px minimum height and 4px vertical padding. This removes 32px of vertical chrome while preserving readable labels and touch targets.
- Fullscreen still moves the same conversation and overlay portal containers into the video shell. Media controls, caption handling, and player lifecycle remain owned by the existing adapter.

## Content and interaction

- Chat uses the visible Reply / react control, quoted replies, reaction counts, draft preservation, and latest-message navigation. Read-only/disconnected states explain why sending is unavailable.
- The composer uses one compact row with 8px vertical / 12px horizontal padding. Message remains a screen-reader label; omit the redundant visible label. Keep 16px input text, 44px control targets, and visible reply/error/restriction feedback. Empty-video metadata omits repeated start instructions; Choose video remains the action.
- An open movie poll appears in Chat as a compact invitation to vote. Full search, suggestions, results, and finishing controls live under Up next. Starting a poll selects that tab; a concluded poll shows the result without expanding through chat.
- People uses readable, full-width participant rows, initials, role, and self indicators. Compact details open the individual-permission dialog or moderation confirmation established in stage 2.
- Omit redundant Now playing, In this room, and decorative movie-vote eyebrow labels. The filename, selected People tab, and meaningful empty/result headings provide the context. Keep People as a screen-reader heading for the standalone roster.
- Use the existing semantic palette and system font. Uniform SVG stroke style, 44px controls, readable 14px supporting text and 16px inputs/messages. Keep playback errors explicit in the video placeholder instead of leaving a stale Opening video message.
- One h1, named tab panels, arrow/Home/End tab navigation, skip link, visible focus, and focus-returning native dialogs.
- Badge numbers are decorative duplicates of the contextual tab names. A single atomic, polite status announces unread totals; bare counts are not competing live regions. Tabs can wrap their contents when text is enlarged.

## Research and interpretation

Re-ran `video streaming cinema --design-system`: Dark Mode (OLED) remains an appropriate restrained visual direction. The returned marketing hero layout and red palette are not applied; this page retains the established accessible violet palette and both themes.

`focus not obscured --domain ux` returned the specific AA/AAA visibility distinctions and fits the composer/dialog checks. `navigation hierarchy visible controls` returned generic breadcrumbs/heading guidance; a narrower progressive-disclosure search was off-topic. `preserve component state tabs --stack react` returned broad tab patterns, and the narrower unmount query found no match. No verified database match was found for those specific layout/state decisions; the hierarchy above uses the skill's Quick Reference and application-specific design judgment, with behavior tested directly.

For the header refinement, `live badge count screen reader --domain ux` returned **Accessibility / Contextual Live Badge Updates**, which directly supports contextual announcements from one status region. `dialog focus form state --stack react` returned **Accessibility / Manage focus properly**; the existing native-dialog focus behavior supports the on-demand name editor.
