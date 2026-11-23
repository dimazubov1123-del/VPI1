import test from "node:test";
import assert from "node:assert/strict";
import { RoomManager } from "./roomManager.js";
function setup(){let now=1000,code=0,token=0;return {manager:new RoomManager({now:()=>now,codeFactory:()=>`ROOM${String(++code).padStart(2,"0")}`,tokenFactory:()=>`token-${++token}`,disconnectGraceMs:100}),advance:ms=>{now+=ms;}};}
function configuredRoom(manager){const host=manager.createRoom("Хозяин");const guest=manager.joinRoom(host.room.code,"Гость");manager.configureLobby(host.room.code,host.player.id,{scenarioId:"cold-war",scenarioName:"Холодная война",gameMode:"standard"});const players=manager.snapshot(host.room.code).players;manager.assignCountry(host.room.code,host.player.id,players[0].id,"USSR");manager.assignCountry(host.room.code,host.player.id,players[1].id,"USA");return {host,guest};}
function readyRoom(manager){const {host,guest}=configuredRoom(manager);const hash="a".repeat(64);manager.setScenarioBundle(host.room.code,host.player.id,hash);manager.setScenarioReady(host.room.code,host.player.id,hash);manager.setScenarioReady(host.room.code,guest.player.id,hash);return {host,guest,hash};}
test("creates a room and joins a second player",()=>{const {manager}=setup();const a=manager.createRoom("Хозяин");const b=manager.joinRoom(a.room.code,"Гость");assert.equal(b.room.players.length,2);assert.equal(b.room.hostId,a.player.id);});
test("invalidates the previous scenario bundle when the host changes scenarios",()=>{const {manager}=setup();const {host,guest}=configuredRoom(manager);const hash="a".repeat(64);manager.setScenarioBundle(host.room.code,host.player.id,hash);manager.setScenarioReady(host.room.code,host.player.id,hash);manager.setScenarioReady(host.room.code,guest.player.id,hash);manager.configureLobby(host.room.code,host.player.id,{scenarioId:"modern-day",scenarioName:"Современный мир"});const room=manager.snapshot(host.room.code);assert.equal(room.scenarioHash,null);assert.deepEqual(room.scenarioReady,[]);assert.throws(()=>manager.startGame(host.room.code,host.player.id),/SCENARIO_BUNDLE_REQUIRED/);});
test("keeps the host's shared AI endpoint when scenario or mode settings are updated",()=>{
 const {manager}=setup();const host=manager.createRoom("Хозяин");
 manager.configureLobby(host.room.code,host.player.id,{scenarioId:"s",scenarioName:"Сценарий",settings:{ai:{endpoint:"https://ai.example/v1",model:"model-x"}}});
 manager.configureLobby(host.room.code,host.player.id,{scenarioId:"s",scenarioName:"Сценарий",gameMode:"sandbox"});
 assert.deepEqual(manager.snapshot(host.room.code).config.settings,{ai:{endpoint:"https://ai.example/v1",model:"model-x"}});
});

test("host configures scenario and assigns unique countries",()=>{const {manager}=setup();const {host,guest}=configuredRoom(manager);const room=manager.snapshot(host.room.code);assert.equal(room.config.scenarioId,"cold-war");assert.equal(room.players.find(p=>p.id===guest.player.id).countryId,"USA");assert.throws(()=>manager.assignCountry(host.room.code,host.player.id,guest.player.id,"USSR"),/COUNTRY_ALREADY_ASSIGNED/);});
test("only host can configure, assign, start and update shared state",()=>{const {manager}=setup();const {host,guest}=readyRoom(manager);assert.throws(()=>manager.configureLobby(host.room.code,guest.player.id,{}),/HOST_ONLY/);assert.throws(()=>manager.startGame(host.room.code,guest.player.id),/HOST_ONLY/);assert.equal(manager.startGame(host.room.code,host.player.id,{turn:1}).status,"playing");assert.deepEqual(manager.updateState(host.room.code,host.player.id,{turn:2}).state,{turn:2});assert.throws(()=>manager.updateState(host.room.code,guest.player.id,{}),/HOST_ONLY/);});
test("prevents starting without scenario or all country assignments",()=>{const {manager}=setup();const a=manager.createRoom("Хозяин");const b=manager.joinRoom(a.room.code,"Гость");assert.throws(()=>manager.startGame(a.room.code,a.player.id),/SCENARIO_REQUIRED/);manager.configureLobby(a.room.code,a.player.id,{scenarioId:"s",scenarioName:"Сценарий"});const hash="b".repeat(64);manager.setScenarioBundle(a.room.code,a.player.id,hash);manager.setScenarioReady(a.room.code,a.player.id,hash);manager.setScenarioReady(a.room.code,b.player.id,hash);assert.throws(()=>manager.startGame(a.room.code,a.player.id),/COUNTRIES_NOT_ASSIGNED/);});
test("reconnects with token",()=>{const {manager}=setup();const a=manager.createRoom("Игрок");manager.disconnect(a.room.code,a.player.id);const b=manager.joinRoom(a.room.code,"Снова",a.player.reconnectToken);assert.equal(b.reconnected,true);assert.equal(b.player.id,a.player.id);});
test("expires disconnected host and transfers host",()=>{const {manager,advance}=setup();const a=manager.createRoom("Хозяин");const b=manager.joinRoom(a.room.code,"Гость");manager.disconnect(a.room.code,a.player.id);advance(101);manager.removeExpiredPlayers();assert.equal(manager.snapshot(a.room.code).hostId,b.player.id);});
test("rejects oversized game state",()=>{const {manager}=setup();const {host}=readyRoom(manager);manager.startGame(host.room.code,host.player.id);assert.throws(()=>manager.updateState(host.room.code,host.player.id,"x".repeat(300000)),/STATE_TOO_LARGE/);});

