export function createVoting({ elements, send }) {
  function applyState(message) {
    const options = Array.isArray(message.options)
      ? message.options.filter((option) => option && option.id != null && typeof option.title === "string")
      : [];
    const open = message.open !== false;
    const selectedOptionId = message.selectedOptionId == null ? null : String(message.selectedOptionId);
    const totalVotes = options.reduce((total, option) => total + Math.max(0, Number(option.votes) || 0), 0);

    elements.voteStatus.textContent = !open
      ? "Voting is closed"
      : options.length
        ? `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} cast`
        : "Waiting for the host";
    elements.voteOptions.replaceChildren();

    if (!options.length) {
      const empty = document.createElement("p");
      empty.className = "vote-empty";
      empty.textContent = open ? "No videos are up for a vote yet." : "There are no video options.";
      elements.voteOptions.appendChild(empty);
      return;
    }

    for (const option of options) {
      const votes = Math.max(0, Number(option.votes) || 0);
      const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
      const isSelected = String(option.id) === selectedOptionId;
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
      button.disabled = !open || isSelected;
      button.setAttribute("aria-pressed", String(isSelected));
      button.setAttribute("aria-label", `${isSelected ? "Your vote for" : "Vote for"} ${option.title}`);
      button.addEventListener("click", () => send({ type: "vote", optionId: option.id }));

      row.append(details, button);
      elements.voteOptions.appendChild(row);
    }
  }

  return { applyState };
}