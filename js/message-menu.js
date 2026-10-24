import { EMOJI_CHOICES } from "./emoji-picker.js";

const QUICK_REACTIONS = [
  ["\u2764\ufe0f", "heart"], ["\ud83d\udc4d", "thumbs up"], ["\ud83d\ude02", "laughter"],
  ["\ud83d\udd25", "fire"], ["\ud83d\ude2e", "surprise"], ["\ud83d\ude22", "sadness"],
  ["\ud83d\udc4f", "applause"], ["\ud83c\udf89", "celebration"]
];

export function createMessageMenu({ menu, onReply, onReact, beforeOpen }) {
  let active = null, press = null, focusIndex = 0, suppressClickUntil = 0, suppressedArticle = null;
  let expanded = false, openingPoint = null;
  const reactions = [];
  document.body.appendChild(menu);
  menu.hidden = true;
  const quick = document.createElement("div");
  quick.className = "message-menu-reactions";
  quick.setAttribute("role", "group");
  quick.setAttribute("aria-label", "Quick reactions");
  menu.appendChild(quick);

  function addItem(parent, text, className, action, keepOpen = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.addEventListener("click", () => {
      const comment = active;
      if (!comment) return;
      const stayOpen = keepOpen || expanded && button.classList.contains("message-menu-reaction");
      if (!stayOpen) close(true);
      action(comment);
      if (stayOpen && active === comment) focusItem(visibleItems().indexOf(button), false);
    });
    button.addEventListener("focus", () => { focusIndex = visibleItems().indexOf(button); });
    parent.appendChild(button);
    return button;
  }
  for (const [emoji, label] of QUICK_REACTIONS) {
    const button = addItem(quick, emoji, "message-menu-reaction", comment => onReact(comment, emoji));
    reactions.push({ button, emoji, label });
  }
  const more = addItem(quick, "", "message-menu-more", () => setExpanded(!expanded), true);
  more.setAttribute("aria-label", "More reactions");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", `${menu.id}-expanded`);
  more.title = "More reactions";
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  chevron.appendChild(path);
  more.appendChild(chevron);
  const extra = document.createElement("div");
  extra.id = `${menu.id}-expanded`;
  extra.className = "message-menu-expanded";
  extra.setAttribute("role", "group");
  extra.setAttribute("aria-label", "More reactions");
  extra.hidden = true;
  menu.appendChild(extra);
  const reply = addItem(menu, "\u21a9  Reply", "message-menu-action", onReply);

  function visibleItems() {
    return [...quick.children, ...(expanded ? [...extra.children] : []), reply];
  }

  function setExpanded(next) {
    if (next && !extra.children.length) {
      const quickEmojis = new Set(QUICK_REACTIONS.map(([emoji]) => emoji));
      for (const { emoji, label } of EMOJI_CHOICES) {
        if (quickEmojis.has(emoji)) continue;
        const button = addItem(extra, emoji, "message-menu-reaction message-menu-extra", comment => onReact(comment, emoji), true);
        reactions.push({ button, emoji, label });
      }
    }
    expanded = next;
    extra.hidden = !expanded;
    more.setAttribute("aria-expanded", String(expanded));
    if (!expanded) for (const button of extra.children) button.tabIndex = -1;
    if (active) { refresh(); position(); }
  }

  function refresh(comment = active) {
    if (!active || active !== comment) return;
    for (const { button, emoji, label } of reactions) {
      const selected = comment.myReaction === emoji;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-label", selected ? `Remove your ${label} reaction` : `React with ${label}`);
    }
  }

  function focusItem(index, reveal = true) {
    const items = visibleItems();
    focusIndex = (index + items.length) % items.length;
    items.forEach((item, i) => { item.tabIndex = i === focusIndex ? 0 : -1; });
    items[focusIndex].focus({ preventScroll: true });
    if (reveal && items[focusIndex].parentNode === extra) {
      const box = extra.getBoundingClientRect(), target = items[focusIndex].getBoundingClientRect();
      if (target.top < box.top) extra.scrollTop -= box.top - target.top;
      else if (target.bottom > box.bottom) extra.scrollTop += target.bottom - box.bottom;
    }
  }

  function position() {
    const point = openingPoint;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    menu.style.setProperty("--message-menu-height", `${Math.max(0, height - 16)}px`);
    const anchor = active.article.getBoundingClientRect(), box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left, Math.min(point?.x ?? anchor.left, left + width - 16 - box.width))}px`;
    menu.style.top = `${Math.max(top, Math.min(point?.y ?? anchor.bottom, top + height - 16 - box.height))}px`;
  }

  function outside(event) {
    if (!event.composedPath().includes(menu)) close();
  }
  function keyboard(event) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (expanded) { setExpanded(false); focusItem(visibleItems().indexOf(more)); }
      else close(true);
    } else if (event.key === "Tab") close();
    else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const items = visibleItems(), current = items[focusIndex];
      const extraIndex = [...extra.children].indexOf(current);
      if (expanded && extraIndex >= 0 && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        const next = extraIndex + (event.key === "ArrowDown" ? 8 : -8);
        focusItem(next < 0 ? items.indexOf(more) : next >= extra.children.length ? items.indexOf(reply)
          : items.indexOf(extra.children[next]));
      } else focusItem(event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : focusIndex + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1));
    }
  }
  function cancelPress() { clearTimeout(press?.timer); press = null; }
  function close(restoreFocus = false) {
    cancelPress();
    const comment = active;
    active = null;
    menu.hidden = true;
    setExpanded(false);
    extra.scrollTop = 0;
    comment?.article.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keyboard, true);
    if (restoreFocus && comment?.article.isConnected) comment.article.focus({ preventScroll: true });
  }
  function open(comment, point) {
    cancelPress();
    beforeOpen();
    close();
    active = comment;
    openingPoint = point || null;
    comment.article.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    refresh(); position(); focusItem(0);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyboard, true);
  }
  function dismissOnLayout(event) {
    cancelPress();
    if (!menu.contains(event.target)) close();
  }
  window.addEventListener("scroll", dismissOnLayout, true);
  window.addEventListener("resize", dismissOnLayout);
  window.visualViewport?.addEventListener("resize", dismissOnLayout);
  window.visualViewport?.addEventListener("scroll", dismissOnLayout);
  document.addEventListener("watchparty-fullscreen-change", () => { cancelPress(); close(); });

  function bind(comment) {
    const article = comment.article;
    article.tabIndex = 0;
    article.setAttribute("aria-haspopup", "menu");
    article.setAttribute("aria-controls", menu.id);
    article.setAttribute("aria-expanded", "false");
    article.setAttribute("aria-description", "Right-click, long-press, or press Shift+F10 for message actions.");
    article.addEventListener("contextmenu", event => {
      event.preventDefault(); event.stopPropagation();
      open(comment, { x: event.clientX, y: event.clientY });
    });
    article.addEventListener("keydown", event => {
      if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); open(comment);
      }
    });
    article.addEventListener("pointerdown", event => {
      cancelPress();
      if (!["touch", "pen"].includes(event.pointerType) || event.isPrimary === false) return;
      const point = { x: event.clientX, y: event.clientY };
      press = { comment, ...point, timer: setTimeout(() => {
        suppressClickUntil = Date.now() + 800;
        suppressedArticle = article;
        open(comment, point);
      }, 500) };
    });
    article.addEventListener("pointermove", event => {
      if (press?.comment === comment && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
    });
    for (const type of ["pointerup", "pointercancel"]) article.addEventListener(type, cancelPress);
    article.addEventListener("click", event => {
      if (article === suppressedArticle && Date.now() < suppressClickUntil) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      }
    }, true);
  }

  return { bind, close, refresh, closeFor(comment) {
    if (active === comment) close();
    if (press?.comment === comment) cancelPress();
  } };
}
