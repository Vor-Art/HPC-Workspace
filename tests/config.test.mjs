import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, threadOptions, turnOptions } from "../config.mjs";

test("a new student inherits Codex settings and gets no assumed quotas", () => {
  const config = validateConfig({}, {}, "/home/example-student");
  assert.equal(
    config.dataDir,
    "/home/example-student/.local/share/hpc-workspace",
  );
  assert.equal(config.codex.home, "/home/example-student/.codex");
  assert.deepEqual(config.partitionLimits, {});
  assert.deepEqual(config.agentDefaults, {});
  assert.equal(threadOptions(config.agentDefaults).approvalPolicy, undefined);
  assert.deepEqual(turnOptions(config.agentDefaults), {});
});

test("explicit profile overrides and environment paths are portable", () => {
  const defaults = {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    effort: "xhigh",
    serviceTier: "fast",
  };
  const config = validateConfig(
    { agentDefaults: defaults },
    { CODEX_HOME: "~/custom-codex", HPC_WORKSPACE_PORT: "32123" },
    "/home/student",
  );
  assert.equal(
    config.codex.socketPath,
    "/home/student/custom-codex/app-server-control/app-server-control.sock",
  );
  assert.equal(config.port, 32123);
  assert.equal(threadOptions(defaults).sandbox, "danger-full-access");
  assert.deepEqual(turnOptions(defaults), {
    effort: "xhigh",
    serviceTier: "fast",
  });
});

test("invalid configuration fails before starting a service", () => {
  for (const config of [
    { port: 0 },
    { port: 65536 },
    { refreshMs: 50 },
    { dataDir: "relative/path" },
    { sessionName: "bad:name" },
    { agentDefaults: [] },
    { codex: null },
    { agentDefaults: { sandbox: "unknown" } },
    { partitionLimits: { gpu: { cpu: -1 } } },
  ])
    assert.throws(() => validateConfig(config, {}));
});