test("restores a saved room while preserving assignments for players who rejoin",()=>{const {manager}=setup();const a=manager.createRoom("Хозяин");manager.configureLobby(a.room.code,a.player.id,{scenarioId:"default",scenarioName:"Modern Day"});manager.assignCountry(a.room.code,a.player.id,a.player.id,"USA");const saved={config:{scenarioId:"default",scenarioName:"Modern Day",gameMode:"standard",settings:{}},state:{turn:4},status:"playing",players:[{name:"Хозяин",countryId:"USA"},{name:"Гость",countryId:"RUS"}],savedAssignments:{Хозяин:"USA",Гость:"RUS"}};const restored=manager.restoreRoom(a.room.code,a.player.id,saved);assert.equal(restored.status,"lobby");assert.deepEqual(restored.state,{turn:4});const guest=manager.joinRoom(a.room.code,"Гость");assert.equal(guest.room.players.find(p=>p.id===guest.player.id).countryId,"RUS");const hash="9".repeat(64);manager.setScenarioBundle(a.room.code,a.player.id,hash);manager.setScenarioReady(a.room.code,a.player.id,hash);manager.setScenarioReady(a.room.code,guest.player.id,hash);assert.equal(manager.startGame(a.room.code,a.player.id).state.turn,4);});

test("routes diplomacy only to the player who owns the destination country",()=>{
 const {manager}=setup();const {host,guest}=readyRoom(manager);manager.startGame(host.room.code,host.player.id);
 const delivered=manager.sendDiplomaticMessage(host.room.code,host.player.id,{fromCountry:"USSR",toCountry:"USA",threadId:"thread-1",text:"Предлагаю договор"});
 assert.equal(delivered.delivery,"human");assert.equal(delivered.recipientPlayerId,guest.player.id);assert.equal(delivered.message.text,"Предлагаю договор");
 assert.deepEqual(manager.diplomacyHistory(host.room.code,guest.player.id,"thread-1"),[delivered.message]);
 assert.deepEqual(manager.diplomacyHistory(host.room.code,host.player.id,"thread-1"),[delivered.message]);
 assert.deepEqual(manager.diplomacyHistory(host.room.code,guest.player.id,"other-thread"),[]);
});
test("keeps AI-owned diplomacy on the AI path and rejects country impersonation",()=>{
 const {manager}=setup();const {host}=readyRoom(manager);manager.startGame(host.room.code,host.player.id);
 assert.equal(manager.sendDiplomaticMessage(host.room.code,host.player.id,{fromCountry:"USSR",toCountry:"FRA",threadId:"t",text:"Bonjour"}).delivery,"ai");
 assert.throws(()=>manager.sendDiplomaticMessage(host.room.code,host.player.id,{fromCountry:"USA",toCountry:"FRA",threadId:"t",text:"spoof"}),/SENDER_COUNTRY_MISMATCH/);
});

test("authorizes only the host to upload a turn snapshot after the game starts",()=>{const {manager}=setup();const {host,guest}=readyRoom(manager);manager.startGame(host.room.code,host.player.id,{round:1});assert.equal(manager.isHostTurnToken(host.room.code,host.player.id,host.player.reconnectToken),true);assert.equal(manager.isHostTurnToken(host.room.code,guest.player.id,guest.player.reconnectToken),false);assert.equal(manager.isHostToken(host.room.code,host.player.id,host.player.reconnectToken),false);});
test("requires every player to download and verify the uploaded scenario before starting",()=>{
 const {manager}=setup();const {host,guest}=configuredRoom(manager);const hash="a".repeat(64);
 assert.equal(manager.isHostToken(host.room.code,host.player.id,host.player.reconnectToken),true);
 assert.equal(manager.isHostToken(host.room.code,guest.player.id,guest.player.reconnectToken),false);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 assert.throws(()=>manager.startGame(host.room.code,host.player.id),/SCENARIO_DOWNLOADS_PENDING/);
 assert.throws(()=>manager.setScenarioReady(host.room.code,guest.player.id,"wrong-hash"),/SCENARIO_HASH_MISMATCH/);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 assert.throws(()=>manager.startGame(host.room.code,host.player.id),/SCENARIO_DOWNLOADS_PENDING/);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 assert.equal(manager.startGame(host.room.code,host.player.id).status,"playing");
});


