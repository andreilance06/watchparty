const REACTIONS = [
  ["reactLove", "❤️"], ["reactLaugh", "😂"], ["reactWow", "😮"],
  ["reactClap", "👏"], ["reactSad", "😢"]
];

export function createParty({ elements, state, send }) {
  const { participantList, reactionFeed, suggestionForm, suggestionInput, voteLeader, videoSuggestionList } = elements;

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

  function updateState(message) {
    state.voteId = message.myVoteId ?? null;
    updateParticipants(message.participants);
    videoSuggestionList.replaceChildren();

    const suggestions = message.suggestions || [];
    for (const suggestion of suggestions) {
      const item = document.createElement("li");
      item.className = "video-suggestion";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vote-button";
      button.setAttribute("aria-pressed", String(state.voteId === suggestion.id));
      button.textContent = `${suggestion.title} · ${suggestion.votes} ${suggestion.votes === 1 ? "vote" : "votes"}`;
      button.addEventListener("click", () => send({ type: "vote-video", suggestionId: suggestion.id }));
      item.appendChild(button);
      videoSuggestionList.appendChild(item);
    }

    const highestVotes = Math.max(0, ...suggestions.map((suggestion) => suggestion.votes));
    const leaders = suggestions.filter((suggestion) => suggestion.votes === highestVotes && highestVotes > 0);
    voteLeader.textContent = leaders.length === 0
      ? suggestions.length ? "No votes yet." : "No suggestions yet."
      : leaders.length === 1
        ? `Leading: ${leaders[0].title} (${highestVotes} ${highestVotes === 1 ? "vote" : "votes"})`
        : `Tie: ${leaders.map((suggestion) => suggestion.title).join(", ")} (${highestVotes} votes each)`;
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

  suggestionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = suggestionInput.value.replace(/\s+/g, " ").trim().slice(0, 100);
    if (!title) return;
    send({ type: "suggest-video", title });
    suggestionInput.value = "";
    suggestionInput.focus();
  });

  return { updateParticipants, updateState, receiveReaction };
}
