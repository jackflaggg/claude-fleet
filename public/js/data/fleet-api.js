export function connectFleetStream({ onMessage, onConnectionChange }) {
  const stream = new EventSource('/stream');
  stream.onmessage = (event) => {
    let snapshot;
    try {
      snapshot = JSON.parse(event.data);
    } catch {
      // A malformed snapshot is ignored; the following SSE message can recover the board.
      return;
    }
    onMessage(snapshot);
    onConnectionChange(true);
  };
  stream.onerror = () => onConnectionChange(false);
  return () => stream.close();
}

export function focusSession(sessionId) {
  return fetch('/focus/' + encodeURIComponent(sessionId), { method: 'POST' });
}

export function dropSession(sessionId) {
  return fetch('/session/' + encodeURIComponent(sessionId), { method: 'DELETE' });
}