test("persists and restores room credentials, scenario, country assignments and current game state", () => {
 const {manager}=setup(); const {host,guest}=readyRoom(manager); const hash="b".repeat(64);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 manager.startGame(host.room.code,host.player.id,{round:4,gameDate:"2000-01-01"});
 const dumped=manager.dump();
 const restored=new RoomManager({now:()=>2000,codeFactory:()=>"ROOMX1",tokenFactory:()=>"unused"});
 assert.equal(restored.restore(dumped),1);
 const room=restored.snapshot(host.room.code);
 assert.equal(room.status,"playing");
 assert.equal(room.state.round,4);
 assert.equal(room.players.find(p=>p.id===guest.player.id).countryId,"USA");
 assert.equal(restored.joinRoom(host.room.code,"Хозяин",host.player.reconnectToken).reconnected,true);
});
test("holds the next turn until every player is ready and only host commits it", () => {
 const {manager}=setup(); const {host,guest}=readyRoom(manager); const hash="c".repeat(64);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 manager.startGame(host.room.code,host.player.id,{round:1});
 assert.equal(manager.setReadyForTurn(host.room.code,host.player.id,true).allReady,false);
 assert.throws(()=>manager.commitTurn(host.room.code,host.player.id,{round:2}),/PLAYERS_NOT_READY/);
 assert.equal(manager.setReadyForTurn(host.room.code,guest.player.id,true).allReady,true);
 assert.throws(()=>manager.commitTurn(host.room.code,guest.player.id,{round:2}),/HOST_ONLY/);
 const committed=manager.commitTurn(host.room.code,host.player.id,{round:2});
 assert.equal(committed.turnNumber,2);
 assert.equal(committed.turnPhase,"waiting");
 assert.ok(committed.players.every(player=>!player.readyForTurn));
});


test("keeps restored rooms available for a week after a server restart", () => {
 const {manager,advance}=setup(); const {host}=readyRoom(manager);
 const restored=new RoomManager({now:()=>1000,codeFactory:()=>"ROOMX1",tokenFactory:()=>"unused",disconnectGraceMs:100});
 restored.restore(manager.dump());
 advance(24*60*60*1000);
 assert.equal(restored.removeExpiredPlayers(),false);
 assert.equal(restored.snapshot(host.room.code).players.length,2);
});


test("commits a ready turn with a content hash for clients to download", () => {
 const {manager}=setup(); const {host,guest}=readyRoom(manager); const hash="d".repeat(64);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 manager.startGame(host.room.code,host.player.id,{round:1});
 manager.setReadyForTurn(host.room.code,host.player.id,true);
 manager.setReadyForTurn(host.room.code,guest.player.id,true);
 const committed=manager.commitTurn(host.room.code,host.player.id,{round:2,gameDate:"2000-02-01",stateHash:hash});
 assert.equal(committed.turnStateHash,hash);
 assert.equal(committed.turnNumber,2);
});


test("collects each country's queued actions when all players are ready", () => {
 const {manager}=setup(); const {host,guest}=readyRoom(manager); const hash="e".repeat(64);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 manager.startGame(host.room.code,host.player.id,{round:1});
 manager.setReadyForTurn(host.room.code,host.player.id,true,{actions:[{id:"host-order"}]});
 const result=manager.setReadyForTurn(host.room.code,guest.player.id,true,{actions:[{id:"guest-order"}]});
 assert.equal(result.allReady,true);
 assert.deepEqual(result.turnInputs.map(entry=>entry.inputs.actions[0].id),["host-order","guest-order"]);
});


test("allows a player to cancel the ready barrier before the host commits the turn", () => {
 const {manager}=setup(); const {host,guest}=readyRoom(manager); const hash="f".repeat(64);
 manager.setScenarioBundle(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,host.player.id,hash);
 manager.setScenarioReady(host.room.code,guest.player.id,hash);
 manager.startGame(host.room.code,host.player.id,{round:1});
 manager.setReadyForTurn(host.room.code,host.player.id,true,{actions:[{id:"a"}]});
 manager.setReadyForTurn(host.room.code,guest.player.id,true,{actions:[{id:"b"}]});
 const reopened=manager.setReadyForTurn(guest.room.code || host.room.code,guest.player.id,false);
 assert.equal(reopened.allReady,false);
 assert.equal(reopened.room.turnPhase,"waiting");
 assert.ok(reopened.room.players.every(player=>!player.readyForTurn));
});
