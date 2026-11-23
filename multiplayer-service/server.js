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
const sessions = new Map();
const server = createServer(async (req,res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const corsHeaders = { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Player-Id, X-Reconnect-Token", "Vary": "Origin" };
  if ((pathname.startsWith("/scenario/") || pathname.startsWith("/turn/")) && req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (pathname === "/health") { res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify({ok:true,service:"vpi15-multiplayer"})); return; }

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
      if (!rooms.isHostToken(code, playerId, token)) throw new Error("HOST_ONLY");
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
const attach = async (ws,result,ownerKey=null) => { sessions.set(ws,{code:result.room.code,playerId:result.player.id,ownerKey}); await persistRooms(); send(ws,"room",{room:result.room,player:result.player,reconnected:Boolean(result.reconnected)}); if(result.room.turnPhase==="host_turn") send(ws,"all_players_ready",{turnNumber:result.room.turnNumber,turnInputs:rooms.turnInputsFor(result.room.code)}); broadcast(result.room.code,"room_updated",{room:result.room}); };
wss.on("connection",ws => {
  ws.on("message",async raw => {
    try {
      const msg=JSON.parse(raw.toString());
      if(!msg || typeof msg.type!=="string") throw new Error("INVALID_MESSAGE");
      const session=sessions.get(ws);
      if(msg.type==="create_room") { if(session) throw new Error("ALREADY_IN_ROOM"); const ownerKey=String(msg.ownerKey||"").slice(0,100); if(ownerKey.length<20) throw new Error("HOST_KEY_REQUIRED"); await attach(ws,rooms.createRoom(msg.name),ownerKey); return; }
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
