import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile as readStoredFile, rename } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { RoomManager } from "./roomManager.js";
import { SaveStore } from "./saveStore.js";
const PORT = Number(process.env.PORT || 3001);
const HERE = dirname(fileURLToPath(import.meta.url));
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const rooms = new RoomManager();
const saves = new SaveStore();
const persistRooms = async () => { try { await saves.saveRooms(rooms.dump()); } catch (error) { console.error("Could not persist multiplayer rooms:", error); } };
const scenarioDir = process.env.SCENARIO_DIR || "/data/scenarios";
const turnDir = process.env.TURN_DIR || "/data/turns";
const MAX_SCENARIO_BYTES = 100 * 1024 * 1024;
const MAX_TURN_BYTES = 100 * 1024 * 1024;
const MAX_AI_CONFIG_BYTES = 1024 * 1024;
const MAX_AI_REQUEST_BYTES = 12 * 1024 * 1024;
const sessions = new Map();
const aiConfigs = new Map();

async function readJsonRequest(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateAiConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_AI_CONFIG");
  const allowed = new Set(["gemini", "openai", "anthropic", "openai-compatible", "anthropic-compatible"]);
  const connections = (Array.isArray(value.connections) ? value.connections : []).slice(0, 30).map((item) => {
    const id = String(item?.id || "").slice(0, 100);
    const provider = String(item?.provider || "");
    const apiKey = String(item?.apiKey || "").trim().slice(0, 8192);
    if (!id || !allowed.has(provider) || !apiKey) throw new Error("INVALID_AI_CONNECTION");
    const endpoint = String(item?.endpoint || "").slice(0, 2048);
    if (["openai-compatible", "anthropic-compatible"].includes(provider)) {
      const parsed = new URL(endpoint);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("INVALID_AI_ENDPOINT");
    }
    return {
      id, provider, apiKey, endpoint,
      name: String(item?.name || provider).slice(0, 100),
      customParams: String(item?.customParams || "").slice(0, 8192),
      toolStrict: item?.toolStrict === true,
      suggestedModel: String(item?.suggestedModel || "").slice(0, 160),
    };
  });
  const connectionIds = new Set(connections.map((item) => item.id));
  const fallbackList = (Array.isArray(value.fallbackList) ? value.fallbackList : []).slice(0, 100)
    .filter((entry) => connectionIds.has(String(entry?.connectionId || "")))
    .map((entry) => ({
      id: String(entry.id || "").slice(0, 100),
      connectionId: String(entry.connectionId || "").slice(0, 100),
      model: String(entry.model || "").slice(0, 160),
      customParamsOverride: String(entry.customParamsOverride || "").slice(0, 8192),
      structuredMode: String(entry.structuredMode || "auto").slice(0, 40),
    }));
  const entryIds = new Set(fallbackList.map((entry) => entry.id));
  const taskPicks = Object.fromEntries(Object.entries(value.taskPicks && typeof value.taskPicks === "object" ? value.taskPicks : {})
    .filter(([key, entryId]) => /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(key) && entryIds.has(entryId)));
  return { connections, fallbackList, taskPicks };
}

function publicAiConfig(config) {
  return {
    connections: config.connections.map((connection) => ({ ...connection, apiKey: `VPI15_PROXY_KEY:${connection.id}` })),
    fallbackList: config.fallbackList,
    taskPicks: config.taskPicks,
  };
}

