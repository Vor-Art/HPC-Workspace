import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Codex } from "./rpc.mjs";
import { loadConfig, threadOptions, turnOptions } from "./config.mjs";

process.umask(0o077);
const run = promisify(execFile),
  root = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig();
const home = os.homedir(),
  port = config.port,
  dataDir = config.dataDir;
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
let token;
try {
  token = (
    await fs.readFile(path.join(dataDir, "access-token"), "utf8")
  ).trim();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(path.join(dataDir, "access-token"), token + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
const codex = new Codex(config.codex.socketPath);
const clients = new Set(),
  subscribed = new Set();
let snapshot = {
  tmux: [],
  jobs: [],
  partitions: [],
  agents: [],
  errors: {},
  updated: null,
};
let account = null,
  models = [],
  effectiveConfig = null,
  refreshPromise = null;
const archivePath = path.join(dataDir, "archived-agents.json");
let archivedAgentIds = new Set(),
  archiveWrite = Promise.resolve();
try {
  const ids = JSON.parse(await fs.readFile(archivePath, "utf8"));
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    throw new Error("Некорректный файл архива панели");
  archivedAgentIds = new Set(ids);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
function setArchived(id, archived) {
  const pending = archiveWrite.then(async () => {
    const ids = new Set(archivedAgentIds);
    archived ? ids.add(id) : ids.delete(id);
    await fs.writeFile(archivePath + ".tmp", JSON.stringify([...ids]) + "\n", {
      mode: 0o600,
    });
    await fs.rename(archivePath + ".tmp", archivePath);
    archivedAgentIds = ids;
    broadcast({ method: "panel/state", params: state() });
  });
  archiveWrite = pending.catch(() => {});
  return pending;
}
const limits = config.partitionLimits;
const command = async (file, args = []) =>
  (
    await run(file, args, {
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", CODEX_HOME: config.codex.home },
    })
  ).stdout;
function broadcast(message) {
  const s = `data: ${JSON.stringify(message)}\n\n`;
  for (const c of clients) c.write(s);
}
codex.on("notification", (msg) => {
  broadcast(msg);
  if (msg.method === "account/updated") refreshCodex().catch(() => {});
});
codex.on("disconnect", () => {
  subscribed.clear();
  broadcast({ method: "panel/disconnected" });
});
codex.on("ready", () => {
  subscribed.clear();
  refresh().catch(() => {});
});

async function tmuxList() {
  let out;
  try {
    out = await command("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{session_name}\t#{session_attached}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}",
    ]);
  } catch (e) {
    if (/no server running|no sessions/.test(e.stderr || "")) return [];
    throw e;
  }
  const sessions = new Map();
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [id, name, attached, window, windowName, pane, cmd, cwd, dead] =
      line.split("\t");
    if (!sessions.has(id))
      sessions.set(id, { id, name, attached: Number(attached), panes: [] });
    sessions
      .get(id)
      .panes.push({
        id: pane,
        window,
        windowName,
        command: cmd,
        cwd,
        dead: dead === "1",
      });
  }
  return [...sessions.values()];
}
function gpuCount(value) {
  const matches = [
    ...value.matchAll(/(?:gres\/gpu(?::[^=,]+)?=|gpu(?::[^:,()]+)?:)(\d+)/g),
  ];
  return matches.length ? Number(matches[0][1]) : 0;
}
async function jobsList() {
  const out = await command("squeue", [
    "-h",
    "-u",
    os.userInfo().username,
    "-o",
    "%i|%j|%P|%T|%M|%l|%D|%C|%m|%b|%N|%R",
  ]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        id,
        name,
        partition,
        state,
        elapsed,
        timeLimit,
        nodes,
        cpus,
        memory,
        gres,
        nodeList,
        reason,
      ] = line.split("|");
      return {
        id,
        name,
        partition,
        state,
        elapsed,
        timeLimit,
        nodes: Number(nodes),
        cpus: Number(cpus),
        memory,
        gres,
        gpus: gpuCount(gres),
        nodeList,
        reason,
        allocated: state === "RUNNING" || state === "COMPLETING",
      };
    });
}
async function partitionList() {
  const out = await command("sinfo", ["-h", "-o", "%P|%a|%l|%D|%C|%G"]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [p, available, timeLimit, nodes, cpus, gpus] = line.split("|");
      return {
        name: p.replace("*", ""),
        available,
        timeLimit,
        nodes: Number(nodes),
        cpus,
        gpus,
      };
    });
}
async function refreshCodex() {
  if (!config.codex.enabled) return;
  if (!codex.connected) throw new Error(codex.error || "Codex недоступен");
  const r = await codex.call("thread/list", {
    limit: 100,
    sortKey: "updated_at",
    useStateDbOnly: true,
    sourceKinds: [
      "cli",
      "vscode",
      "exec",
      "appServer",
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
      "unknown",
    ],
  });
  const listed = new Set(r.data.map((t) => t.id));
  const olderArchived = await Promise.allSettled(
    [...archivedAgentIds]
      .filter((id) => !listed.has(id))
      .map((id) =>
        codex.call("thread/read", { threadId: id, includeTurns: false }),
      ),
  );
  for (const entry of olderArchived)
    if (entry.status === "fulfilled") r.data.push(entry.value.thread);
  const archiveFailure = olderArchived.find(
    (entry) => entry.status === "rejected",
  );
  if (archiveFailure) snapshot.errors.archive = archiveFailure.reason.message;
  else delete snapshot.errors.archive;
  snapshot.agents = r.data;
  snapshot.moreAgents = !!r.nextCursor;
  for (const t of r.data)
    if (t.status?.type !== "notLoaded" && !subscribed.has(t.id)) {
      await codex.call("thread/resume", { threadId: t.id, excludeTurns: true });
      subscribed.add(t.id);
    }
  const info = await codex.call("account/read", {});
  account = info.account;
  if (!models.length && account)
    models = (await codex.call("model/list", {})).data;
  if (!effectiveConfig) {
    const r = await codex.call("config/read", {}),
      c = r.config;
    effectiveConfig = {
      approval: c.approval_policy,
      sandbox: c.sandbox_mode,
      effort: c.model_reasoning_effort,
      tier: c.service_tier,
      model: c.model,
    };
    const defaults = config.agentDefaults;
    for (const [from, to] of Object.entries({
      approvalPolicy: "approval",
      sandbox: "sandbox",
      effort: "effort",
      serviceTier: "tier",
    }))
      if (defaults[from] != null) effectiveConfig[to] = defaults[from];
  }
}
function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await Promise.allSettled(
      [
        ["tmux", async () => (snapshot.tmux = await tmuxList())],
        [
          "slurm",
          async () => {
            const [jobs, partitions] = await Promise.all([
              jobsList(),
              partitionList(),
            ]);
            snapshot.jobs = jobs;
            snapshot.partitions = partitions;
          },
        ],
        ["codex", refreshCodex],
      ].map(async ([key, fn]) => {
        try {
          await fn();
          delete snapshot.errors[key];
        } catch (e) {
          snapshot.errors[key] = e.message;
        }
      }),
    );
    snapshot.updated = Date.now();
    broadcast({ method: "panel/state", params: state() });
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
function state() {
  return {
    ...snapshot,
    archivedAgentIds: [...archivedAgentIds],
    clusterLabel: config.clusterLabel,
    refreshMs: config.refreshMs,
    limitsNote: config.limitsNote,
    codexEnabled: config.codex.enabled,
    serviceSessionName: config.sessionName,
    host: os.hostname(),
    user: os.userInfo().username,
    home,
    limits,
    account: account
      ? { type: account.type, email: account.email, planType: account.planType }
      : null,
    models: models.map((m) => ({
      id: m.id,
      model: m.model,
      displayName: m.displayName,
      isDefault: m.isDefault,
      supportedReasoningEfforts: m.supportedReasoningEfforts,
    })),
    config: effectiveConfig,
    codexConnected: codex.connected,
    requests: [...codex.requests.values()],
  };
}
function validString(v, max = 20000) {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0"))
    throw new Error("Некорректный текст");
  return v;
}
async function validCwd(cwd) {
  const p = validString(cwd || home, 4096);
  if (!path.isAbsolute(p) || !(await fs.stat(p)).isDirectory())
    throw new Error("Укажи существующий абсолютный путь к каталогу на сервере");
  return p;
}
async function validPane(id) {
  if (
    !/^%\d+$/.test(id) ||
    !(await tmuxList()).some((s) => s.panes.some((p) => p.id === id))
  )
    throw new Error("Панель tmux уже закрыта");
  return id;
}
function validThread(id) {
  if (!/^[a-zA-Z0-9_-]{10,100}$/.test(id || ""))
    throw new Error("Некорректный ID агента");
  return id;
}
const settings = threadOptions(config.agentDefaults),
  turnSettings = turnOptions(config.agentDefaults);
