# Configuration

## Server: on the cluster

`~/.config/hpc-workspace/server.json` is created by the installer. Example:

```json
{
  "port": 32123,
  "clusterLabel": "My university HPC",
  "refreshMs": 7000,
  "agentDefaults": {},
  "partitionLimits": {},
  "limitsNote": "User quotas have not been configured."
}
```

Other optional fields:

| Field              | Default / meaning                                             |
| ------------------ | ------------------------------------------------------------- |
| `dataDir`          | `~/.local/share/hpc-workspace`; private runtime data          |
| `sessionName`      | `hpc-workspace`; service tmux session                         |
| `codex.enabled`    | `true`; set false for a terminal/Slurm-only dashboard         |
| `codex.binary`     | `~/.local/bin/codex` when present, otherwise `codex` on PATH  |
| `codex.home`       | Existing `CODEX_HOME`, otherwise `~/.codex`                   |
| `codex.socketPath` | `app-server-control/app-server-control.sock` under Codex home |

Restart the dashboard after edits with `hpc-workspace-server restart`. If changing its port, rerun the local installer to synchronize the tunnel. Server-only environment overrides for development are `HPC_WORKSPACE_CONFIG`, `HPC_WORKSPACE_DATA` and `HPC_WORKSPACE_PORT`.

### Optional agent defaults

Empty `agentDefaults` inherits Codex's own configuration. This example explicitly selects the original profile:

```json
{
  "agentDefaults": {
    "approvalPolicy": "never",
    "sandbox": "danger-full-access",
    "effort": "xhigh",
    "serviceTier": "fast"
  }
}
```

You can override any subset. Supported sandbox names are `read-only`, `workspace-write` and `danger-full-access`; approval policies are `on-request` and `never`. Reasoning effort is checked against the selected model's advertised capabilities. The fast tier depends on account/model availability.

The same defaults are used for browser launches and the project's `hpc-codex` helper. Structured user questions are enabled for dashboard-created/resumed threads. For an independently launched Codex daemon, the dashboard cannot infer its runtime status from a saved conversation file.

### Optional quota display

Only add values confirmed for **your account**. This is a format example, not an actual cluster allocation:

```json
{
  "partitionLimits": {
    "example-gpu": {
      "cpu": 8,
      "memMiB": 32768,
      "gpu": 1,
      "jobs": 2,
      "hours": 4
    }
  },
  "limitsNote": "Example only: replace with limits confirmed for your account."
}
```

Fields are optional. Missing limits appear as unspecified, not unlimited. This display does not change Slurm configuration. Running-job resource summaries use `squeue` fields; shared/exclusive allocations and memory-per-CPU configurations can require checking `scontrol show job` for exact accounting.

## Client: on the local computer

The installer writes `~/.config/hpc-workspace/client.json`:

```json
{
  "host": "my-hpc",
  "localPort": 8765,
  "remotePort": 32123,
  "expectedHostname": "login01"
}
```

Host keys and SSH identities stay in the normal SSH configuration. The tunnel and remote bootstrap share one SSH connection. The access token is fetched over that connection and stored locally with owner-only permissions in `~/.local/share/hpc-workspace-client/access.json`.

The systemd user unit runs `hpc-workspace tunnel` and retries exits after 15 seconds. The browser launcher waits for an authenticated response before opening the page. Its fragment token is converted to a HttpOnly, SameSite=Strict cookie and removed from the address bar.

Archive visibility is shared by all browsers using the same remote instance and saved in `archived-agents.json`. It changes dashboard visibility, preserving the agent's conversation and running work.
