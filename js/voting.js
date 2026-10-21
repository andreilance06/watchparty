export function createVoting({ elements, state, send, report = () => {} }) {
  const { suggestionForm, suggestionInput, suggestionResults, suggestionStatus, voteOptions } = elements;
  let searchSequence = 0;
  let latest = { poll: { id: null, status: "idle" }, suggestions: [] };
  let connected = false, expanded = false, starting = false, lastResultId = null;

  function sendPoll(payload) {
    if (!connected || latest.poll.status !== "open") return false;
    return send({ ...payload, pollId: latest.poll.id });
  }

  function resetSearch() {
    searchSequence++;
    suggestionResults.replaceChildren();
    suggestionStatus.textContent = "";
    suggestionInput.value = "";
  }

  function refreshControls() {
    const open = latest.poll.status === "open";
    elements.votePanel.hidden = !open;
    elements.chatPanel.classList.toggle("poll-expanded", open && expanded);
    elements.startPollButton.hidden = state.role !== "host" || open;
    elements.startPollButton.disabled = !connected;
    elements.finishPollButton.hidden = state.role !== "host";
    elements.finishPollButton.disabled = !connected;
    elements.pollDetails.hidden = !open || !expanded;
    elements.pollToggle.setAttribute("aria-expanded", String(open && expanded));
    elements.pollToggle.textContent = expanded ? "Collapse poll" : "Expand poll";
    suggestionInput.disabled = !connected || !open;
    const submit = suggestionForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !connected || !open;
  }

  elements.startPollButton.addEventListener("click", () => {
    if (connected && state.role === "host") starting = send({ type: "start-video-poll" }) !== false;
  });
  elements.finishPollButton.addEventListener("click", () => {
    if (state.role === "host") sendPoll({ type: "finish-video-poll" });
  });
  elements.pollToggle.addEventListener("click", () => {
    expanded = !expanded;
    refreshControls();
  });

  function suggestTitle(title, movie = null) {
    const sent = sendPoll({ type: "suggest-video", title, ...(movie ? { movie: { pageId: movie.pageId, title: movie.title, pageUrl: movie.pageUrl,
      posterUrl: movie.posterUrl, description: movie.description } } : {}) });
    if (sent === false) {
      suggestionStatus.textContent = "Connect to the room before suggesting a movie.";
      return;
    }
    suggestionInput.value = "";
    suggestionResults.replaceChildren();
    suggestionStatus.textContent = `Suggested “${title}”. Your vote is recorded automatically.`;
    suggestionInput.focus();
  }

  function addTitleOnlyButton(title) {
    if (!title) return;
    const button = document.createElement("button");
    button.className = "suggestion-title-only";
    button.type = "button";
    button.textContent = `Suggest “${title}” without a poster`;
    button.addEventListener("click", () => suggestTitle(title));
    suggestionResults.appendChild(button);
  }

  function showMovies(movies, query) {
    suggestionResults.replaceChildren();
    if (!movies.length) {
      suggestionStatus.textContent = `No matches for “${query}”. You can still suggest it without a poster.`;
      addTitleOnlyButton(query);
      return;
    }
    suggestionStatus.textContent = `Choose the matching movie for “${query}”.`;
    for (const movie of movies) {
      const result = document.createElement("article");
      result.className = "movie-search-result";
      if (movie.posterUrl) {
        const poster = document.createElement("img");
        poster.className = "movie-search-poster";
        poster.src = movie.posterUrl;
        poster.alt = `Poster for ${movie.title}`;
        poster.loading = "lazy";
        poster.referrerPolicy = "no-referrer";
        result.appendChild(poster);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "movie-search-poster movie-poster-placeholder";
        placeholder.setAttribute("aria-label", "No poster available");
        placeholder.textContent = "No poster";
        result.appendChild(placeholder);
      }
      const details = document.createElement("div");
      details.className = "movie-search-details";
      const title = document.createElement("h3");
      title.textContent = movie.title;
      details.appendChild(title);
      if (movie.description) {
        const description = document.createElement("p");
        description.textContent = movie.description;
        details.appendChild(description);
      }
      const source = document.createElement("a");
      source.href = movie.pageUrl;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = "Wikipedia";
      details.appendChild(source);
      const button = document.createElement("button");
      button.className = "movie-search-select";
      button.type = "button";
      button.textContent = "Suggest & vote";
      button.addEventListener("click", () => suggestTitle(movie.title, movie));
      details.appendChild(button);
      result.appendChild(details);
      suggestionResults.appendChild(result);
    }
    addTitleOnlyButton(query);
  }

  function applyState(message) {
    const poll = message.poll || { id: null, status: "idle" };
    let restoreFocus = false;
    if (poll.id !== latest.poll.id || poll.status !== latest.poll.status) {
      restoreFocus = poll.status !== "open" && elements.votePanel.contains(document.activeElement);
      resetSearch();
      expanded = poll.status === "open" && starting && state.role === "host";
      starting = false;
    }
    latest = { ...message, poll };
    refreshControls();
    if (restoreFocus) (state.role === "host" ? elements.startPollButton : elements.chatInput).focus();
    if (poll.status === "closed" && poll.result && lastResultId !== poll.id) {
      lastResultId = poll.id;
      const winners = poll.result.suggestions.filter(option => poll.result.winnerIds.includes(option.id));
      const outcome = winners.length === 0 ? "No votes cast."
        : winners.length === 1 ? `Winner: ${winners[0].title} (${winners[0].votes} ${winners[0].votes === 1 ? "vote" : "votes"}).`
          : `Tie: ${winners.map(option => option.title).join(", ")} (${winners[0].votes} ${winners[0].votes === 1 ? "vote" : "votes"} each).`;
      report(`Movie poll concluded. ${outcome}`);
    }
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
    voteOptions.replaceChildren();

    if (!options.length) {
      const empty = document.createElement("p");
      empty.className = "vote-empty";
      empty.textContent = "Suggest a title to start voting.";
      voteOptions.appendChild(empty);
      return;
    }

    for (const option of options) {
      const votes = Math.max(0, Number(option.votes) || 0);
      const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
      const isSelected = option.id === selectedOptionId;
      const row = document.createElement("article");
      row.className = "vote-option";
      row.classList.toggle("selected", isSelected);

      const poster = document.createElement("div");
      poster.className = "vote-poster";
      if (option.movie?.posterUrl) {
        const image = document.createElement("img");
        image.src = option.movie.posterUrl;
        image.alt = `Poster for ${option.title}`;
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => {
          poster.replaceChildren();
          poster.classList.add("movie-poster-placeholder");
          poster.textContent = "No poster";
        }, { once: true });
        poster.appendChild(image);
      } else {
        poster.classList.add("movie-poster-placeholder");
        poster.textContent = "No poster";
      }

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
      if (option.movie?.description) {
        const description = document.createElement("p");
        description.className = "vote-description";
        description.textContent = option.movie.description;
        details.appendChild(description);
      }
      if (option.movie?.pageUrl) {
        const source = document.createElement("a");
        source.className = "vote-source";
        source.href = option.movie.pageUrl;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        source.textContent = "Wikipedia";
        details.appendChild(source);
      }
      const suggester = document.createElement("p");
      suggester.className = "vote-suggester";
      suggester.textContent = `Suggested by ${option.ownerName || "a participant"}`;
      details.appendChild(suggester);

      const button = document.createElement("button");
      button.className = "vote-button";
      button.type = "button";
      button.textContent = isSelected ? "Your vote" : "Vote";
      button.disabled = isSelected || !connected || poll.status !== "open";
      button.setAttribute("aria-pressed", String(isSelected));
      button.setAttribute("aria-label", `${isSelected ? "Your vote for" : "Vote for"} ${option.title}`);
      button.addEventListener("click", () => sendPoll({ type: "vote-video", suggestionId: option.id }));

      row.append(poster, details, button);
      if (option.canRemove) {
        const removeButton = document.createElement("button");
        removeButton.className = "vote-remove-button";
        removeButton.type = "button";
        removeButton.textContent = "Remove";
        removeButton.setAttribute("aria-label", `Remove suggestion for ${option.title}`);
        removeButton.disabled = !connected || poll.status !== "open";
        removeButton.addEventListener("click", () => sendPoll({ type: "remove-video-suggestion", suggestionId: option.id }));
        row.appendChild(removeButton);
      }
      voteOptions.appendChild(row);
    }
  }

  suggestionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!connected || latest.poll.status !== "open") return;
    const query = suggestionInput.value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (query.length < 2) {
      suggestionStatus.textContent = "Enter at least two characters to search.";
      return;
    }
    const token = ++searchSequence;
    const submit = suggestionForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    suggestionResults.replaceChildren();
    suggestionStatus.textContent = "Searching Wikipedia for movie matches…";
    try {
      const response = await fetch(`/api/movies/search?q=${encodeURIComponent(query)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Movie search is unavailable.");
      if (token === searchSequence) showMovies(Array.isArray(result.movies) ? result.movies : [], query);
    } catch (error) {
      if (token !== searchSequence) return;
      suggestionStatus.textContent = `${error.message || "Movie search is unavailable."} You can still suggest the title without a poster.`;
      addTitleOnlyButton(query);
    } finally {
      if (token === searchSequence && submit) submit.disabled = false;
    }
  });

  applyState(latest);
  return {
    applyState,
    refresh: () => applyState(latest),
    setConnected(value) {
      connected = value;
      if (!value) resetSearch();
      applyState(latest);
    }
  };
}
