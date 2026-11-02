// Keep the same conversation and participant nodes across responsive layouts.
export function initializeLounge(elements, attention) {
  const { chatTab, peopleTab, socialTabs, socialPeople, socialChat } = elements;
  let selected = "chat";
  const desktop = window.matchMedia?.("(min-width: 1100px)");

  function render() {
    const wide = desktop ? desktop.matches : window.innerWidth >= 1100;
    socialTabs.hidden = wide;
    const showChat = wide || selected === "chat";
    socialChat.hidden = !showChat;
    socialPeople.hidden = !wide && selected !== "people";
    for (const [tab, active] of [[chatTab, selected === "chat"], [peopleTab, selected === "people"]]) {
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const [panel, label] of [[socialChat, "chatTab"], [socialPeople, "peopleTab"]]) {
      if (wide) {
        panel.removeAttribute("role");
        panel.setAttribute("aria-labelledby", panel === socialPeople ? "participants-title" : "chat-title");
      } else {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", label);
      }
    }
    attention.setSocialVisible(showChat);
  }
  function select(value, focus = false) {
    if (selected !== value) document.dispatchEvent(new Event("watchparty-social-change"));
    selected = value;
    render();
    if (focus) (value === "chat" ? chatTab : peopleTab).focus();
  }
  chatTab.addEventListener("click", () => select("chat"));
  peopleTab.addEventListener("click", () => select("people"));
  socialTabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    select(event.key === "Home" ? "chat" : event.key === "End" ? "people" : selected === "chat" ? "people" : "chat", true);
  });
  window.addEventListener("resize", render);
  desktop?.addEventListener("change", render);
  render();

  const disclosures = [
    [elements.roomMenuToggle, elements.roomMenu],
    [elements.chatMenuToggle, elements.chatMenu]
  ];
  function close(trigger, panel, restoreFocus = false) {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  for (const [trigger, panel] of disclosures) {
    panel.hidden = true;
    trigger.addEventListener("click", () => {
      const opening = panel.hidden;
      for (const [other, content] of disclosures) close(other, content);
      panel.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
      if (opening) {
        // Invitation and room options share the same anchored space.
        elements.roomInfoDetails.hidden = true;
        elements.roomInfoToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("pointerdown", event => {
      if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(trigger, panel);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        close(trigger, panel, true);
      }
    });
  }
  elements.roomInfoToggle.addEventListener("click", () => close(elements.roomMenuToggle, elements.roomMenu));
  elements.startPollButton.addEventListener("click", () => close(elements.chatMenuToggle, elements.chatMenu, true));
}
