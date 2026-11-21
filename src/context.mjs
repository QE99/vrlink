// Visibility-aware context assembly.
// A public reply must never see private memories or private events.
const RANK = { public: 0, group: 1, private: 2, internal: 3 };

export function visibilityAllows(requestVisibility, itemVisibility) {
  if (requestVisibility === "internal") return true;
  const requestRank = RANK[requestVisibility];
  const itemRank = RANK[itemVisibility];
  if (requestRank === undefined || itemRank === undefined) return false;
  if (requestVisibility === "public") return itemVisibility === "public";
  if (requestVisibility === "group") return itemVisibility === "public" || itemVisibility === "group";
  if (requestVisibility === "private") return itemVisibility !== "internal";
  return false;
}

export function buildContext({ events = [], memories = [], requestVisibility = "private", limit = 24 }) {
  const filteredEvents = events
    .filter((event) => visibilityAllows(requestVisibility, event.visibility ?? "private"))
    .slice(-limit);
  const filteredMemories = memories.filter((memory) =>
    visibilityAllows(requestVisibility, memory.visibility ?? "private"),
  );
  return {
    events: filteredEvents,
    memories: filteredMemories,
    visibility: requestVisibility,
  };
}
