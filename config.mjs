import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(value, home = os.homedir()) {
  if (typeof value !== "string" || !value)
    throw new Error("Paths must be nonempty strings");
  return value === "~"
    ? home
    : value.startsWith("~/")
      ? path.join(home, value.slice(2))
      : value;
}

export function validateConfig(
  input = {},
  env = process.env,
  home = os.homedir(),
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Server config must be a JSON object");
  for (const key of ["agentDefaults", "codex", "partitionLimits"]) {
    if (
      input[key] !== undefined &&
      (!input[key] ||
        typeof input[key] !== "object" ||
        Array.isArray(input[key]))
    )
      throw new Error(`${key} must be an object`);
  }
  const config = {
    port: Number(env.HPC_WORKSPACE_PORT ?? input.port ?? 8765),
    dataDir: expandHome(
      env.HPC_WORKSPACE_DATA || input.dataDir || "~/.local/share/hpc-workspace",
      home,
    ),
    clusterLabel: input.clusterLabel || "HPC Workspace",
    refreshMs: input.refreshMs ?? 7000,
    sessionName: input.sessionName || "hpc-workspace",
    partitionLimits: input.partitionLimits || {},
    limitsNote:
      input.limitsNote ||
      "Пользовательские лимиты задаются в настройках панели; уточните их у администратора кластера.",
    agentDefaults: input.agentDefaults || {},
    codex: { enabled: true, ...input.codex },
  };
  const codexHome = expandHome(
    config.codex.home || env.CODEX_HOME || "~/.codex",
    home,
  );
  config.codex.home = codexHome;
  config.codex.socketPath = expandHome(
    config.codex.socketPath ||
      path.join(codexHome, "app-server-control/app-server-control.sock"),
    home,
  );
  config.codex.binary = expandHome(
    config.codex.binary ||
      (existsSync(path.join(home, ".local/bin/codex"))
        ? path.join(home, ".local/bin/codex")
        : "codex"),
    home,
  );
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw new Error("port must be 1024..65535");
  if (!Number.isInteger(config.refreshMs) || config.refreshMs < 1000)
    throw new Error("refreshMs must be at least 1000");
  if (
    typeof config.clusterLabel !== "string" ||
    typeof config.limitsNote !== "string"
  )
    throw new Error("Labels must be strings");
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(config.sessionName))
    throw new Error("Invalid tmux sessionName");
  for (const value of [config.dataDir, codexHome, config.codex.socketPath])
    if (!path.isAbsolute(value))
      throw new Error("Data and Codex paths must be absolute or start with ~/");
  for (const [key, choices] of Object.entries({
    approvalPolicy: ["never", "on-request"],
    sandbox: ["read-only", "workspace-write", "danger-full-access"],
    effort: [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    serviceTier: ["fast", "default"],
  })) {
    const value = config.agentDefaults[key];
    if (value != null && !choices.includes(value))
      throw new Error(`Invalid agentDefaults.${key}`);
  }
  if (typeof config.codex.enabled !== "boolean")
    throw new Error("codex.enabled must be boolean");
  if (
    typeof config.partitionLimits !== "object" ||
    Array.isArray(config.partitionLimits)
  )
    throw new Error("partitionLimits must be an object");
  for (const limit of Object.values(config.partitionLimits)) {
    if (!limit || typeof limit !== "object" || Array.isArray(limit))
      throw new Error("Each partition limit must be an object");
    for (const key of ["cpu", "memMiB", "gpu", "jobs", "hours"])
      if (
        limit[key] != null &&
        (typeof limit[key] !== "number" ||
          !Number.isFinite(limit[key]) ||
          limit[key] <= 0)
      )
        throw new Error(`Partition ${key} must be positive or null`);
  }
  return config;
}

export async function loadConfig(env = process.env, home = os.homedir()) {
  const filename = expandHome(
    env.HPC_WORKSPACE_CONFIG ||
      path.join(home, ".config/hpc-workspace/server.json"),
    home,
  );
  let input = {};
  try {
    input = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || env.HPC_WORKSPACE_CONFIG) throw error;
  }
  return validateConfig(input, env, home);
}

export function threadOptions(defaults) {
  const result = {
    config: { "features.default_mode_request_user_input": true },
  };
  for (const key of ["approvalPolicy", "sandbox", "serviceTier"])
    if (defaults[key] != null) result[key] = defaults[key];
  if (defaults.effort != null)
    result.config.model_reasoning_effort = defaults.effort;
  return result;
}

export function turnOptions(defaults) {
  return Object.fromEntries(
    ["effort", "serviceTier"]
      .filter((key) => defaults[key] != null)
      .map((key) => [key, defaults[key]]),
  );
}
