#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "../config.mjs";

process.umask(0o077);
const run = promisify(execFile),
  root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath =
  process.env.HPC_WORKSPACE_CONFIG ||
  path.join(os.homedir(), ".config/hpc-workspace/server.json");
const action = process.argv[2] || "status";
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function initialize() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const options = JSON.parse(text || "{}");
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const next = { ...previous, ...options.config };
  if (options.port) next.port = options.port;
  if (!next.port) next.port = await freePort();
  validateConfig(next);
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    configPath + ".tmp",
    JSON.stringify(next, null, 2) + "\n",
    { mode: 0o600 },
  );
  await fs.rename(configPath + ".tmp", configPath);
  // Keep the executable path found by SSH; noninteractive shells may not load nvm.
  const bin = path.join(os.homedir(), ".local/bin");
  await fs.mkdir(bin, { recursive: true });
  for (const [name, verb] of [
    ["hpc-workspace-server", ""],
    ["hpc-codex", "codex"],
  ]) {
    const script = `#!/bin/sh\n# HPC_WORKSPACE_MANAGED\nexec ${quote(process.execPath)} ${quote(path.join(root, "scripts/serverctl.mjs"))} ${verb} "$@"\n`;
    const filename = path.join(bin, name);
    try {
      const previous = await fs.readFile(filename, "utf8");
      if (!previous.includes("HPC_WORKSPACE_MANAGED")) {
        if (name === "hpc-codex") {
          console.error(
            "Keeping existing hpc-codex; use hpc-workspace-server codex for this installation.",
          );
          continue;
        }
        throw new Error("Refusing to replace an unrelated " + filename);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(filename, script, { mode: 0o755 });
    await fs.chmod(filename, 0o755);
  }
  console.log(
    JSON.stringify({ hostname: os.hostname(), port: next.port, configPath }),
  );
}

async function main() {
  if (action === "init") return initialize();
  const config = await loadConfig();
  const env = { ...process.env, CODEX_HOME: config.codex.home };
  const command = async (binary, args) =>
    run(binary, args, { env, timeout: 30000, maxBuffer: 1024 * 1024 });
  const sessionExists = async () => {
    try {
      await command("tmux", ["has-session", "-t", "=" + config.sessionName]);
      return true;
    } catch {
      return false;
    }
  };
  const health = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok && (await response.json()).app === "hpc-workspace";
    } catch {
      return false;
    }
  };
  const startCodex = async () => {
    if (!config.codex.enabled) return;
    try {
      await command(config.codex.binary, ["app-server", "daemon", "start"]);
    } catch (error) {
      console.error(
        "Codex daemon unavailable; tmux and Slurm remain available. " +
          (error.code || error.message),
      );
    }
  };
  const ensure = async () => {
    await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await startCodex();
    if (!(await sessionExists())) {
      // Check for a port owned by some other service before starting our process.
      const listener = net.createServer();
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(config.port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => listener.close(resolve));
      const shell = `exec ${quote(process.execPath)} ${quote(path.join(root, "server.mjs"))} >> ${quote(path.join(config.dataDir, "server.log"))} 2>&1`;
      await command("tmux", [
        "new-session",
        "-d",
        "-s",
        config.sessionName,
        "-c",
        root,
        "sh",
        "-c",
        shell,
      ]);
    }
    for (let n = 0; n < 40; n++) {
      if (await health()) return;
      await delay(250);
    }
    throw new Error(
      "Dashboard did not become ready; inspect " +
        path.join(config.dataDir, "server.log"),
    );
  };
  if (action === "stop") {
    if (await sessionExists())
      await command("tmux", ["kill-session", "-t", "=" + config.sessionName]);
    return;
  }
  if (action === "restart") {
    if (await sessionExists())
      await command("tmux", ["kill-session", "-t", "=" + config.sessionName]);
    // Wait for the old listener to exit before reusing its port.
    for (let n = 0; n < 20 && (await health()); n++) await delay(100);
    await ensure();
    console.log("Dashboard restarted");
    return;
  }
  if (action === "ensure") {
    await ensure();
    return;
  }
  if (action === "token") {
    await ensure();
    const token = (
      await fs.readFile(path.join(config.dataDir, "access-token"), "utf8")
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid dashboard token");
    console.log(
      JSON.stringify({ hostname: os.hostname(), port: config.port, token }),
    );
    return;
  }
  if (action === "status") {
    console.log(
      JSON.stringify({
        hostname: os.hostname(),
        port: config.port,
        running: await health(),
        session: config.sessionName,
      }),
    );
    return;
  }
  if (action === "codex") {
    await startCodex();
    const defaults = config.agentDefaults,
      args = ["--remote", `unix://${config.codex.socketPath}`];
    for (const [from, to] of Object.entries({
      approvalPolicy: "approval_policy",
      sandbox: "sandbox_mode",
      effort: "model_reasoning_effort",
      serviceTier: "service_tier",
    }))
      if (defaults[from] != null)
        args.push("-c", `${to}=${JSON.stringify(defaults[from])}`);
    const child = spawn(
      config.codex.binary,
      [...args, ...process.argv.slice(3)],
      { env, stdio: "inherit" },
    );
    child.on("error", (e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  throw new Error(
    "Usage: hpc-workspace-server ensure|restart|status|stop|token|codex [args]",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
