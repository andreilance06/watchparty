export function createParty({ elements }) {
  const { reactionFeed, floatingReactions } = elements;
  const animations = new Map();
  const notices = new Map();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  function removeFloatingReaction(reaction) {
    clearTimeout(animations.get(reaction));
    animations.delete(reaction);
    reaction.remove();
  }

  function showFloatingReaction(emoji) {
    if (reducedMotion?.matches) return;
    const burstCount = 6;
    for (let index = 0; index < burstCount; index++) {
      while (animations.size >= 30) removeFloatingReaction(animations.keys().next().value);
      const reaction = document.createElement("span");
      reaction.className = "floating-reaction";
      reaction.textContent = emoji;
      reaction.style.left = `${10 + Math.random() * 80}%`;
      reaction.style.animationDelay = `${index * 70}ms`;
      floatingReactions.appendChild(reaction);
      reaction.addEventListener("animationend", () => removeFloatingReaction(reaction), { once: true });
      animations.set(reaction, setTimeout(() => removeFloatingReaction(reaction), 2700));
    }
  }
  reducedMotion?.addEventListener?.("change", () => {
    if (reducedMotion.matches) for (const reaction of animations.keys()) removeFloatingReaction(reaction);
  });

  function receiveReaction(message) {
    const reaction = document.createElement("p");
    reaction.className = "reaction-item";
    reaction.textContent = `${message.emoji} ${message.name}`;
    reactionFeed.appendChild(reaction);
    notices.set(reaction, setTimeout(() => removeNotice(reaction), 4000));
    while (reactionFeed.children.length > 5) removeNotice(reactionFeed.children[0]);
    showFloatingReaction(message.emoji);
  }

  function removeNotice(reaction) {
    clearTimeout(notices.get(reaction));
    notices.delete(reaction);
    reaction.remove();
  }
  return { receiveReaction };
}
