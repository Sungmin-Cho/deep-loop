export function selectActiveSession(sessions, requestedId) {
  return sessions.find(session => session.id === requestedId && session.active) ?? null;
}
