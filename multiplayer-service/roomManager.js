import { randomBytes } from "node:crypto";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 8;
const MAX_STATE_BYTES = 256 * 1024;
const makeCode = () => Array.from(randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join("");
const cleanName = value => String(value ?? "").trim().replace(/[<>\\u0000-\\u001f]/g, "").slice(0, 24) || "Игрок";
const cleanText = (value, max = 100) => String(value ?? "").trim().replace(/[<>\\u0000-\\u001f]/g, "").slice(0, max);

export class RoomManager {
  constructor({ now = Date.now, codeFactory = makeCode, tokenFactory = () => randomBytes(24).toString("base64url"), disconnectGraceMs = 90000 } = {}) {
    Object.assign(this, { now, codeFactory, tokenFactory, disconnectGraceMs });
    this.rooms = new Map();
  }
  createRoom(name) {
    let code;
    do { code = this.codeFactory(); } while (this.rooms.has(code));
    const player = this.#newPlayer(name);
    const room = { code, hostId: player.id, players: new Map([[player.id, player]]), status: "lobby", config: { scenarioId: "", scenarioName: "", gameMode: "standard", settings: {} }, state: null, diplomacyMessages: [], savedAssignments: {}, createdAt: this.now(), updatedAt: this.now() };
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
    player.countryId = room.savedAssignments?.[player.name] || null;
    room.players.set(player.id, player); room.updatedAt = this.now();
    return { room: this.snapshot(room), player: this.#credentials(player), reconnected: false };
  }
  configureLobby(code, playerId, config = {}) {
    const room = this.#requireRoom(code);
    this.#assertHost(room, playerId);
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    const scenarioId = cleanText(config.scenarioId, 100);
    const scenarioName = cleanText(config.scenarioName, 120);
    const gameMode = cleanText(config.gameMode || "standard", 40) || "standard";
    const settings = config.settings && typeof config.settings === "object" && !Array.isArray(config.settings) ? this.#validateState(config.settings) : {};
    room.config = { scenarioId, scenarioName, gameMode, settings };
    room.updatedAt = this.now();
    return this.snapshot(room);
  }
  assignCountry(code, hostId, targetPlayerId, countryId) {
    const room = this.#requireRoom(code);
    this.#assertHost(room, hostId);
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    const target = room.players.get(String(targetPlayerId));
    if (!target) throw new Error("PLAYER_NOT_FOUND");
    const nextCountry = cleanText(countryId, 80);
    if (nextCountry && [...room.players.values()].some(p => p.id !== target.id && p.countryId === nextCountry)) throw new Error("COUNTRY_ALREADY_ASSIGNED");
    target.countryId = nextCountry || null;
    room.savedAssignments ||= {};
    room.savedAssignments[target.name] = nextCountry || null;
    room.updatedAt = this.now();
    return this.snapshot(room);
  }
  startGame(code, playerId, state = null) {
    const room = this.#requireRoom(code);
    this.#assertHost(room, playerId);
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    if (!room.config.scenarioId || !room.config.scenarioName) throw new Error("SCENARIO_REQUIRED");
    if ([...room.players.values()].some(p => !p.countryId)) throw new Error("COUNTRIES_NOT_ASSIGNED");
    room.status = "playing"; if (state != null) room.state = this.#validateState(state); room.updatedAt = this.now();
    return this.snapshot(room);
  }
  restoreRoom(code, playerId, saved) {
    const room = this.#requireRoom(code);
    this.#assertHost(room, playerId);
    if (room.status !== "lobby") throw new Error("GAME_ALREADY_STARTED");
    if (!saved || !saved.config || !Array.isArray(saved.players)) throw new Error("INVALID_SAVE");
    room.config = this.#validateState(saved.config);
    room.state = this.#validateState(saved.state ?? null);
    const assignments = new Map(Object.entries(saved.savedAssignments || {}));
    for (const p of saved.players) if (p.countryId) assignments.set(cleanName(p.name), p.countryId);
    room.savedAssignments = Object.fromEntries(assignments);
    const used = new Set();
    for (const player of room.players.values()) {
      const countryId = assignments.get(player.name) || null;
      if (countryId && used.has(countryId)) throw new Error("INVALID_SAVE");
      if (countryId) used.add(countryId);
      player.countryId = countryId;
    }
    room.status = "lobby";
    room.updatedAt = this.now();
    return this.snapshot(room);
  }
  updateState(code, playerId, state) {
    const room = this.#requireRoom(code);
    this.#assertHost(room, playerId);
    if (room.status !== "playing") throw new Error("GAME_NOT_STARTED");
    room.state = this.#validateState(state); room.updatedAt = this.now();
    return this.snapshot(room);
  }
  sendDiplomaticMessage(code, playerId, input = {}) {
    const room = this.#requireRoom(code);
    if (room.status !== "playing") throw new Error("GAME_NOT_STARTED");
    const sender = room.players.get(String(playerId));
    if (!sender?.countryId) throw new Error("COUNTRY_NOT_ASSIGNED");
    const fromCountry = cleanText(input.fromCountry, 80);
    const toCountry = cleanText(input.toCountry, 80);
    const threadId = cleanText(input.threadId, 120);
    const text = String(input.text ?? "").trim().replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/g, "").slice(0, 4000);
    if (!fromCountry || fromCountry !== sender.countryId) throw new Error("SENDER_COUNTRY_MISMATCH");
    if (!toCountry || !threadId || !text) throw new Error("INVALID_DIPLOMATIC_MESSAGE");
    const recipient = [...room.players.values()].find(p => p.countryId === toCountry && p.connected);
    if (!recipient) return { delivery: "ai", message: null, recipientPlayerId: null };
    const message = {
      id: this.tokenFactory(), threadId, fromCountry, toCountry,
      fromPlayerId: sender.id, toPlayerId: recipient.id,
      text, createdAt: this.now(),
    };
    room.diplomacyMessages ||= [];
    room.diplomacyMessages.push(message);
    if (room.diplomacyMessages.length > 2000) room.diplomacyMessages.splice(0, room.diplomacyMessages.length - 2000);
    room.updatedAt = this.now();
    return { delivery: "human", message, recipientPlayerId: recipient.id };
  }
  diplomacyHistory(code, playerId, threadId) {
    const room = this.#requireRoom(code);
    const player = room.players.get(String(playerId));
    if (!player?.countryId) throw new Error("COUNTRY_NOT_ASSIGNED");
    const id = cleanText(threadId, 120);
    return (room.diplomacyMessages || []).filter(message =>
      message.threadId === id &&
      (message.fromPlayerId === player.id || message.toPlayerId === player.id)
    );
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
    return { code: room.code, hostId: room.hostId, status: room.status, config: room.config, players: [...room.players.values()].map(({id,name,countryId,connected}) => ({id,name,countryId,connected})), state: room.state, savedAssignments: room.savedAssignments || {}, createdAt: room.createdAt, updatedAt: room.updatedAt };
  }
  #newPlayer(name) { return { id: randomBytes(12).toString("hex"), token: this.tokenFactory(), name: cleanName(name), countryId: null, connected: true, disconnectedAt: null }; }
  #credentials(player) { return { id: player.id, reconnectToken: player.token }; }
  #assertHost(room, playerId) { if (room.hostId !== playerId) throw new Error("HOST_ONLY"); }
  #requireRoom(code) { const room = this.rooms.get(String(code ?? "").toUpperCase()); if (!room) throw new Error("ROOM_NOT_FOUND"); return room; }
  #validateState(state) {
    if (state == null) return null;
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_STATE_BYTES) throw new Error("STATE_TOO_LARGE");
    return JSON.parse(serialized);
  }
}
export { MAX_PLAYERS, MAX_STATE_BYTES };
