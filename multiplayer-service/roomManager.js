import { randomBytes } from "node:crypto";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 8;
const MAX_STATE_BYTES = 256 * 1024;
const makeCode = () => Array.from(randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join("");
const cleanName = value => String(value ?? "").trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, 24) || "Игрок";

export class RoomManager {
  constructor({ now = Date.now, codeFactory = makeCode, tokenFactory = () => randomBytes(24).toString("base64url"), disconnectGraceMs = 90000 } = {}) {
    Object.assign(this, { now, codeFactory, tokenFactory, disconnectGraceMs });
    this.rooms = new Map();
  }
  createRoom(name) {
    let code;
    do { code = this.codeFactory(); } while (this.rooms.has(code));
    const player = this.#newPlayer(name);
    const room = { code, hostId: player.id, players: new Map([[player.id, player]]), status: "lobby", state: null, createdAt: this.now(), updatedAt: this.now() };
    this.rooms.set(code, room);
    return { room: this.snapshot(room), player: this.#credentials(player) };
  }
  joinRoom(value, name, reconnectToken) {
    const code = String(value ?? "").trim().toUpperCase();
    const room = this.#requireRoom(code);
    if (reconnectToken) {
      const old = [...room.players.values()].find(p => p.token === reconnectToken);
      if (old) { old.name = cleanName(name || old.name); old.connected = true; old.disconnectedAt = null; room.updatedAt = this.now(); return { room: this.snapshot(room), player: this.#credentials(old), reconnected: true }; }
    }
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    if (room.players.size >= MAX_PLAYERS) throw new Error("ROOM_FULL");
    const player = this.#newPlayer(name);
    room.players.set(player.id, player); room.updatedAt = this.now();
    return { room: this.snapshot(room), player: this.#credentials(player), reconnected: false };
  }
  setCountry(code, playerId, countryId) {
    const room = this.#requireRoom(code);
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    const player = room.players.get(playerId);
    if (!player) throw new Error("PLAYER_NOT_FOUND");
    player.countryId = String(countryId ?? "").trim().slice(0, 80) || null;
    room.updatedAt = this.now();
    return this.snapshot(room);
  }
  startGame(code, playerId, state = null) {
    const room = this.#requireRoom(code);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    room.status = "playing"; room.state = this.#validateState(state); room.updatedAt = this.now();
    return this.snapshot(room);
  }
  updateState(code, playerId, state) {
    const room = this.#requireRoom(code);
    if (room.hostId !== playerId) throw new Error("HOST_ONLY");
    if (room.status !== "playing") throw new Error("GAME_NOT_STARTED");
    room.state = this.#validateState(state); room.updatedAt = this.now();
    return this.snapshot(room);
  }
  disconnect(code, playerId) {
    const player = this.rooms.get(code)?.players.get(playerId);
    if (!player) return null;
    player.connected = false; player.disconnectedAt = this.now();
    const room = this.rooms.get(code); room.updatedAt = this.now();
    return this.snapshot(room);
  }
  removeExpiredPlayers() {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      for (const [id, player] of room.players) if (!player.connected && player.disconnectedAt !== null && now - player.disconnectedAt > this.disconnectGraceMs) room.players.delete(id);
      if (!room.players.size) this.rooms.delete(code);
      else if (!room.players.has(room.hostId)) { room.hostId = room.players.keys().next().value; room.updatedAt = now; }
    }
  }
  snapshot(value) {
    const room = typeof value === "string" ? this.#requireRoom(value) : value;
    return { code: room.code, hostId: room.hostId, status: room.status, players: [...room.players.values()].map(({id,name,countryId,connected}) => ({id,name,countryId,connected})), state: room.state, createdAt: room.createdAt, updatedAt: room.updatedAt };
  }
  #newPlayer(name) { return { id: randomBytes(12).toString("hex"), token: this.tokenFactory(), name: cleanName(name), countryId: null, connected: true, disconnectedAt: null }; }
  #credentials(player) { return { id: player.id, reconnectToken: player.token }; }
  #requireRoom(code) { const room = this.rooms.get(String(code ?? "").toUpperCase()); if (!room) throw new Error("ROOM_NOT_FOUND"); return room; }
  #validateState(state) {
    if (state == null) return null;
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_STATE_BYTES) throw new Error("STATE_TOO_LARGE");
    return JSON.parse(serialized);
  }
}
export { MAX_PLAYERS, MAX_STATE_BYTES };