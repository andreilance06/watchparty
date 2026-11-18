const stages = [
  ['opening', 'Loading the room interface…'],
  ['checking', 'Checking room access…'],
  ['connecting', 'Connecting to the room…'],
];

export function RoomLoading({ phase = 'opening', roomName, error }) {
  const step = stages.findIndex(([stage]) => stage === phase);
  const title = error ? 'Couldn’t join the room' : roomName ? `Joining ${roomName}` : 'Joining your room';

  return <main className="room-loading">
    <div className="room-loading-inner">
      <div className="room-loading-screen" aria-hidden="true"><span className="brand-mark" /></div>
      <div role={error ? 'alert' : 'status'} aria-atomic="true">
        <h1>{title}</h1>
        <p>{error || stages[step]?.[1]}</p>
      </div>
      {!error && <div className="room-loading-progress" aria-hidden="true">
        {stages.map(([stage], index) => <span key={stage} className={index === step ? 'is-current' : index < step ? 'is-complete' : undefined} />)}
      </div>}
      <div className="room-loading-actions">
        {error && <a className="ui-button ui-button--primary" href={location.pathname + location.search}>Try again</a>}
        <a className="ui-button ui-button--quiet" href="/">Back to rooms</a>
      </div>
    </div>
  </main>;
}
