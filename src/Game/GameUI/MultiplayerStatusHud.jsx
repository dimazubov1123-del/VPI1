/*! Multiplayer status pill: quiet, read-only presence in the campaign HUD. */
import React, { useEffect, useState } from "react";

const EMPTY_STATUS = { ping: null, online: false, connectedPlayers: 0, totalPlayers: 0 };

export const MultiplayerStatusHud = ({ gameId }) => {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState(EMPTY_STATUS);

  useEffect(() => {
    if (!gameId || typeof window === "undefined") { setSession(null); return; }
    try {
      const raw = localStorage.getItem("vpi15-mp-session:" + gameId);
      setSession(raw ? JSON.parse(raw) : null);
    } catch { setSession(null); }
  }, [gameId]);

  useEffect(() => {
    if (!session?.room || !session?.server) { setStatus(EMPTY_STATUS); return undefined; }
    const endpoint = String(session.server).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").split("/ws")[0];
    let stopped = false;
    let inFlight = false;
    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      const started = performance.now();
      try {
        const response = await fetch(endpoint + "/room/" + encodeURIComponent(session.room), { cache: "no-store" });
        if (!response.ok) throw new Error("Room status unavailable");
        const room = await response.json();
        if (stopped) return;
        const players = Array.isArray(room.players) ? room.players : [];
        setStatus({
          ping: Math.max(0, Math.round(performance.now() - started)),
          online: true,
          connectedPlayers: players.filter((player) => player.connected).length,
          totalPlayers: players.length,
        });
      } catch {
        if (!stopped) setStatus((previous) => ({ ...previous, ping: null, online: false }));
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [session]);

  if (!session?.room) return null;
  const pingColor = !status.online ? "rgba(235,235,240,.52)" : status.ping < 120 ? "#83d6a1" : status.ping < 250 ? "#e4c47c" : "#e99a91";
  const pingLabel = status.ping === null ? "— мс" : status.ping + " мс";
  return (
    <div role="status" aria-live="off"
      title={status.online ? "Задержка до сервера: " + pingLabel + ". Подключено игроков: " + status.connectedPlayers + " из " + status.totalPlayers + "." : "Нет связи с сервером мультиплеера"}
      style={{
        position: "fixed", top: "calc(4.15rem + env(safe-area-inset-top, 0px))",
        right: "max(0.75rem, env(safe-area-inset-right, 0px))", zIndex: 9996,
        display: "flex", alignItems: "center", gap: "0.65rem",
        padding: "0.34rem 0.62rem", border: "1px solid rgba(236,236,238,.12)",
        borderRadius: "999px", background: "rgba(18,18,20,.46)",
        color: "rgba(248,248,249,.78)", boxShadow: "0 2px 10px rgba(0,0,0,.12)",
        backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
        font: "500 0.72rem/1.2 Segoe UI, sans-serif", letterSpacing: ".01em",
        pointerEvents: "none", userSelect: "none", whiteSpace: "nowrap",
      }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
        <span aria-hidden="true" style={{ width: "0.38rem", height: "0.38rem", borderRadius: "50%", background: pingColor, boxShadow: status.online ? "0 0 6px " + pingColor : "none" }} />
        {pingLabel}
      </span>
      <span aria-hidden="true" style={{ width: "1px", height: "0.8rem", background: "rgba(255,255,255,.15)" }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.28rem" }}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5.1 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM10.9 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM1.8 13.2c.2-2 1.3-3 3.3-3s3.1 1 3.3 3M7.6 13.2c.2-2 1.3-3 3.3-3s3.1 1 3.3 3" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round"/>
        </svg>
        {status.connectedPlayers}/{status.totalPlayers}
      </span>
    </div>
  );
};
