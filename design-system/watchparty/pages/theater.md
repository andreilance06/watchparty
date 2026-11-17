# Theater layout

The attached references define the composition: a large black video stage, a full-height conversation on the right, and a persistent chevron on their shared edge. Keep WatchParty's own identity, permissions, polls, and editable names.

## Design plan and review

- Palette: black #000000 for the video stage; ivory #F5EFE1, sand #E5D3AF, burgundy #790D16, blue #AEC4D4, and warm charcoal #211B1D through existing theme tokens.
- Typography: retain the system sans-serif family; 16px message/input text, 14px controls and filename, 12px timestamps/counts. The room title sits beside the logo at 16px, with its editable pencil and connection status following it.
- Layout: use the whole viewport, left-align room and filename controls, center contained video, and anchor the composer to the chat column's bottom. Compare docked chat against overlay chat; use docked chat on desktop because the reference preserves the entire movie picture.
- Principles: the picture supplies the visual drama; flat chrome, compact controls, no decorative labels, no reaction bar or ready checks. Preserve the existing mounted conversation and player across layout changes.

```text
Browser:  [brand / room + edit / connection / theme / rooms]
          [filename / choose video        ][name + edit + invite + permissions]
          [                               ][Chat People  ]
          [          video               >][conversation ]
          [          controls             ][composer     ]
Hidden:   [             video                            <]
Fullscreen: same dock and edge toggle, without page/room/media chrome.
Phone:    [video + edge toggle]
          [name / tabs / conversation / composer]
```

Review: removing the former max-width card composition and rounded player/side-panel boxes gives the reference's theater geometry. Retain the client's warm palette rather than copying the screenshots' unrelated blue/green branding. A narrow chevron needs a full 44px hit area, an accessible Show/Hide chat name, expanded state, and unread badge. Keep the same button mounted so focus survives closing. No width animation; a brief transform-only panel entry respects reduced motion and rapid toggling.

The edge expand/collapse button is also the resize handle, using pointer capture and a 6px horizontal threshold. A click toggles chat; drag release suppresses the toggle. Leftward dragging from closed reopens the dock. The visual button tucks to a 14px sliver until hovered, keyboard-focused, or dragged, while retaining a 44px hit target. Touch/coarse pointers keep it fully visible, and reduced motion removes the transition. Width defaults to 380px and is bounded by chat readability, a 320px video minimum, 60% of the available width, and a 640px cap. Arrow Left grows the right dock, Arrow Right shrinks it, Shift uses larger steps, and Home/End choose bounds. Escape/pointer cancellation restores the starting size/open state. Rotation to stacked phone layout cancels an active drag. Saved width and open/closed state live in `watchparty-chat-dock` local storage across rooms/visits; viewport clamping does not overwrite the preferred width. Width changes commit to storage after release. Invalid/unavailable storage falls back safely.

Invite and host-only permissions are named 44px icon buttons to the right of the display name and edit pencil. Remove the separate room masthead and Leave room action. Keep room identity and connection in the topmost brand bar; on phones use the logo mark and an icon for Browse rooms to reserve space for the room name. The filename/choose-video row is the only remaining strip above the picture.

Display-name editing is inline: the textbox replaces the name, the adjacent pencil becomes a checkmark, and Enter/check submits. Escape cancels unsaved edits without closing chat. Server rejection retains the draft and focuses the field; acknowledgment restores the heading/pencil. The pencil stays immediately beside the name, with invitation/permissions actions pushed to the right. Tab label/count groups do not split across lines; narrow docks omit redundant icons.

Room-name editing uses the same textbox/checkmark interaction in the topmost bar, with host-only access, 80-character validation, acknowledgment, retained errors, and Escape cancellation. The mobile header temporarily hides theme/browse actions during editing to give the textbox space without introducing another bar. Connection status remains beside the editor.

## Research

ui-ux-pro-max's `collapsible sidebar focus preservation` and narrower `drawer keyboard focus restore` searches returned generic focus-state and focus-obscuring guidance, without a verified drawer-specific match. Drawer placement/focus behavior above is tailored design judgment. React search `preserve state conditional visibility` had no matches; retry `state stable` returned active React guidance for lifting sibling state into their parent and stable identities. Apply parent-owned visibility and keep panels mounted.

## Verification

The combined-button/inline-edit update passes 74 UI tests, 41 player/chat regression tests, and production build. Browser checks verified hover expansion, real dragging without collapse, inline name save and focus return, and 99+ badges aligned beside both labels in a 280px dock. Touch emulation keeps the button visible; reduced motion removes its transition.

The resizable dock update passes 73 UI tests, 41 player/chat regression tests, and the production build. Browser checks verify real pointer dragging, saved width and collapsed state across reload, the 375px compact header, and resizing plus the permissions dialog inside native fullscreen. The invitation icon opens its existing dialog; the permissions dialog returns focus to its moved icon. Tests also cover keyboard sizing/reset, bounds, malformed storage, pointer cancellation, and rotation during a drag.

Browser review with a generated local clip covered 1440×900 desktop, 375×812 portrait, 812×375 landscape, both themes, and native fullscreen with chat open/closed. The video expands to the entire fullscreen width when chat closes; the composer stays visible in the sampled viewports. Reduced-motion emulation disables panel entry animation. Unit coverage verifies mounted draft/tab/media preservation, hidden-chat unread behavior, focus return, retained scroll, fullscreen overlay restoration, and pseudo-fullscreen exit.