async function threadDetails(id) {
  const { thread } = await codex.call("thread/read", {
    threadId: id,
    includeTurns: false,
  });
  const history = await codex.call("thread/turns/list", {
    threadId: id,
    limit: 20,
    sortDirection: "desc",
    itemsView: "full",
  });
  thread.turns = [...(history.data || [])].reverse();
  return { thread, moreHistory: !!history.nextCursor };
}
async function action(route, b) {
  if (route === "/api/refresh") {
    await refresh();
    return state();
  }
  if (route === "/api/agents/archive" || route === "/api/agents/restore") {
    const id = validThread(b.id);
    if (route === "/api/agents/archive")
      await codex.call("thread/read", { threadId: id, includeTurns: false });
    await setArchived(id, route === "/api/agents/archive");
    return state();
  }
  if (route === "/api/tmux/new") {
    const name = validString(b.name, 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(name))
      throw new Error("Имя: латинские буквы, цифры, _ или -");
    await command("tmux", [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      await validCwd(b.cwd),
    ]);
    await refresh();
    return { ok: true };
  }
  if (route === "/api/tmux/send") {
    const pane = await validPane(b.pane);
    await command("tmux", [
      "send-keys",
      "-t",
      pane,
      "-l",
      "--",
      validString(b.text),
    ]);
    await command("tmux", ["send-keys", "-t", pane, "Enter"]);
    return { ok: true };
  }
  if (route === "/api/tmux/key") {
    const pane = await validPane(b.pane);
    if (!["C-c", "Escape", "Enter", "Up", "Down", "Tab"].includes(b.key))
      throw new Error("Неизвестная клавиша");
    await command("tmux", ["send-keys", "-t", pane, b.key]);
    return { ok: true };
  }
  if (route === "/api/tmux/kill") {
    const session = (await tmuxList()).find((s) => s.id === b.id);
    if (!session) throw new Error("Сессия не найдена");
    if (session.name === config.sessionName)
      throw new Error("Это служебная сессия панели");
    if (b.confirm !== session.name) throw new Error("Подтверди имя сессии");
    await command("tmux", ["kill-session", "-t", session.id]);
    await refresh();
    return { ok: true };
  }
  if (route === "/api/jobs/cancel") {
    const job = (await jobsList()).find((j) => j.id === b.id);
    if (!job || b.confirm !== job.id)
      throw new Error("Подтверди ID своего задания");
    await command("scancel", [job.id]);
    await refresh();
    return { ok: true };
  }
  if (route === "/api/agents/new") {
    const cwd = await validCwd(b.cwd),
      prompt = validString(b.text);
    const model = models.find((m) => m.model === b.model || m.id === b.model);
    if (b.model && !model) throw new Error("Модель недоступна");
    if (
      model &&
      config.agentDefaults.effort &&
      !model.supportedReasoningEfforts?.some(
        (e) => e.reasoningEffort === config.agentDefaults.effort,
      )
    )
      throw new Error(
        "Модель не поддерживает выбранный уровень reasoning effort",
      );
    const r = await codex.call("thread/start", {
      ...settings,
      cwd,
      historyMode: "legacy",
      ...(b.model ? { model: b.model } : {}),
    });
    subscribed.add(r.thread.id);
    if (b.name)
      await codex.call("thread/name/set", {
        threadId: r.thread.id,
        name: validString(b.name, 120),
      });
    try {
      await codex.call("turn/start", {
        threadId: r.thread.id,
        input: [{ type: "text", text: prompt }],
        ...turnSettings,
      });
    } catch (e) {
      await refresh();
      throw new Error(
        `Агент ${r.thread.id} создан, но запуск не удался: ${e.message}`,
      );
    }
    await refresh();
    return { id: r.thread.id };
  }
  if (route === "/api/agents/send") {
    const id = validThread(b.id);
    await codex.call("thread/resume", {
      ...settings,
      threadId: id,
      excludeTurns: true,
    });
    subscribed.add(id);
    const r = await codex.call("turn/start", {
      threadId: id,
      input: [{ type: "text", text: validString(b.text) }],
      ...turnSettings,
    });
    return r;
  }
  if (route === "/api/agents/interrupt") {
    const id = validThread(b.id),
      { thread } = await threadDetails(id),
      turn = thread.turns.findLast((t) => t.status === "inProgress");
    if (!turn) throw new Error("У агента нет выполняющейся задачи");
    return await codex.call("turn/interrupt", {
      threadId: id,
      turnId: turn.id,
    });
  }
  if (route === "/api/agents/answer") {
    const request = codex.requests.get(String(b.requestId));
    if (!request) throw new Error("Вопрос уже закрыт");
    if (request.method === "item/tool/requestUserInput") {
      const answers = {};
      for (const q of request.params.questions)
        answers[q.id] = { answers: [validString(b.answers?.[q.id])] };
      codex.answer(b.requestId, { answers });
    } else if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(request.method)
    ) {
      if (!["accept", "decline", "cancel"].includes(b.decision))
        throw new Error("Неизвестное решение");
      codex.answer(b.requestId, { decision: b.decision });
    } else throw new Error("Ответ на этот тип запроса доступен в Codex CLI");
    return { ok: true };
  }
  if (route === "/api/agents/terminal") {
    const id = validThread(b.id);
    const { thread } = await codex.call("thread/read", { threadId: id });
    const name = `agent-${id.slice(-8)}`;
    if (!(await tmuxList()).some((s) => s.name === name))
      await command("tmux", [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        thread.cwd || home,
        "-x",
        "160",
        "-y",
        "45",
        config.codex.binary,
        "--remote",
        `unix://${config.codex.socketPath}`,
        "resume",
        id,
      ]);
    await refresh();
    return { name };
  }
  throw new Error("Неизвестное действие");
}
function matches(secret) {
  const a = Buffer.from(secret || ""),
    b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authorized(req) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`hpc_session_${port}=`))
    ?.slice(`hpc_session_${port}=`.length);
  return (
    matches(cookie) ||
    matches(req.headers.authorization?.replace(/^Bearer /, ""))
  );
}
function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100000) throw new Error("Слишком большой запрос");
  }
  return JSON.parse(text || "{}");
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    if (!/^((127\.0\.0\.1|localhost)(:\d+)?)$/.test(req.headers.host || ""))
      return json(res, 403, { error: "Недопустимый Host" });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return json(res, 403, { error: "Недопустимый Origin" });
    const url = new URL(req.url, `http://${req.headers.host}`),
      route = url.pathname;
    if (route === "/health" && req.method === "GET")
      return json(res, 200, { app: "hpc-workspace", version: "1.0.0" });
    if (route === "/api/login" && req.method === "POST") {
      const b = await body(req);
      if (!matches(b.token))
        return json(res, 401, { error: "Неверный ключ панели" });
      res.setHeader(
        "Set-Cookie",
        `hpc_session_${port}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return json(res, 200, { ok: true });
    }
    if (route.startsWith("/api/")) {
      if (!authorized(req))
        return json(res, 401, {
          error:
            "Открой панель командой hpc-workspace open на своём компьютере",
        });
      if (route === "/api/state" && req.method === "GET")
        return json(res, 200, state());
      if (route === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (route === "/api/tmux/capture" && req.method === "GET") {
        const pane = await validPane(url.searchParams.get("pane"));
        return json(res, 200, {
          text: await command("tmux", [
            "capture-pane",
            "-p",
            "-t",
            pane,
            "-S",
            "-250",
          ]),
        });
      }
      if (route === "/api/agents/read" && req.method === "GET")
        return json(
          res,
          200,
          await threadDetails(validThread(url.searchParams.get("id"))),
        );
      if (req.method === "POST")
        return json(res, 200, await action(route, await body(req)));
      return json(res, 404, { error: "Не найдено" });
    }
    const files = {
      "/": "index.html",
      "/app.js": "app.js",
      "/style.css": "style.css",
    };
    if (!files[route] || req.method !== "GET")
      return json(res, 404, { error: "Не найдено" });
    const type = route.endsWith(".js")
      ? "text/javascript"
      : route.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, {
      "Content-Type": type + "; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(await fs.readFile(path.join(root, "public", files[route])));
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`HPC panel listening on 127.0.0.1:${port}`),
);
server.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
if (config.codex.enabled) codex.connect().catch(() => {});
await refresh();
const poll = setInterval(() => refresh().catch(() => {}), config.refreshMs),
  heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15000);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    clearInterval(poll);
    clearInterval(heartbeat);
    codex.stop();
    for (const c of clients) c.end();
    server.close(() => process.exit(0));
  });
