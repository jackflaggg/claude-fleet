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

function postJson(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Ответ с борда идёт через канал Claude Code; маршруты живут только при FLEET_CHANNEL=1. */
export function sendPermission(sessionId, behavior) {
  return postJson('/channel/permission/' + encodeURIComponent(sessionId), { behavior });
}

export function sendReply(sessionId, text) {
  return postJson('/channel/message/' + encodeURIComponent(sessionId), { text });
}
