import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function nowId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeMembers(members, self) {
  const out = [];
  const add = (member) => {
    const nodeId = String(member?.nodeId ?? member ?? "").trim();
    if (!nodeId || out.some((item) => item.nodeId === nodeId)) return;
    out.push({ nodeId, name: String(member?.name ?? "") });
  };
  add(self);
  for (const member of members ?? []) add(member);
  return out;
}

function groupView(group) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    createdBy: group.createdBy,
    members: group.members,
    messages: group.messages.slice(-200),
  };
}

/**
 * A group is a local membership list, not a central service.
 * Messages are fanned out by the member's own node over existing 1:1 paths.
 */
export class GroupStore {
  constructor({ dir, identity, name = "" } = {}) {
    if (!dir) throw new Error("GroupStore: dir required");
    if (!identity) throw new Error("GroupStore: identity required");
    this.dir = dir;
    this.identity = identity;
    this.name = name;
    this.file = path.join(dir, "groups.json");
    this.groups = new Map();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      for (const group of saved?.groups ?? []) {
        if (group?.id) this.groups.set(group.id, group);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  async #persist() {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = { v: 1, groups: [...this.groups.values()], savedAt: Date.now() };
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  list() {
    return [...this.groups.values()]
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .map(groupView);
  }

  get(id) {
    const group = this.groups.get(String(id));
    return group ? groupView(group) : null;
  }

  async create({ name, members = [] } = {}) {
    const self = { nodeId: this.identity.publicIdentity().nodeId, name: this.name };
    const group = {
      id: nowId("grp"),
      name: String(name ?? "").trim().slice(0, 80) || "未命名群",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: self.nodeId,
      members: normalizeMembers(members, self),
      messages: [],
    };
    this.groups.set(group.id, group);
    await this.#persist();
    return groupView(group);
  }

  async addMember(id, member) {
    const group = this.groups.get(String(id));
    if (!group) return null;
    const nodeId = String(member?.nodeId ?? "");
    if (nodeId && !group.members.some((item) => item.nodeId === nodeId)) {
      group.members.push({ nodeId, name: String(member?.name ?? "") });
      group.updatedAt = Date.now();
      await this.#persist();
    }
    return groupView(group);
  }

  snapshot(group) {
    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      createdBy: group.createdBy,
      members: group.members,
    };
  }

  snapshotById(id) {
    const group = this.groups.get(String(id));
    return group ? this.snapshot(group) : null;
  }

  async applyRemote(remote) {
    if (!remote?.id) return null;
    const self = this.identity.publicIdentity().nodeId;
    if (remote.dissolved || remote.removedFor === self) {
      this.groups.delete(String(remote.id));
      await this.#persist();
      return null;
    }
    let local = this.groups.get(String(remote.id));
    if (!local) {
      local = {
        id: String(remote.id),
        name: String(remote.name ?? "未命名群").slice(0, 80),
        createdAt: Number(remote.createdAt ?? Date.now()),
        updatedAt: Date.now(),
        createdBy: String(remote.createdBy ?? ""),
        members: normalizeMembers(remote.members ?? [], { nodeId: self, name: this.name }),
        messages: [],
      };
      this.groups.set(local.id, local);
    } else {
      local.name = String(remote.name ?? local.name).slice(0, 80);
      local.createdBy = String(remote.createdBy ?? local.createdBy);
      local.members = normalizeMembers(remote.members ?? local.members, { nodeId: self, name: this.name });
      local.updatedAt = Date.now();
    }
    await this.#persist();
    return groupView(local);
  }

  async removeMember(id, nodeId) {
    const group = this.groups.get(String(id));
    if (!group) return null;
    const index = group.members.findIndex((item) => item.nodeId === String(nodeId));
    if (index < 0) return { group: groupView(group), removed: null };
    const [removed] = group.members.splice(index, 1);
    group.updatedAt = Date.now();
    await this.#persist();
    return { group: groupView(group), removed };
  }

  async dissolve(id) {
    const group = this.groups.get(String(id));
    if (!group) return null;
    const snapshot = this.snapshot(group);
    this.groups.delete(String(id));
    await this.#persist();
    return snapshot;
  }

  async append(id, message) {
    const group = this.groups.get(String(id));
    if (!group) return null;
    const from = String(message?.from ?? this.identity.publicIdentity().nodeId);
    const entry = {
      id: nowId("gmsg"),
      from,
      fromName: String(message?.fromName ?? ""),
      text: String(message?.text ?? "").slice(0, 4000),
      at: Number(message?.at ?? Date.now()),
    };
    if (!entry.text) return groupView(group);
    group.messages.push(entry);
    if (group.messages.length > 500) group.messages.splice(0, group.messages.length - 500);
    group.updatedAt = entry.at;
    await this.#persist();
    return groupView(group);
  }

  async receive({ group, from, fromName = "", text, at } = {}) {
    const remote = group;
    if (!remote?.id || !remote?.members?.some((member) => String(member?.nodeId ?? member) === String(from))) {
      return null;
    }
    let local = this.groups.get(String(remote.id));
    if (!local) {
      const self = { nodeId: this.identity.publicIdentity().nodeId, name: this.name };
      local = {
        id: String(remote.id),
        name: String(remote.name ?? "未命名群").slice(0, 80),
        createdAt: Number(remote.createdAt ?? Date.now()),
        updatedAt: Date.now(),
        createdBy: String(remote.createdBy ?? from),
        members: normalizeMembers(remote.members ?? [], self),
        messages: [],
      };
      this.groups.set(local.id, local);
    } else {
      for (const member of normalizeMembers(remote.members ?? [], { nodeId: this.identity.publicIdentity().nodeId, name: this.name })) {
        if (!local.members.some((item) => item.nodeId === member.nodeId)) local.members.push(member);
      }
    }
    return this.append(local.id, { from, fromName, text, at });
  }
}
