import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SaveStore {
  constructor({ filePath = process.env.SAVE_FILE || "/data/saves.json", now = Date.now } = {}) {
    this.filePath = filePath; this.now = now; this.saves = []; this.ready = this.#load();
  }
  async #load() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { const data = JSON.parse(await readFile(this.filePath, "utf8")); this.saves = Array.isArray(data) ? data : []; }
    catch (error) { if (error.code !== "ENOENT") throw error; this.saves = []; await this.#persist(); }
  }
  async #persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    await writeFile(temp, JSON.stringify(this.saves), "utf8");
    await rename(temp, this.filePath);
  }
  async list(ownerKey) {
    await this.ready;
    return this.saves.filter(s => s.ownerKey === ownerKey).map(({ id, name, createdAt, updatedAt, scenarioName, status }) => ({ id, name, createdAt, updatedAt, scenarioName, status }));
  }
  async save(ownerKey, name, room) {
    await this.ready;
    const cleanName = String(name ?? "").trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, 60);
    if (!cleanName) throw new Error("SAVE_NAME_REQUIRED");
    const now = this.now();
    const existing = this.saves.find(s => s.ownerKey === ownerKey && s.name.toLowerCase() === cleanName.toLowerCase());
    const entry = { id: existing?.id || randomUUID(), ownerKey, name: cleanName, scenarioName: room.config.scenarioName, status: room.status, config: room.config, state: room.state, players: room.players, createdAt: existing?.createdAt || now, updatedAt: now };
    if (existing) this.saves = this.saves.map(s => s.id === existing.id ? entry : s); else this.saves.push(entry);
    await this.#persist();
    return { id: entry.id, name: entry.name, scenarioName: entry.scenarioName, status: entry.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
  async get(ownerKey, id) {
    await this.ready;
    const entry = this.saves.find(s => s.ownerKey === ownerKey && s.id === id);
    if (!entry) throw new Error("SAVE_NOT_FOUND");
    return entry;
  }
}
