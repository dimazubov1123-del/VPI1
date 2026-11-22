import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RoomManager } from "./roomManager.js";
const PORT = Number(process.env.PORT || 3001);
const HERE = dirname(fileURLToPath(import.meta.url));
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const rooms = new RoomManager();
const sessions = new Map();
const server = createServer(async (req,res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/health") { res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify({ok:true,service:"vpi15-multiplayer"})); return; }
  if (pathname === "/" || pathname === "/lobby" || pathname === "/lobby/") {
    try { const html = await readFile(join(HERE,"lobby.html")); res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); res.end(html); }
    catch { res.writeHead(500); res.end("Lobby unavailable"); }
    return;
  }
  res.writeHead(404,{"content-type":"application/json"}); res.end(JSON.stringify({error:"NOT_FOUND"}));
});
const wss = new WebSocketServer({server,path:"/ws",maxPayload:300*1024,verifyClient:({origin},done) => done(origins.length===0 || !origin || origins.includes(origin),403,"Origin not allowed")});
const send = (ws,type,payload={}) => { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type,...payload})); };
const broadcast = (code,type,payload={}) => { for(const [ws,s] of sessions) if(s.code===code) send(ws,type,payload); };
const attach = (ws,result) => { sessions.set(ws,{code:result.room.code,playerId:result.player.id}); send(ws,"room",{room:result.room,player:result.player,reconnected:Boolean(result.reconnected)}); broadcast(result.room.code,"room_updated",{room:result.room}); };
wss.on("connection",ws => {
  ws.on("message",raw => {
    try {
      const msg=JSON.parse(raw.toString());
      if(!msg || typeof msg.type!=="string") throw new Error("INVALID_MESSAGE");
      const session=sessions.get(ws);
      if(msg.type==="create_room") { if(session) throw new Error("ALREADY_IN_ROOM"); attach(ws,rooms.createRoom(msg.name)); return; }
      if(msg.type==="join_room") { if(session) throw new Error("ALREADY_IN_ROOM"); attach(ws,rooms.joinRoom(msg.code,msg.name,msg.reconnectToken)); return; }
      if(!session) throw new Error("NOT_IN_ROOM");
      const {code,playerId}=session;
      if(msg.type==="ping") { send(ws,"pong",{at:Date.now()}); return; }
      let room;
      if(msg.type==="configure_lobby") room=rooms.configureLobby(code,playerId,msg.config);
      else if(msg.type==="assign_country") room=rooms.assignCountry(code,playerId,msg.playerId,msg.countryId);
      else if(msg.type==="start_game") room=rooms.startGame(code,playerId,msg.state ?? null);
      else if(msg.type==="update_state") room=rooms.updateState(code,playerId,msg.state);
      else throw new Error("UNKNOWN_MESSAGE");
      broadcast(code,"room_updated",{room});
    } catch(error) { send(ws,"error",{code:error.message||"INTERNAL_ERROR"}); }
  });
  ws.on("close",()=>{ const s=sessions.get(ws); if(!s)return; sessions.delete(ws); const room=rooms.disconnect(s.code,s.playerId); if(room)broadcast(s.code,"room_updated",{room}); });
});
const cleanup=setInterval(()=>rooms.removeExpiredPlayers(),15000); cleanup.unref();
server.listen(PORT,"0.0.0.0",()=>console.log(`VPI15 multiplayer listening on :${PORT}`));
function shutdown(){clearInterval(cleanup);for(const ws of wss.clients)ws.close(1001,"Server shutting down");server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();}
process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);
