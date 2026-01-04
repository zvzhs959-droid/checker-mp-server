// Cloudflare Workers + Durable Objects WebSocket room server (max 4 players)
export default {
  fetch(request, env) {
    const url = new URL(request.url);

    // Health check (use this to confirm the worker is reachable)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { "content-type": "application/json" },
      });
    }

    // WebSocket endpoint: /ws?room=ROOMCODE
    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room") || "lobby";
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // slot -> WebSocket
    this.sockets = new Map();
    // slot -> name
    this.names = ["", "", "", ""];
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const slot = this._allocSlot();
    if (slot === -1) {
      server.send(JSON.stringify({ t: "err", code: "ROOM_FULL", msg: "Room full (max 4)." }));
      server.close(1008, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const meta = { slot };
    this.state.acceptWebSocket(server, meta);

    this.sockets.set(slot, server);

    // Welcome + presence
    server.send(JSON.stringify({ t: "welcome", slot, players: this._playersList() }));
    this._broadcastExcept(slot, { t: "join", slot, name: this.names[slot] });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const meta = this.state.getWebSocketMetadata(ws);
    if (!meta || typeof meta.slot !== "number") return;
    const slot = meta.slot;

    let data;
    try { data = JSON.parse(message); }
    catch {
      ws.send(JSON.stringify({ t: "err", code: "BAD_JSON", msg: "Invalid JSON" }));
      return;
    }

    // Join / set name
    if (data.t === "join") {
      const name = typeof data.name === "string" ? data.name.slice(0, 24) : "";
      this.names[slot] = name;
      this._broadcastAll({ t: "join", slot, name });
      ws.send(JSON.stringify({ t: "presence", players: this._playersList() }));
      return;
    }

    // Ping/pong
    if (data.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", c: data.c }));
      return;
    }

    // Relay player inputs
    if (data.t === "in") {
      const payload = { t: "in", slot, i: data.i ?? null };
      if (typeof data.s === "number") payload.s = data.s;
      this._broadcastExcept(slot, payload);
      return;
    }

    // Relay host snapshots
    if (data.t === "snap") {
      const payload = { t: "snap", st: data.st ?? null };
      if (typeof data.s === "number") payload.s = data.s;
      this._broadcastExcept(slot, payload);
      return;
    }
  }

  webSocketClose(ws) {
    const meta = this.state.getWebSocketMetadata(ws);
    if (!meta || typeof meta.slot !== "number") return;
    const slot = meta.slot;

    this.sockets.delete(slot);
    this.names[slot] = "";
    this._broadcastAll({ t: "leave", slot });
    this._broadcastAll({ t: "presence", players: this._playersList() });
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  _allocSlot() {
    for (let i = 0; i < 4; i++) if (!this.sockets.has(i)) return i;
    return -1;
  }

  _playersList() {
    const out = [];
    for (let i = 0; i < 4; i++) {
      if (this.sockets.has(i)) out.push({ slot: i, name: this.names[i] || "" });
    }
    return out;
  }

  _broadcastAll(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.sockets.values()) {
      try { ws.send(msg); } catch {}
    }
  }

  _broadcastExcept(exceptSlot, obj) {
    const msg = JSON.stringify(obj);
    for (const [slot, ws] of this.sockets.entries()) {
      if (slot === exceptSlot) continue;
      try { ws.send(msg); } catch {}
    }
  }
}

export { Room };
