import { useEffect, useRef, useState } from 'react';
import { can } from '../js/permissions.js';
import { request, Status } from './shared.jsx';
import { useRoom } from './room.jsx';

function Poster({ url, title, className }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={`${className}${!url || failed ? ' movie-poster-placeholder' : ''}`}>{url && !failed ? <img src={url} alt={`Poster for ${title}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : 'No poster'}</div>;
}
export function Poll({ expanded, onToggle }) {
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
    <div className="vote-heading"><div><p className="eyebrow">UP NEXT</p><h2 id="vote-title">Movie poll</h2></div><button className="poll-toggle" aria-expanded={expanded} aria-controls="pollDetails" onClick={onToggle}>{expanded ? 'Collapse poll' : 'Expand poll'}</button>{can(state, 'finishPoll') && <button className="finish-poll-button" disabled={!state.connected} onClick={() => sendPoll({ type: 'finish-video-poll' })}>Finish poll</button>}<span className="vote-status" aria-live="polite">{total} {total === 1 ? 'vote' : 'votes'} cast</span></div>
    <p className="vote-leader" aria-live="polite">{leader}</p>
    <div id="pollDetails" className="poll-details" hidden={!expanded}>
      <form className="suggestion-form" autoComplete="off" onSubmit={search}><label className="sr-only" htmlFor="suggestionInput">Suggest a video title</label><input id="suggestionInput" name="title" ref={input} value={query} onChange={event => setQuery(event.target.value)} maxLength={80} placeholder="Search for a movie..." required disabled={!canSuggest} /><button type="submit" disabled={!canSuggest || searching}>Find movie</button></form>
      <Status className="suggestion-status">{status}</Status>
      <div className="suggestion-results" aria-label="Movie search results">{movies.map(movie => <article className="movie-search-result" key={movie.pageId}>
        <Poster className="movie-search-poster" url={movie.posterUrl} title={movie.title} /><div className="movie-search-details"><h3>{movie.title}</h3><p>{movie.description}</p><a href={movie.pageUrl} target="_blank" rel="noopener noreferrer">Wikipedia</a><button className="movie-search-select" disabled={!canSuggest} onClick={() => suggest(movie.title, movie)}>{can(state, 'vote') ? 'Suggest & vote' : 'Suggest'}</button></div>
      </article>)}{searched && <button className="suggestion-title-only" disabled={!canSuggest} onClick={() => suggest(searched)}>Suggest “{searched}” without a poster</button>}</div>
      <div className="vote-options" aria-live="polite" aria-label="Next-video options">{!options.length && <p className="vote-empty">Suggest a title to start voting.</p>}{options.map(option => {
        const votes = Math.max(0, Number(option.votes) || 0), percentage = total ? Math.round(votes / total * 100) : 0, selected = option.id === state.myVoteId;
        return <article key={option.id} className={`vote-option${selected ? ' selected' : ''}`}>
          <Poster className="vote-poster" url={option.movie?.posterUrl} title={option.title} /><div className="vote-option-details"><h3>{option.title}</h3><span className="vote-count">{votes} {votes === 1 ? 'vote' : 'votes'} · {percentage}%</span><div className="vote-meter" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div>{option.movie?.description && <p className="vote-description">{option.movie.description}</p>}{option.movie?.pageUrl && <a className="vote-source" href={option.movie.pageUrl} target="_blank" rel="noopener noreferrer">Wikipedia</a>}<p className="vote-suggester">Suggested by {option.ownerName || 'a participant'}</p></div>
          <button className="vote-button" aria-pressed={selected} aria-label={`${selected ? 'Your vote for' : 'Vote for'} ${option.title}`} disabled={selected || !state.connected || !can(state, 'vote')} onClick={() => sendPoll({ type: 'vote-video', suggestionId: option.id })}>{selected ? 'Your vote' : 'Vote'}</button>
          {option.canRemove && <button className="vote-remove-button" aria-label={`Remove suggestion for ${option.title}`} disabled={!state.connected} onClick={() => sendPoll({ type: 'remove-video-suggestion', suggestionId: option.id })}>Remove</button>}
        </article>;
      })}</div>
    </div>
  </section>;
}
