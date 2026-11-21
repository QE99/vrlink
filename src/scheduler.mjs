// Engine-aware scheduler.
// API fish can run concurrently (bounded by provider limit); local fish share one GPU slot.
// This is intentionally small: it serializes local work and bounds API work, nothing else.
export class EngineScheduler {
  constructor({ apiConcurrency = 4, localConcurrency = 1 } = {}) {
    this.groups = new Map([
      ["api", { limit: Math.max(1, apiConcurrency), active: 0, done: 0, queue: [] }],
      ["local", { limit: Math.max(1, localConcurrency), active: 0, done: 0, queue: [] }],
    ]);
  }

  run({ engine = "api", characterId = "" }, job) {
    const groupName = engine === "local" ? "local" : "api";
    const group = this.groups.get(groupName);
    if (!group) throw new Error(`unknown engine group: ${groupName}`);
    if (typeof job !== "function") throw new Error("scheduler job must be a function");
    return new Promise((resolve, reject) => {
      group.queue.push({ characterId, job, resolve, reject, enqueuedAt: Date.now() });
      this.pump(groupName);
    });
  }

  pump(groupName) {
    const group = this.groups.get(groupName);
    while (group.active < group.limit && group.queue.length) {
      const task = group.queue.shift();
      group.active += 1;
      const startedAt = Date.now();
      Promise.resolve()
        .then(task.job)
        .then(
          (value) => task.resolve(value),
          (error) => task.reject(error),
        )
        .finally(() => {
          group.active -= 1;
          group.done += 1;
          this.last = { group: groupName, characterId: task.characterId, ms: Date.now() - startedAt };
          this.pump(groupName);
        });
    }
  }

  status() {
    return {
      api: describeGroup(this.groups.get("api")),
      local: describeGroup(this.groups.get("local")),
      last: this.last ?? null,
    };
  }
}

function describeGroup(group) {
  return {
    active: group.active,
    limit: group.limit,
    done: group.done,
    queued: group.queue.map((task) => ({ characterId: task.characterId, enqueuedAt: task.enqueuedAt })),
  };
}
