// Rebuild derived state from the append-only event log.
// This is intentionally conservative: it preserves mood/energy from the previous state
// and only recomputes counters/usage that we can prove from events.
export function rebuildStateFromEvents(events, previous = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const eventDay = (event) => {
    const time = new Date(event.at).getTime();
    return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
  };
  // Signed genesis/legacy events may have no `at`; they must not crash recovery.
  const todayEvents = events.filter((event) => eventDay(event) === today);
  const received = todayEvents.filter((event) => event.type === "message.received");
  const tokens = todayEvents.reduce(
    (sum, event) => sum + Math.max(1, Math.ceil(String(event.content?.text ?? "").length / 2)),
    0,
  );
  const last = events[events.length - 1] ?? null;
  return {
    ...previous,
    eventCount: events.length,
    lastActiveAt: last?.at ?? previous.lastActiveAt ?? null,
    lastEventType: last?.type ?? previous.lastEventType ?? null,
    usage: {
      day: today,
      turns: received.length,
      tokens,
      cost: Number(previous?.usage?.cost ?? 0),
    },
    recoveredAt: Date.now(),
  };
}
