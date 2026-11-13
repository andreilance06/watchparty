import { useEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { Button, Field, request, Status } from './shared.jsx';
import { useRoom } from './room.jsx';

function Poster({ url, title, className }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={`${className}${!url || failed ? ' movie-poster-placeholder' : ''}`}>{url && !failed ? <img src={url} alt={`Poster for ${title}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : 'No poster'}</div>;
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
  return <div className="poll-launcher"><Button disabled={!state.connected} pending={starting} pendingLabel="Starting…" onClick={() => {
    if (sent.current || !state.connected) return;
    if (send({ type: 'start-video-poll' }) === false) { setStatus('Reconnect before starting a poll.'); return; }
    sent.current = true; setStarting(true); setStatus(''); onStart?.();
  }}>Start poll</Button>{status && <Status tone="error">{status}</Status>}</div>;
}
export function Poll({ expanded, onToggle, disclosure = true }) {
  const { state, send } = useRoom();
  const { poll, suggestions: options } = state;
  const [query, setQuery] = useState(''), [searched, setSearched] = useState(''), [movies, setMovies] = useState([]);
  const [status, setStatus] = useState(''), [searching, setSearching] = useState(false);
  const searchRef = useRef(null), input = useRef(null);
  const canSuggest = state.connected && poll.status === 'open' && can(state, 'suggestTitles');
  useEffect(() => {
    searchRef.current?.abort(); setQuery(''); setSearched(''); setMovies([]); setStatus(''); setSearching(false);
    return () => searchRef.current?.abort();
  }, [poll.id, poll.status, state.connected]);
  if (poll.status !== 'open') return null;
  function sendPoll(payload) {
    const permission = { 'finish-video-poll': 'finishPoll', 'suggest-video': 'suggestTitles', 'vote-video': 'vote' }[payload.type];
    if (!state.connected || permission && !can(state, permission)) return false;
    return send({ ...payload, pollId: poll.id });
  }
  function suggest(title, movie) {
    if (!canSuggest || sendPoll({ type: 'suggest-video', title, ...(movie ? { movie } : {}) }) === false) { setStatus('Reconnect before suggesting a movie.'); return; }
    setQuery(''); setSearched(''); setMovies([]); setStatus(`Suggested “${title}”. ${can(state, 'vote') ? 'Your vote is recorded automatically.' : ''}`); input.current?.focus();
  }
  async function search(event) {
    event.preventDefault();
    if (!canSuggest) return;
    const title = query.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title.length < 2) { setStatus('Enter at least two characters to search.'); return; }
    searchRef.current?.abort(); const controller = new AbortController(); searchRef.current = controller;
    setSearching(true); setMovies([]); setSearched(''); setStatus('Searching Wikipedia for movie matches…');
    try {
      const result = await request(`/api/movies/search?q=${encodeURIComponent(title)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const choices = Array.isArray(result.movies) ? result.movies : [];
      setMovies(choices); setSearched(title); setStatus(choices.length ? `Choose the matching movie for “${title}”.` : `No matches for “${title}”. You can still suggest it without a poster.`);
    } catch (error) {
      if (!controller.signal.aborted) { setSearched(title); setStatus(`${error.message} You can still suggest the title without a poster.`); }
    } finally { if (!controller.signal.aborted) setSearching(false); }
  }
  const total = options.reduce((sum, item) => sum + Math.max(0, Number(item.votes) || 0), 0);
  const high = Math.max(0, ...options.map(item => item.votes || 0));
  const leaders = options.filter(item => item.votes === high && high > 0);
  const leader = !leaders.length ? options.length ? 'No votes yet.' : 'No suggestions yet.' : `${leaders.length > 1 ? 'Tie' : 'Leading'}: ${leaders.map(item => item.title).join(', ')} (${high} ${high === 1 ? 'vote' : 'votes'}${leaders.length > 1 ? ' each' : ''})`;
  return <section className="vote-panel" aria-labelledby="vote-title">
    <div className="vote-heading"><div><p className="eyebrow">UP NEXT</p><h2 id="vote-title">Movie poll</h2></div><span className="vote-status" role="status" aria-live="polite" aria-atomic="true"><span className="sr-only">Movie poll: </span>{total} {total === 1 ? 'vote' : 'votes'} cast</span></div>
    <p className="vote-leader">{leader}</p>
    {disclosure && <Button variant={expanded ? 'secondary' : 'primary'} className="poll-toggle" aria-expanded={expanded} aria-controls="pollDetails" onClick={onToggle}>{expanded ? 'Hide poll' : can(state, 'vote') ? 'Vote on next movie' : 'View movie poll'}</Button>}
    <div id="pollDetails" className="poll-details" hidden={!expanded}>
      <p className="poll-explanation">Choose what to watch next. The host still selects the video file.</p>
      {!can(state, 'suggestTitles') && <p className="poll-explanation">The host has disabled movie suggestions for you.</p>}
      {!can(state, 'vote') && <p className="poll-explanation">You can view this poll. Ask the host to enable voting for you.</p>}
      <form className="suggestion-form" autoComplete="off" onSubmit={search}><Field label="Suggest a video title" id="suggestionInput" name="title" ref={input} value={query} onChange={event => setQuery(event.target.value)} maxLength={80} placeholder="Search for a movie..." required disabled={!canSuggest} /><Button type="submit" variant="primary" disabled={!canSuggest} pending={searching} pendingLabel="Searching…">Find movie</Button></form>
      <Status className="suggestion-status">{status}</Status>
      <div className="suggestion-results" aria-label="Movie search results">{movies.map(movie => <article className="movie-search-result" key={movie.pageId}>
        <Poster className="movie-search-poster" url={movie.posterUrl} title={movie.title} /><div className="movie-search-details"><h3>{movie.title}</h3><p>{movie.description}</p><a href={movie.pageUrl} target="_blank" rel="noopener noreferrer">Wikipedia</a><Button variant="primary" className="movie-search-select" disabled={!canSuggest} onClick={() => suggest(movie.title, movie)}>{can(state, 'vote') ? 'Suggest & vote' : 'Suggest'}</Button></div>
      </article>)}{searched && <Button className="suggestion-title-only" disabled={!canSuggest} onClick={() => suggest(searched)}>Suggest “{searched}” without a poster</Button>}</div>
      <div className="vote-options" aria-label="Next-video options">{!options.length && <p className="vote-empty">Suggest a title to start voting.</p>}{options.map(option => {
        const votes = Math.max(0, Number(option.votes) || 0), percentage = total ? Math.round(votes / total * 100) : 0, selected = option.id === state.myVoteId;
        return <article key={option.id} className={`vote-option${selected ? ' selected' : ''}`}>
          <Poster className="vote-poster" url={option.movie?.posterUrl} title={option.title} /><div className="vote-option-details"><h3>{option.title}</h3><span className="vote-count">{votes} {votes === 1 ? 'vote' : 'votes'} · {percentage}%</span><div className="vote-meter" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div>{option.movie?.description && <p className="vote-description">{option.movie.description}</p>}{option.movie?.pageUrl && <a className="vote-source" href={option.movie.pageUrl} target="_blank" rel="noopener noreferrer">Wikipedia</a>}<p className="vote-suggester">Suggested by {option.ownerName || 'a participant'}</p></div>
          <Button className="vote-button" aria-pressed={selected} aria-label={`${selected ? 'Your vote for' : 'Vote for'} ${option.title}`} disabled={selected || !state.connected || !can(state, 'vote')} onClick={() => sendPoll({ type: 'vote-video', suggestionId: option.id })}>{selected ? 'Your vote' : 'Vote'}</Button>
          {option.canRemove && <Button variant="danger" className="vote-remove-button" aria-label={`Remove suggestion for ${option.title}`} disabled={!state.connected} onClick={() => sendPoll({ type: 'remove-video-suggestion', suggestionId: option.id })}>Remove</Button>}
        </article>;
      })}</div>
      {can(state, 'finishPoll') && <div className="poll-management"><p>Finishing closes voting and posts the result in chat.</p><Button variant="quiet" className="finish-poll-button" disabled={!state.connected} onClick={() => sendPoll({ type: 'finish-video-poll' })}>Finish poll</Button></div>}
    </div>
  </section>;
}
