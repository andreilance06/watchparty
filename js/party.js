const REACTIONS = [
  ["reactLove", "❤️"], ["reactLaugh", "😂"], ["reactWow", "😮"],
  ["reactClap", "👏"], ["reactSad", "😢"]
];

export function createParty({ elements, send }) {
  const { participantList, reactionFeed } = elements;

  function updateParticipants(participants = []) {
    participantList.replaceChildren();
    for (const participant of participants) {
      const item = document.createElement("li");
      item.className = "participant";
      const indicator = document.createElement("span");
      indicator.className = "participant-status online";
      indicator.setAttribute("aria-label", "Connected");
      const name = document.createElement("span");
      name.className = "participant-name";
      name.textContent = participant.name;
      const role = document.createElement("span");
      role.className = "participant-role";
      role.textContent = participant.role === "host" ? "Host" : "Viewer";
      item.append(indicator, name, role);
      participantList.appendChild(item);
    }
  }

  function receiveReaction(message) {
    const reaction = document.createElement("p");
    reaction.className = "reaction-item";
    reaction.textContent = `${message.emoji} ${message.name}`;
    reactionFeed.appendChild(reaction);
    while (reactionFeed.children.length > 5) reactionFeed.children[0].remove();
  }

  for (const [id, emoji] of REACTIONS) {
    elements[id].addEventListener("click", () => send({ type: "reaction", emoji }));
  }

  return { updateParticipants, receiveReaction };
}
