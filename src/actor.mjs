import { ConsentRequiredError } from "./capability-bus.mjs";
import { buildContext } from "./context.mjs";

/**
 * One character = one actor = one serial event queue.
 * A character thinks one thing at a time; different characters can run in parallel.
 */
export class CharacterActor {
  constructor({ character, store, eventLog, capabilities, brain, scheduler }) {
    this.character = character;
    this.store = store;
    this.eventLog = eventLog;
    this.capabilities = capabilities;
    this.brain = brain;
    this.scheduler = scheduler;
    this.tail = Promise.resolve();
    this.produced = [];
  }

  async enqueue(input) {
    const event = await this.eventLog.append(this.character.id, input);
    const run = this.tail.then(() => this.process(event));
    // keep the chain alive even if one turn fails
    this.tail = run.catch(() => {});
    return run;
  }

  async process(event) {
    const produced = [];
    let replyText = "";
    const currentState = await this.store.state(this.character.id);
    const budget = this.character.budget ?? {};
    const usageBefore = currentUsage(currentState?.usage);
    const overBefore = isOverBudget(usageBefore, budget);

    if (event.type === "message.received" && overBefore) {
      if (budget.overLimit === "stop") {
        throw new BudgetExceededError("今日预算已用完（stop 策略）", { usage: usageBefore, budget });
      }
      if (budget.overLimit === "mute") {
        const system = await this.eventLog.append(this.character.id, {
          type: "system",
          source: { body: "internal", thread: "budget", actor: null },
          visibility: "internal",
          content: { text: "今日预算已用完，暂时不回复（mute 策略）。" },
        });
        await this.store.updateState(this.character.id, { overBudget: true, budgetMutedAt: Date.now() });
        return { input: event, produced: [system] };
      }
    }

    if (event.type === "message.received") {
      const rawEvents = await this.eventLog.read(this.character.id, { limit: 60 });
      const memories = await this.store.listMemory(this.character.id);
      const context = buildContext({
        events: rawEvents,
        memories,
        requestVisibility: event.visibility ?? "private",
        limit: 24,
      });
      const engine = this.character.brain?.engine ?? "mock";
      const result = this.scheduler
        ? await this.scheduler.run({ engine, characterId: this.character.id }, () =>
            this.brain.generate({
              character: this.character,
              event,
              context: context.events,
              memories: context.memories,
            }),
          )
        : await this.brain.generate({
            character: this.character,
            event,
            context: context.events,
            memories: context.memories,
          });

      if (result?.thought) {
        produced.push(
          await this.eventLog.append(this.character.id, {
            type: "thought",
            source: { body: "internal", thread: "mind", actor: null },
            visibility: "internal",
            content: { text: String(result.thought).slice(0, 2000) },
          }),
        );
      }

      const text = String(result?.text ?? "").trim();
      if (text) {
        replyText = text;
        const target = {
          body: event.source?.body ?? "desktop",
          thread: event.source?.thread ?? "main",
          visibility: event.visibility ?? "private",
        };
        if (event.content?.draft) {
          const draft = await this.eventLog.append(this.character.id, {
            type: "message.draft",
            source: { body: target.body, thread: target.thread, actor: null },
            visibility: target.visibility,
            content: { text, draft: true },
          });
          produced.push(draft);
        } else {
          const sent = await this.capabilities.invoke({
            characterId: this.character.id,
            name: "message.send",
            params: { text, target },
            reason: `reply to ${event.id}`,
          });
          if (sent?.event) produced.push(sent.event);
        }
      }
    }

    const state = await this.store.state(this.character.id);
    const usage = nextUsage(state?.usage, event, replyText);
    const overBudget = isOverBudget(usage, budget);
    await this.store.updateState(this.character.id, {
      eventCount: Number(state?.eventCount ?? 0) + 1,
      lastActiveAt: Date.now(),
      lastEventType: event.type,
      usage,
      overBudget,
    });

    return { input: event, produced };
  }
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nextUsage(previous, event, replyText) {
  const base = currentUsage(previous);
  return {
    day: base.day,
    turns: Number(base.turns ?? 0) + (event.type === "message.received" ? 1 : 0),
    tokens: Number(base.tokens ?? 0) + estimateTokens(`${event.content?.text ?? ""}${replyText}`),
    cost: Number(base.cost ?? 0),
  };
}

function currentUsage(previous) {
  const today = dayKey();
  if (previous && previous.day === today) return previous;
  return { day: today, turns: 0, tokens: 0, cost: 0 };
}

function isOverBudget(usage, budget) {
  return (
    (Number.isFinite(budget?.turnsPerDay) && usage.turns >= budget.turnsPerDay) ||
    (Number.isFinite(budget?.tokensPerDay) && usage.tokens >= budget.tokensPerDay) ||
    (Number.isFinite(budget?.costPerDay) && usage.cost >= budget.costPerDay)
  );
}

function estimateTokens(text) {
  // Cheap local estimate; real provider usage should replace this when available.
  return Math.max(1, Math.ceil(String(text ?? "").length / 2));
}

export class ConsentRequired extends ConsentRequiredError {}

export class BudgetExceededError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.detail = detail;
  }
}

export function createActorFactory({ store, eventLog, capabilities, makeBrain, scheduler }) {
  const actors = new Map();
  return {
    async get(characterId) {
      if (actors.has(characterId)) return actors.get(characterId);
      const character = await store.load(characterId);
      const brain = await makeBrain(character);
      const actor = new CharacterActor({ character, store, eventLog, capabilities, brain, scheduler });
      actors.set(characterId, actor);
      return actor;
    },
    list() {
      return [...actors.keys()];
    },
    invalidate(characterId) {
      actors.delete(characterId);
    },
  };
}
