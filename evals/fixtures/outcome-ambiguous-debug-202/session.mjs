export function selectActiveSession(sessions, requestedId) {
  return sessions.find(session => session.active) ?? null;
}