function connectionForAiRequest(config, target, headers) {
  const haystack = `${target} ${JSON.stringify(headers || {})}`;
  const match = /VPI15_PROXY_KEY:([A-Za-z0-9_-]+)/.exec(haystack);
  if (!match) throw new Error("AI_PROXY_KEY_MISSING");
  const connection = config.connections.find((item) => item.id === match[1]);
  if (!connection) throw new Error("AI_CONNECTION_NOT_FOUND");
  const parsed = new URL(target);
  if (connection.provider === "gemini") {
    if (parsed.hostname !== "generativelanguage.googleapis.com" || !parsed.pathname.startsWith("/v1beta/models/")) throw new Error("AI_TARGET_NOT_ALLOWED");
  } else if (connection.provider === "openai") {
    if (parsed.hostname !== "api.openai.com" || !parsed.pathname.startsWith("/v1/")) throw new Error("AI_TARGET_NOT_ALLOWED");
  } else if (connection.provider === "anthropic") {
    if (parsed.hostname !== "api.anthropic.com" || !parsed.pathname.startsWith("/v1/")) throw new Error("AI_TARGET_NOT_ALLOWED");
  } else {
    const endpoint = new URL(connection.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    if (parsed.origin !== endpoint.origin || !(parsed.pathname === basePath || parsed.pathname.startsWith(basePath + "/"))) throw new Error("AI_TARGET_NOT_ALLOWED");
  }
  return connection;
}
const server = createServer(async (req,res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const corsHeaders = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Player-Id, X-Reconnect-Token", "Vary": "Origin" };
  if ((pathname.startsWith("/scenario/") || pathname.startsWith("/turn/") || pathname.startsWith("/room/") || pathname.startsWith("/ai-config/") || pathname.startsWith("/ai-proxy/")) && req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (pathname === "/health") { res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify({ok:true,service:"vpi15-multiplayer"})); return; }
  // Read-only room presence for the compact in-game multiplayer HUD.
  const roomMatch = pathname.match(/^\/room\/([A-Z0-9]{6})$/);
  if (roomMatch && req.method === "GET") {
    try {
      const room = rooms.snapshot(roomMatch[1]);
      const players = room.players.map(({ id, name, countryId, connected }) => ({ id, name, countryId, connected }));
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ code: room.code, status: room.status, players }));
    } catch {
      res.writeHead(404, { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "ROOM_NOT_FOUND" }));
    }
    return;
  }

  const aiConfigMatch = pathname.match(/^\/ai-config\/([A-Z0-9]{6})$/);
  if (aiConfigMatch && (req.method === "GET" || req.method === "PUT")) {
    try {
      const code = aiConfigMatch[1], playerId = String(req.headers["x-player-id"] || ""), token = String(req.headers["x-reconnect-token"] || "");
      if (req.method === "GET") {
        if (!rooms.isPlayerToken(code, playerId, token)) throw new Error("PLAYER_AUTH_REQUIRED");
        const config = aiConfigs.get(code);
        if (!config) throw new Error("AI_CONFIG_NOT_SET");
        res.writeHead(200, { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(publicAiConfig(config)));
        return;
      }
      if (!rooms.isHostToken(code, playerId, token) && !rooms.isHostTurnToken(code, playerId, token)) throw new Error("HOST_ONLY");
      const config = validateAiConfig(await readJsonRequest(req, MAX_AI_CONFIG_BYTES));
      aiConfigs.set(code, config);
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, connections: config.connections.length, models: config.fallbackList.length }));
    } catch (error) {
      const status = error.message === "PLAYER_AUTH_REQUIRED" || error.message === "HOST_ONLY" ? 403 : error.message === "AI_CONFIG_NOT_SET" ? 404 : error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
      res.writeHead(status, { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error.message || "AI_CONFIG_FAILED" }));
    }
    return;
  }

  const aiProxyMatch = pathname.match(/^\\/ai-proxy\\/([A-Z0-9]{6})$/);
  if (aiProxyMatch && req.method === "POST") {
    try {
      const code = aiProxyMatch[1], playerId = String(req.headers["x-player-id"] || ""), token = String(req.headers["x-reconnect-token"] || "");
      if (!rooms.isPlayerToken(code, playerId, token)) throw new Error("PLAYER_AUTH_REQUIRED");
      const input = await readJsonRequest(req, MAX_AI_REQUEST_BYTES);
      const target = String(input?.url || "");
      const method = String(input?.method || "POST").toUpperCase();
      if (!["GET", "POST"].includes(method)) throw new Error("AI_METHOD_NOT_ALLOWED");
      const headers = input?.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? input.headers : {};
      const config = aiConfigs.get(code);
      if (!config) throw new Error("AI_CONFIG_NOT_SET");
      const connection = connectionForAiRequest(config, target, headers);
      const secret = connection.apiKey;
      const marker = `VPI15_PROXY_KEY:${connection.id}`;
      const safeHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        if (["host", "content-length", "connection", "origin", "referer"].includes(key.toLowerCase())) continue;
        safeHeaders[key] = String(value).replaceAll(marker, secret);
      }
      const targetUrl = new URL(target);
      if (targetUrl.searchParams.get("key") === marker) targetUrl.searchParams.set("key", secret);
      const upstream = await fetch(targetUrl, {
        method,
        headers: safeHeaders,
        ...(method === "GET" ? {} : { body: JSON.stringify(input.payload ?? {}) }),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        ...corsHeaders,
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (error) {
      const status = error.message === "PLAYER_AUTH_REQUIRED" ? 403 : error.message === "AI_CONFIG_NOT_SET" ? 503 : error.message === "REQUEST_TOO_LARGE" ? 413 : error.message === "AI_TARGET_NOT_ALLOWED" ? 403 : 400;
      res.writeHead(status, { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error.message || "AI_PROXY_FAILED" }));
    }
    return;
  }

  const turnMatch = pathname.match(/^\/turn\/([A-Z0-9]{6})$/);
  if (turnMatch && req.method === "GET") {
    try {
      const data = await readStoredFile(join(turnDir, `${turnMatch[1]}.json`));
      const room = rooms.snapshot(turnMatch[1]);
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-turn-hash": room.turnStateHash || "" });
      res.end(data);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, { ...corsHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.code === "ENOENT" ? "TURN_STATE_NOT_FOUND" : "TURN_STATE_READ_FAILED" }));
    }
    return;
  }
  if (turnMatch && req.method === "POST") {
    try {
      const code = turnMatch[1], playerId = String(req.headers["x-player-id"] || ""), token = String(req.headers["x-reconnect-token"] || "");
      if (!rooms.isHostTurnToken(code, playerId, token)) throw new Error("HOST_ONLY");
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_TURN_BYTES) throw new Error("TURN_STATE_TOO_LARGE"); chunks.push(chunk); }
      const raw = Buffer.concat(chunks), bundle = JSON.parse(raw.toString("utf8"));
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || !bundle.game || !bundle.world || !Array.isArray(bundle.events)) throw new Error("INVALID_TURN_STATE");
      const hash = createHash("sha256").update(raw).digest("hex");
      await mkdir(turnDir, { recursive: true });
      const target = join(turnDir, `${code}.json`), temp = target + ".tmp";
      await writeFile(temp, raw); await rename(temp, target);
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, hash, bytes: size }));
    } catch (error) {
      const status = error.message === "TURN_STATE_TOO_LARGE" ? 413 : error.message === "HOST_ONLY" ? 403 : 400;
      res.writeHead(status, { ...corsHeaders, "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message || "TURN_STATE_UPLOAD_FAILED" }));
    }
    return;
  }
  const scenarioMatch = pathname.match(/^\/scenario\/([A-Z0-9]{6})$/);
  if (scenarioMatch && req.method === "GET") {
    try { const data = await readStoredFile(join(scenarioDir, `${scenarioMatch[1]}.json`)); res.writeHead(200, { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(data); }
    catch (error) { res.writeHead(error.code === "ENOENT" ? 404 : 500, { ...corsHeaders, "content-type": "application/json" }); res.end(JSON.stringify({ error: error.code === "ENOENT" ? "SCENARIO_NOT_UPLOADED" : "SCENARIO_READ_FAILED" })); }
    return;
  }
  if (scenarioMatch && req.method === "POST") {
    try {
      const code = scenarioMatch[1], playerId = String(req.headers["x-player-id"] || ""), token = String(req.headers["x-reconnect-token"] || "");
      if (!rooms.isHostToken(code, playerId, token)) throw new Error("HOST_ONLY");
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_SCENARIO_BYTES) throw new Error("SCENARIO_TOO_LARGE"); chunks.push(chunk); }
      const raw = Buffer.concat(chunks), bundle = JSON.parse(raw.toString("utf8"));
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("INVALID_SCENARIO_BUNDLE");
      const hash = createHash("sha256").update(raw).digest("hex");
      await mkdir(scenarioDir, { recursive: true });
      const target = join(scenarioDir, `${code}.json`), temp = target + ".tmp";
      await writeFile(temp, raw); await rename(temp, target);
      const room = rooms.setScenarioBundle(code, playerId, hash);
      await persistRooms();
      broadcast(code, "room_updated", { room });
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, hash, bytes: size }));
    } catch (error) { const status = error.message === "SCENARIO_TOO_LARGE" ? 413 : error.message === "HOST_ONLY" ? 403 : 400; res.writeHead(status, { ...corsHeaders, "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message || "SCENARIO_UPLOAD_FAILED" })); }
    return;
  }
  if (pathname === "/catalog") {
    try { const catalog = await readFile(join(HERE,"catalog.json"),"utf8"); res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}); res.end(catalog); }
    catch { res.writeHead(500,{"content-type":"application/json"}); res.end(JSON.stringify({error:"CATALOG_UNAVAILABLE"})); }
    return;
  }
  if (pathname === "/" || pathname === "/lobby" || pathname === "/lobby/") {
    try { const html = await readFile(join(HERE,"lobby.html")); res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); res.end(html); }
    catch { res.writeHead(500); res.end("Lobby unavailable"); }
    return;
  }
  res.writeHead(404,{"content-type":"application/json"}); res.end(JSON.stringify({error:"NOT_FOUND"}));
});
const wss = new WebSocketServer({server,path:"/ws",maxPayload:3*1024*1024,verifyClient:({origin},done) => done(origins.length===0 || !origin || origins.includes(origin),403,"Origin not allowed")});
const send = (ws,type,payload={}) => { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type,...payload})); };
const broadcast = (code,type,payload={}) => { for(const [ws,s] of sessions) if(s.code===code) send(ws,type,payload); };
const attach = async (ws,result,ownerKey=null) => { let effectiveOwnerKey=ownerKey; for (const [peer,previous] of sessions) { if (peer!==ws && previous.code===result.room.code && previous.playerId===result.player.id) { effectiveOwnerKey ||= previous.ownerKey; sessions.delete(peer); try { peer.close(4001,"Reconnected from another client"); } catch {} } } sessions.set(ws,{code:result.room.code,playerId:result.player.id,token:result.player.reconnectToken,ownerKey:effectiveOwnerKey}); await persistRooms(); send(ws,"room",{room:result.room,player:result.player,reconnected:Boolean(result.reconnected)}); if(result.room.turnPhase==="host_turn") send(ws,"all_players_ready",{turnNumber:result.room.turnNumber,turnInputs:rooms.turnInputsFor(result.room.code)}); broadcast(result.room.code,"room_updated",{room:result.room}); };
wss.on("connection",ws => {
  ws.on("message",async raw => {
    try {
      const msg=JSON.parse(raw.toString());
      if(!msg || typeof msg.type!=="string") throw new Error("INVALID_MESSAGE");
      const session=sessions.get(ws);
      if(msg.type==="create_room") { if(session) throw new Error("ALREADY_IN_ROOM"); const ownerKey=String(msg.ownerKey||"").slice(0,100); if(ownerKey.length<20) throw new Error("HOST_KEY_REQUIRED"); const created=rooms.createRoom(msg.name); if(msg.aiConfig) aiConfigs.set(created.room.code,validateAiConfig(msg.aiConfig)); await attach(ws,created,ownerKey); return; }
      if(msg.type==="join_room") { if(session) throw new Error("ALREADY_IN_ROOM"); await attach(ws,rooms.joinRoom(msg.code,msg.name,msg.reconnectToken),String(msg.ownerKey||"").slice(0,100)||null); return; }
      if(!session) throw new Error("NOT_IN_ROOM");
      const {code,playerId}=session;
      if(msg.type==="ping") { send(ws,"pong",{at:Date.now()}); return; }
      if(msg.type==="scenario_ready") { const room=rooms.setScenarioReady(code,playerId,msg.hash); await persistRooms(); broadcast(code,"room_updated",{room}); return; }
      if(msg.type==="ready_for_turn") { const result=rooms.setReadyForTurn(code,playerId,msg.ready!==false,msg.inputs||null); await persistRooms(); broadcast(code,"room_updated",{room:result.room}); if(result.allReady) broadcast(code,"all_players_ready",{turnNumber:result.room.turnNumber,turnInputs:result.turnInputs}); return; }
      if(msg.type==="commit_turn") { const room=rooms.commitTurn(code,playerId,msg.state); await persistRooms(); broadcast(code,"turn_committed",{room,turnNumber:room.turnNumber}); broadcast(code,"room_updated",{room}); return; }
      if(msg.type==="diplomacy_history") {
        send(ws,"diplomacy_history",{threadId:String(msg.threadId||""),messages:rooms.diplomacyHistory(code,playerId,msg.threadId)});
        return;
      }
      if(msg.type==="diplomacy_message") {
        const result=rooms.sendDiplomaticMessage(code,playerId,msg);
        if(result.delivery==="ai") { send(ws,"diplomacy_delivery",{clientMessageId:msg.clientMessageId||null,delivery:"ai"}); return; }
        await persistRooms();
        for(const [peer,peerSession] of sessions) {
          if(peerSession.code===code && peerSession.playerId===result.recipientPlayerId) send(peer,"diplomacy_message",{message:result.message});
        }
        send(ws,"diplomacy_delivery",{clientMessageId:msg.clientMessageId||null,delivery:"human",message:result.message});
        return;
      }
      if(msg.type==="list_saves") { if(playerId!==rooms.snapshot(code).hostId || !session.ownerKey) throw new Error("HOST_ONLY"); send(ws,"saves",{saves:await saves.list(session.ownerKey)}); return; }
      if(msg.type==="save_game") { if(playerId!==rooms.snapshot(code).hostId || !session.ownerKey) throw new Error("HOST_ONLY"); const saved=await saves.save(session.ownerKey,msg.name,rooms.snapshot(code)); send(ws,"save_created",{save:saved,saves:await saves.list(session.ownerKey)}); return; }
      if(msg.type==="load_save") { if(playerId!==rooms.snapshot(code).hostId || !session.ownerKey) throw new Error("HOST_ONLY"); const saved=await saves.get(session.ownerKey,String(msg.saveId||"")); const restored=rooms.restoreRoom(code,playerId,saved); await persistRooms(); broadcast(code,"room_updated",{room:restored}); return; }
      let room;
      if(msg.type==="configure_lobby") room=rooms.configureLobby(code,playerId,msg.config);
      else if(msg.type==="assign_country") room=rooms.assignCountry(code,playerId,msg.playerId,msg.countryId);
      else if(msg.type==="start_game") room=rooms.startGame(code,playerId,msg.state ?? null);
      else if(msg.type==="update_state") room=rooms.updateState(code,playerId,msg.state);
      else throw new Error("UNKNOWN_MESSAGE");
      if (session.ownerKey && playerId === rooms.snapshot(code).hostId && ["configure_lobby","assign_country","start_game","update_state"].includes(msg.type)) {
        await saves.save(session.ownerKey,"Автосохранение",room);
      }
      await persistRooms();
      broadcast(code,"room_updated",{room});
    } catch(error) { send(ws,"error",{code:error.message||"INTERNAL_ERROR"}); }
  });
  ws.on("close",()=>{ const s=sessions.get(ws); if(!s)return; sessions.delete(ws); const room=rooms.disconnect(s.code,s.playerId); if(room){ void persistRooms(); broadcast(s.code,"room_updated",{room}); } });
});
const cleanup=setInterval(()=>{ if(rooms.removeExpiredPlayers()) void persistRooms(); },15000); cleanup.unref();
Promise.all([saves.ready, saves.loadRooms()]).then(([, savedRooms]) => {
  const restored = rooms.restore(savedRooms);
  console.log(`Restored ${restored} multiplayer room(s) from persistent storage`);
  server.listen(PORT,"0.0.0.0",()=>console.log(`VPI15 multiplayer listening on :${PORT}`));
}).catch((error) => {
  console.error("Multiplayer storage could not be loaded:", error);
  process.exit(1);
});
function shutdown(){clearInterval(cleanup);for(const ws of wss.clients)ws.close(1001,"Server shutting down");server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();}
process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);
