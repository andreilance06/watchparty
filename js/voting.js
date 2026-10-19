export function createVoting({ elements, send }) {
  function applyState(message) {
    const options = Array.isArray(message.suggestions)
      ? message.suggestions.filter((option) => option && option.id != null && typeof option.title === "string")
      : [];
    const selectedOptionId = message.myVoteId ?? null;
    const totalVotes = options.reduce((total, option) => total + Math.max(0, Number(option.votes) || 0), 0);

    elements.voteStatus.textContent = `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} cast`;
    const highestVotes = Math.max(0, ...options.map((option) => Number(option.votes) || 0));
    const leaders = options.filter((option) => option.votes === highestVotes && highestVotes > 0);
    elements.voteLeader.textContent = leaders.length === 0
      ? options.length ? "No votes yet." : "No suggestions yet."
      : leaders.length === 1
        ? `Leading: ${leaders[0].title} (${highestVotes} ${highestVotes === 1 ? "vote" : "votes"})`
        : `Tie: ${leaders.map((option) => option.title).join(", ")} (${highestVotes} ${highestVotes === 1 ? "vote" : "votes"} each)`;
    elements.voteOptions.replaceChildren();

    if (!options.length) {
      const empty = document.createElement("p");
      empty.className = "vote-empty";
      empty.textContent = "Suggest a title to start voting.";
      elements.voteOptions.appendChild(empty);
      return;
    }

    for (const option of options) {
      const votes = Math.max(0, Number(option.votes) || 0);
      const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
      const isSelected = option.id === selectedOptionId;
      const row = document.createElement("article");
      row.className = "vote-option";
      row.classList.toggle("selected", isSelected);

      const details = document.createElement("div");
      details.className = "vote-option-details";
      const title = document.createElement("h3");
      title.textContent = option.title;
      const count = document.createElement("span");
      count.className = "vote-count";
      count.textContent = `${votes} ${votes === 1 ? "vote" : "votes"} · ${percentage}%`;
      const meter = document.createElement("div");
      meter.className = "vote-meter";
      meter.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.style.width = `${percentage}%`;
      meter.appendChild(fill);
      details.append(title, count, meter);

      const button = document.createElement("button");
      button.className = "vote-button";
      button.type = "button";
      button.textContent = isSelected ? "Your vote" : "Vote";
      button.disabled = isSelected;
      button.setAttribute("aria-pressed", String(isSelected));
      button.setAttribute("aria-label", `${isSelected ? "Your vote for" : "Vote for"} ${option.title}`);
      button.addEventListener("click", () => send({ type: "vote-video", suggestionId: option.id }));

      row.append(details, button);
      elements.voteOptions.appendChild(row);
    }
  }

  elements.suggestionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = elements.suggestionInput.value.replace(/\s+/g, " ").trim().slice(0, 100);
    if (!title) return;
    send({ type: "suggest-video", title });
    elements.suggestionInput.value = "";
    elements.suggestionInput.focus();
  });

  applyState({});
  return { applyState };
}
