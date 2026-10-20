const REACTIONS = [
  ["reactLove", "❤️"], ["reactLaugh", "😂"], ["reactWow", "😮"],
  ["reactClap", "👏"], ["reactSad", "😢"]
];

export function createParty({ elements, send }) {
  const { reactionFeed, floatingReactions } = elements;
  const animations = new Map();
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
    while (reactionFeed.children.length > 5) reactionFeed.children[0].remove();
    showFloatingReaction(message.emoji);
  }

  for (const [id, emoji] of REACTIONS) {
    elements[id].addEventListener("click", () => send({ type: "reaction", emoji }));
  }

  return { receiveReaction };
}
