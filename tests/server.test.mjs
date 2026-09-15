import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "../vendor/ws/wrapper.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "authenticated dashboard refreshes, sends literal input and preserves archive across restart",
  { timeout: 20000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hpcw-test-"));
    const dataDir = path.join(dir, "data"),
      bin = path.join(dir, "bin");
    await fs.mkdir(bin);
    const calls = path.join(dir, "calls.jsonl"),
      jobsFile = path.join(dir, "jobs.txt");
    await fs.writeFile(jobsFile, "");
    const fixture = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({cmd,args})+'\\n');
if (cmd === 'tmux' && args[0] === 'list-panes') process.stdout.write('$1\\twork\\t0\\t0\\tbash\\t%1\\tbash\\t/tmp\\t0\\n');
if (cmd === 'squeue') process.stdout.write(fs.readFileSync(${JSON.stringify(jobsFile)}));
if (cmd === 'sinfo') process.stdout.write('gpu*|up|1-00:00:00|2|0/16/0/16|gpu:example:1\\n');
`;
    for (const cmd of ["tmux", "squeue", "sinfo", "scancel"])
      await fs.writeFile(path.join(bin, cmd), fixture, { mode: 0o755 });

    const thread = {
      id: "example-thread-12345",
      name: "Demo task",
      cwd: "/tmp",
      status: { type: "idle" },
    };
    const daemon = http.createServer(),
      ws = new WebSocketServer({ server: daemon });
    const methods = [];
    ws.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return;
        methods.push(msg.method);
        const replies = {
          initialize: {},
          "thread/list": { data: [thread], nextCursor: null },
          "thread/read": { thread },
          "thread/resume": { thread },
          "account/read": {
            account: { type: "chatgpt", email: "student@example.org" },
          },
          "model/list": { data: [] },
          "config/read": {
            config: {
              sandbox_mode: "workspace-write",
              approval_policy: "on-request",
            },
          },
        };
        socket.send(
          JSON.stringify({ id: msg.id, result: replies[msg.method] || {} }),
        );
      }),
    );
    const socketPath = path.join(dir, "codex.sock");
    daemon.listen(socketPath);
    await once(daemon, "listening");
    const probe = http.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const configPath = path.join(dir, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        port,
        dataDir,
        refreshMs: 60000,
        clusterLabel: "Demo university",
        codex: { socketPath },
      }),
    );
    let child,
      output = "",
      token;
    async function stop() {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
        await exited;
        clearTimeout(timer);
      }
    }
    t.after(async () => {
      await stop();
      for (const socket of ws.clients) socket.terminate();
      ws.close();
      await new Promise((resolve) => daemon.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    });
    async function request(route, body, headers = {}) {
      return fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Connection: "close",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function start() {
      child = spawn(process.execPath, ["server.mjs"], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HPC_WORKSPACE_CONFIG: configPath,
          HPC_WORKSPACE_DATA: dataDir,
          HPC_WORKSPACE_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      for (let n = 0; n < 100; n++) {
        assert.equal(child.exitCode, null, output);
        try {
          token = (
            await fs.readFile(path.join(dataDir, "access-token"), "utf8")
          ).trim();
          const state = await (await request("/api/refresh", {})).json();
          if (state.codexConnected && state.agents?.length) return state;
        } catch {
          /* Wait for the listener and daemon handshake. */
        }
        await delay(30);
      }
      assert.fail("Dashboard did not start: " + output);
    }

    const state = await start();
    assert.equal(state.clusterLabel, "Demo university");
    assert.deepEqual(state.limits, {});
    assert.equal(
      (await request("/api/state", undefined, { Authorization: "" })).status,
      401,
    );
    // fetch controls Host itself, so use the lower-level HTTP client here.
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/state`,
        { headers: { Host: "evil.example", Authorization: `Bearer ${token}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal(
      (await request("/api/refresh", {}, { Origin: "https://evil.example" }))
        .status,
      403,
    );
    const login = await request("/api/login", { token });
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal(
      (
        await request("/api/state", undefined, {
          Authorization: "",
          Cookie: cookie.split(";")[0],
        })
      ).status,
      200,
    );
    assert.equal(
      (await fs.stat(path.join(dataDir, "access-token"))).mode & 0o777,
      0o600,
    );

    await fs.writeFile(
      jobsFile,
      "123|training|gpu|RUNNING|0:10|1:00:00|1|4|8192M|gpu:1|compute01|None\n",
    );
    const fresh = await (await request("/api/refresh", {})).json();
    assert.equal(fresh.jobs[0].id, "123");
    const text = "echo '$HOME; $(example)'";
    assert.equal(
      (await request("/api/tmux/send", { pane: "%1", text })).status,
      200,
    );
    const records = (await fs.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      records.some(
        (call) =>
          call.cmd === "tmux" &&
          JSON.stringify(call.args) ===
            JSON.stringify(["send-keys", "-t", "%1", "-l", "--", text]),
      ),
    );
    assert.equal(
      (
        await request("/api/jobs/cancel", {
          id: "other-job",
          confirm: "other-job",
        })
      ).status,
      400,
    );

    assert.equal(
      (await request("/api/agents/archive", { id: thread.id })).status,
      200,
    );
    await stop();
    const restored = await start();
    assert.deepEqual(restored.archivedAgentIds, [thread.id]);
    assert.equal(
      (await request("/api/agents/restore", { id: thread.id })).status,
      200,
    );
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "archived-agents.json"), "utf8"),
      ),
      [],
    );
    assert.ok(
      !methods.some((method) =>
        ["turn/start", "turn/interrupt", "thread/archive"].includes(method),
      ),
    );
  },
);
