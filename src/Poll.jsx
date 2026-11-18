import { useEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { Button, Dialog, DialogHeader, Field, request, Status } from './shared.jsx';
import { Icon } from './Icons.jsx';
import { useRoom } from './room.jsx';

function Poster({ url, title, className }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={className}>{url && !failed ? <img src={url} alt={`Poster for ${title}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Icon name="video" />}</div>;
}

export function PollLauncher({ onStart }) {
  const { state, send } = useRoom();
  const [starting, setStarting] = useState(false), [status, setStatus] = useState('');
  const sent = useRef(false);
  useEffect(() => {
    if (state.poll.status === 'open' || !state.connected || !can(state, 'startPoll')) { sent.current = false; setStarting(false); }
    if (state.poll.status === 'open') setStatus('');
    const message = state.lastMessage;
    if (message?.type === 'error' && message.action === 'start-video-poll') { sent.current = false; setStarting(false); setStatus(message.message); }
  }, [state.poll.status, state.connected, state.permissions, state.role, state.event]);
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => { sent.current = false; setStarting(false); setStatus('The poll did not open. Try again.'); }, 10000);
    return () => clearTimeout(timer);
  }, [starting]);
  if (!can(state, 'startPoll') || state.poll.status === 'open') return null;
  return <div className="poll-launcher"><Button variant="primary" disabled={!state.connected} pending={starting} pendingLabel="Starting…" onClick={() => {
    if (sent.current || !state.connected) return;
    if (send({ type: 'start-video-poll' }) === false) { setStatus('Reconnect before starting a poll.'); return; }
    sent.current = true; setStarting(true); setStatus(''); onStart?.();
  }}><Icon name="plus" />{state.poll.status === 'closed' ? 'Start another poll' : 'Start poll'}</Button>{status && <Status tone="error">{status}</Status>}</div>;
}

function PollResults({ poll, onStart, resultRef }) {
  const { state } = useRoom();
  const result = poll.result;
  const winners = result?.suggestions?.filter(item => result.winnerIds?.includes(item.id)) || [];
  const others = result?.suggestions?.filter(item => !result.winnerIds?.includes(item.id)).sort((a, b) => b.votes - a.votes) || [];
  return <div ref={resultRef} className="poll-resting">
    <div className="poll-resting-heading"><span className="poll-resting-icon"><Icon name="vote" /></span><h2>{poll.status === 'closed' ? 'The votes are in' : 'What’s next?'}</h2>
      <p>{poll.status !== 'closed' ? 'Suggest movies and pick your next watch together.' : winners.length ? `${result.totalVotes} ${result.totalVotes === 1 ? 'vote' : 'votes'} · ${winners.length > 1 ? 'It’s a tie' : 'Your next pick'}` : 'No votes this time. Start another poll to choose together.'}</p>
    </div>
    {winners.map(option => <article className="poll-winner" key={option.id}><Poster className="poll-choice-poster" url={option.movie?.posterUrl} title={option.title} /><div><span className="poll-result-label">{winners.length > 1 ? 'Tied winner' : 'Winner'}</span><h3>{option.title}</h3><p>{option.votes} {option.votes === 1 ? 'vote' : 'votes'}</p></div><Icon name="check" /></article>)}
    {winners.length > 0 && <p className="poll-result-note">The host can choose the video file when everyone is ready.</p>}
    {others.length > 0 && <details className="poll-other-results"><summary>{winners.length ? 'Other results' : 'All results'}</summary><ul>{others.map(option => <li key={option.id}><span>{option.title}</span><span>{option.votes} {option.votes === 1 ? 'vote' : 'votes'}</span></li>)}</ul></details>}
    {can(state, 'startPoll') ? <PollLauncher onStart={onStart} /> : <p className="poll-result-note">The host can start a movie poll here.</p>}
  </div>;
}

export function Poll() {
  const { state, send } = useRoom();
  const { poll, suggestions: options } = state;
  const [query, setQuery] = useState(''), [searched, setSearched] = useState(''), [movies, setMovies] = useState([]);
  const [status, setStatus] = useState(''), [searching, setSearching] = useState(false), [error, setError] = useState('');
  const [adding, setAdding] = useState(false), [confirmFinish, setConfirmFinish] = useState(false), [finishing, setFinishing] = useState(false);
  const searchRef = useRef(null), input = useRef(null), addButton = useRef(null), finishButton = useRef(null), keepVoting = useRef(null);
  const requestedStart = useRef(false), requestedFinish = useRef(false), resultRef = useRef(null);
  const pendingSuggestion = useRef(null);
  const canSuggest = state.connected && poll.status === 'open' && can(state, 'suggestTitles');
  useEffect(() => {
    searchRef.current?.abort(); setQuery(''); setSearched(''); setMovies([]); setStatus(''); setError(''); setSearching(false); setAdding(false); setConfirmFinish(false); setFinishing(false);
    pendingSuggestion.current = null;
    if (!state.connected) requestedStart.current = requestedFinish.current = false;
    if (poll.status === 'open' && requestedStart.current) { requestedStart.current = false; requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); }
    if (poll.status === 'closed' && requestedFinish.current) { requestedFinish.current = false; requestAnimationFrame(() => resultRef.current?.querySelector('button')?.focus({ preventScroll: true })); }
    return () => searchRef.current?.abort();
  }, [poll.id, poll.status, state.connected]);
  useEffect(() => { if (adding) input.current?.focus({ preventScroll: true }); }, [adding]);
  useEffect(() => {
    const title = pendingSuggestion.current;
    if (!title || !options.some(option => option.title.toLocaleLowerCase() === title.toLocaleLowerCase())) return;
    pendingSuggestion.current = null; setStatus(`Suggested “${title}”.`);
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  }, [options]);
  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => { setFinishing(false); setStatus('The poll did not close. Try again.'); }, 10000);
    return () => clearTimeout(timer);
  }, [finishing]);
  useEffect(() => {
    if (!can(state, 'finishPoll') || !state.connected) { setConfirmFinish(false); setFinishing(false); }
    if (state.lastMessage?.type === 'error' && state.lastMessage.action === 'finish-video-poll') { setFinishing(false); setStatus(state.lastMessage.message); }
  }, [state.role, state.permissions, state.connected, state.event]);
  if (poll.status !== 'open') return <PollResults poll={poll} resultRef={resultRef} onStart={() => { requestedStart.current = true; }} />;
  function sendPoll(payload) {
    const permission = { 'finish-video-poll': 'finishPoll', 'suggest-video': 'suggestTitles', 'vote-video': 'vote' }[payload.type];
    if (!state.connected || permission && !can(state, permission)) return false;
    return send({ ...payload, pollId: poll.id });
  }
  function suggest(title, movie) {
    if (!canSuggest || sendPoll({ type: 'suggest-video', title, ...(movie ? { movie } : {}) }) === false) { setStatus('Reconnect before suggesting a movie.'); return; }
    setQuery(''); setSearched(''); setMovies([]); setAdding(false); setStatus(`Suggestion sent: “${title}”.`);
    pendingSuggestion.current = title;
    requestAnimationFrame(() => (addButton.current || input.current)?.focus({ preventScroll: true }));
  }
  async function search(event) {
    event.preventDefault();
    if (!canSuggest) return;
    const title = query.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title.length < 2) { setError('Enter at least two characters.'); input.current?.focus(); return; }
    setError(''); searchRef.current?.abort(); const controller = new AbortController(); searchRef.current = controller;
    setSearching(true); setMovies([]); setSearched(''); setStatus('Searching for movies…');
    try {
      const result = await request(`/api/movies/search?q=${encodeURIComponent(title)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const choices = Array.isArray(result.movies) ? result.movies : [];
      setMovies(choices); setSearched(title); setStatus(choices.length ? `${choices.length} ${choices.length === 1 ? 'match' : 'matches'} for “${title}”.` : `No matches for “${title}”. You can still suggest the title.`);
    } catch (error) {
      if (!controller.signal.aborted) { setSearched(title); setStatus(`${error.message} You can still suggest the title.`); }
    } finally { if (!controller.signal.aborted) setSearching(false); }
  }
  const total = options.reduce((sum, item) => sum + Math.max(0, Number(item.votes) || 0), 0);
  const showForm = can(state, 'suggestTitles') && (adding || options.length === 0);
  return <section className="poll-workspace" aria-labelledby="vote-title">
    <div className="poll-heading"><div><h2 id="vote-title">Movie vote</h2><p>{options.length} {options.length === 1 ? 'suggestion' : 'suggestions'}</p></div><span className="poll-vote-total" role="status" aria-atomic="true"><span className="sr-only">Movie vote: </span>{total} {total === 1 ? 'vote' : 'votes'}</span></div>
    <div>
      {!state.connected && <Status>Reconnect to vote or suggest a movie.</Status>}
      {!can(state, 'vote') && <Status>Voting is disabled for you. You can still view the results.</Status>}
      <div className="poll-choices" aria-label="Next-video options">{options.map(option => {
        const votes = Math.max(0, Number(option.votes) || 0), percentage = total ? Math.round(votes / total * 100) : 0, selected = option.id === state.myVoteId;
        return <article key={option.id} className={`poll-choice${selected ? ' is-selected' : ''}`}>
          <div className="poll-choice-heading"><Poster className="poll-choice-poster" url={option.movie?.posterUrl} title={option.title} /><div className="poll-choice-title"><h3>{option.title}</h3><p>Suggested by {option.ownerName || 'a participant'}</p></div>
            {option.canRemove && <Button icon variant="quiet" className="poll-remove" title={`Remove ${option.title}`} aria-label={`Remove suggestion for ${option.title}`} disabled={!state.connected} onClick={() => sendPoll({ type: 'remove-video-suggestion', suggestionId: option.id })}><Icon name="trash" /></Button>}
          </div>
          <div className="poll-choice-meter" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div>
          <div className="poll-choice-footer"><span className="poll-choice-count">{votes} {votes === 1 ? 'vote' : 'votes'} <span>· {percentage}%</span></span><Button variant={selected ? 'secondary' : 'primary'} className="poll-choice-vote" aria-pressed={selected} aria-label={`${selected ? 'Your vote for' : 'Vote for'} ${option.title}`} disabled={selected || !state.connected || !can(state, 'vote')} onClick={() => sendPoll({ type: 'vote-video', suggestionId: option.id })}>{selected && <Icon name="check" />}{selected ? 'Your vote' : 'Vote'}</Button></div>
          {(option.movie?.description || option.movie?.pageUrl) && <details className="poll-choice-info"><summary>Movie details</summary>{option.movie.description && <p>{option.movie.description}</p>}{option.movie.pageUrl && <a href={option.movie.pageUrl} target="_blank" rel="noopener noreferrer">View on TMDB</a>}</details>}
        </article>;
      })}</div>
      {options.length > 0 && can(state, 'vote') && <p className="poll-vote-help">You can change your vote until the poll closes.</p>}
      <div className="poll-suggestions">
        {can(state, 'suggestTitles') && options.length > 0 && !adding && <Button ref={addButton} className="poll-add" disabled={!state.connected} onClick={() => setAdding(true)}><Icon name="plus" />Suggest a movie</Button>}
        {showForm && <div className="poll-suggestion-editor"><div className="poll-editor-heading"><h3>{options.length ? 'Suggest a movie' : 'Add the first movie'}</h3>{options.length > 0 && <Button icon variant="quiet" aria-label="Close suggestions" onClick={() => { searchRef.current?.abort(); setSearching(false); setAdding(false); requestAnimationFrame(() => addButton.current?.focus()); }}><Icon name="close" /></Button>}</div>
          <form className="poll-search-form" autoComplete="off" onSubmit={search}><Field label="Movie title" id="suggestionInput" name="title" ref={input} value={query} onChange={event => { searchRef.current?.abort(); setSearching(false); setQuery(event.target.value); setMovies([]); setSearched(''); setStatus(''); setError(''); }} error={error} maxLength={80} placeholder="Search movies…" required disabled={!canSuggest} /><Button type="submit" variant="primary" disabled={!canSuggest} pending={searching} pendingLabel="Searching…"><Icon name="search" />Search</Button></form>
        </div>}
        {!can(state, 'suggestTitles') && options.length === 0 && <p className="poll-vote-help">Waiting for someone to suggest a movie. Suggestions are disabled for you.</p>}
        {status && <Status className="poll-search-status">{status}</Status>}
        {showForm && <div className="poll-search-results" aria-label="Movie search results">{movies.map(movie => <article className="poll-search-result" key={movie.tmdbId}>
          <Poster className="poll-search-poster" url={movie.posterUrl} title={movie.title} /><div><h3>{movie.title}</h3><p>{movie.description}</p><a href={movie.pageUrl} target="_blank" rel="noopener noreferrer">TMDB</a><Button variant="secondary" disabled={!canSuggest} onClick={() => suggest(movie.title, movie)}>{can(state, 'vote') ? 'Suggest & vote' : 'Suggest'}</Button></div>
        </article>)}{searched && <Button variant="quiet" className="poll-title-only" disabled={!canSuggest} onClick={() => suggest(searched)}>Suggest “{searched}” without a poster</Button>}</div>}
      </div>
      {can(state, 'finishPoll') && <div className="poll-finish"><Button ref={finishButton} variant="quiet" disabled={!state.connected} onClick={() => { setStatus(''); setConfirmFinish(true); }}>Finish poll</Button></div>}
    </div>
    {confirmFinish && <Dialog title="Finish this poll?" onClose={() => setConfirmFinish(false)} returnFocusRef={finishButton} initialFocusRef={keepVoting} busy={finishing}>
      <DialogHeader title="Finish this poll?" /><p>Close voting and post {total ? 'the result' : 'a result with no votes'} in chat. Everyone can keep voting until you finish.</p>
      {status && <Status>{status}</Status>}
      <div className="confirmation-actions"><Button ref={keepVoting} disabled={finishing} onClick={() => setConfirmFinish(false)}>Keep voting</Button><Button variant="primary" pending={finishing} pendingLabel="Finishing…" disabled={!state.connected || !can(state, 'finishPoll')} onClick={() => { if (sendPoll({ type: 'finish-video-poll' }) === false) { setStatus('Reconnect before finishing the poll.'); return; } requestedFinish.current = true; setFinishing(true); }}>Finish poll</Button></div>
    </Dialog>}
  </section>;
}
