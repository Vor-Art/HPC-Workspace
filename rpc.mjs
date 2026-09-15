import { EventEmitter } from "node:events";
import WebSocket from "./vendor/ws/wrapper.mjs";

// The daemon control socket carries WebSocket frames, unlike stdio app-server.
export class Codex extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.sequence = 0;
    this.pending = new Map();
    this.requests = new Map();
    this.connected = false;
    this.error = "Подключение к Codex…";
  }
  async connect() {
    const socket = this.socketPath;
    const ws = (this.ws = new WebSocket(`ws+unix://${socket}:/`, {
      headers: { Host: "localhost" },
      perMessageDeflate: false,
      handshakeTimeout: 10000,
      maxPayload: 32 * 1024 * 1024,
    }));
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.method) {
        if (msg.id !== undefined) this.requests.set(String(msg.id), msg);
        if (msg.method === "serverRequest/resolved")
          this.requests.delete(String(msg.params.requestId));
        if (msg.method === "turn/completed")
          for (const [id, r] of this.requests)
            if (r.params?.turnId === msg.params.turn.id)
              this.requests.delete(id);
        this.emit("notification", msg);
      } else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error
          ? p.reject(new Error(msg.error.message))
          : p.resolve(msg.result);
      }
    });
    ws.on("error", (e) => {
      this.error = e.message;
    });
    ws.on("close", () => {
      this.connected = false;
      this.error = this.error || "Codex отключён";
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Соединение с Codex потеряно"));
      }
      this.pending.clear();
      this.requests.clear();
      this.emit("disconnect");
      if (!this.stopping)
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
    ws.on("open", async () => {
      try {
        this.info = await this.call("initialize", {
          clientInfo: {
            name: "hpc_panel",
            title: "HPC workspace",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true },
        });
        this.send({ method: "initialized", params: {} });
        this.connected = true;
        this.error = null;
        this.emit("ready");
      } catch (e) {
        this.error = e.message;
        ws.close();
      }
    });
  }
  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN)
      throw new Error("Codex недоступен");
    this.ws.send(JSON.stringify(msg));
  }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Тайм-аут Codex: ${method}`));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  answer(id, result) {
    const r = this.requests.get(String(id));
    if (!r) throw new Error("Этот вопрос уже закрыт");
    this.send({ id: r.id, result });
    this.requests.delete(String(id));
  }
  stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
