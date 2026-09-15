# Installation and maintenance

## 1. Prepare SSH on your local Linux computer

The automatic client currently targets Linux with `systemctl --user`, Python 3.10+ and OpenSSH. Native Windows/macOS autostart installers are not included.

Create a dedicated SSH alias in `~/.ssh/config`, adapting [the example](../examples/ssh-config) to your own university account and fixed login node. The alias can include `Port`, `IdentityFile`, `ProxyJump` and `HostKeyAlias` as needed.

```bash
ssh my-hpc hostname
```

Verify a new host key using information from your cluster administrator. Automated connections use strict host-key checking. They require key-based authentication or an SSH agent available in your systemd user session. If permitted by your cluster, `ssh-copy-id my-hpc` installs your public key.

Confirm that these commands work noninteractively:

```bash
ssh -T -o RemoteCommand=none my-hpc 'node --version; tmux -V; command -v squeue sinfo'
```

Node.js must be at least 18.19; a currently maintained Node release is preferable where your cluster offers one. A Node installation available only after manually loading a module needs to be made available to noninteractive SSH commands first.

For Student Lab, use the fixed node provided by the administrator. A load-balanced login address can lead to different local tmux servers and Codex daemons. The client detects a different node and asks you to configure a fixed alias.

## 2. Install the application

Run on your **local computer**, from this checkout:

```bash
./install.sh --host my-hpc
~/.local/bin/hpc-workspace open
```

Options:

| Option                                 | Meaning                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| `--host my-hpc`                        | Your SSH alias or `user@host`; required                               |
| `--local-port 8767`                    | Browser-side port; defaults to 8765                                   |
| `--remote-port 32123`                  | Explicit remote port; otherwise one is selected and saved             |
| `--server-config examples/server.json` | Apply explicit JSON overrides                                         |
| `--no-autostart`                       | Install without enabling the user service; `open` starts it on demand |

If `~/.local/bin` is absent from your PATH, use the full command path or add it to your shell's PATH.

The installer checks prerequisites, uploads an application allowlist, writes configuration to private user directories, installs helpers and starts the remote dashboard. It does not request cluster resources or install operating-system packages.

## 3. Enable Codex agents

The terminal and Slurm views work independently of Codex. To use agents, install Codex under **your own remote account** and sign in with your own account. The official standalone installation command is:

```bash
# Run on the cluster, on a host where the CLI/control service is allowed.
curl -fsSL https://chatgpt.com/codex/install.sh | sh
~/.local/bin/codex login --device-auth
```

Use the link and short-lived code printed by Codex. If your workspace disables device-code authentication, use the normal browser flow. From your **local computer**, with local port 1455 available:

```bash
ssh -t -o RemoteCommand=none \
  -L 127.0.0.1:1455:127.0.0.1:1455 my-hpc \
  '~/.local/bin/codex login'
```

Open the URL printed by Codex in your local browser. If port 1455 is occupied, finish or stop the earlier login/port-forwarding session before starting this flow.

If a daemon was started before login and still reports no account, finish any active agent work, then run on the cluster:

```bash
~/.local/bin/codex app-server daemon restart
```

The dashboard reconnects. The implementation was exercised with Codex 0.154.0; the app-server API is evolving, so review upgrades against your installed CLI version. Official references: [CLI installation](https://learn.chatgpt.com/docs/cli), [authentication](https://learn.chatgpt.com/docs/auth), [app-server](https://learn.chatgpt.com/docs/app-server).

## Update

On your local computer:

```bash
git pull --ff-only
./install.sh --host my-hpc
```

Repeat your nondefault `--local-port` when updating. Existing remote configuration, port, access token, archived IDs and Codex account remain in their user directories. Explicit `--server-config` options override matching configuration keys. The dashboard process restarts to load the new server code; browser tabs may need a reload for new UI assets.

To restart only the remote dashboard:

```bash
ssh -T -o RemoteCommand=none my-hpc '~/.local/bin/hpc-workspace-server restart'
```

## Stop or remove

Stop automatic local connections:

```bash
systemctl --user disable --now hpc-workspace-tunnel
```

Stop the remote dashboard:

```bash
ssh -T -o RemoteCommand=none my-hpc '~/.local/bin/hpc-workspace-server stop'
```

Stopping the dashboard leaves your other tmux sessions, Slurm jobs and Codex daemon alone. If removing the application, inspect and remove only its files listed below. Keep any archive preferences you want to reuse. Codex configuration and credentials are separate.

| Machine | Files                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| Local   | `~/.local/bin/hpc-workspace`                                                           |
| Local   | `~/.config/systemd/user/hpc-workspace-tunnel.service`                                  |
| Local   | `~/.config/hpc-workspace/client.json`                                                  |
| Local   | `~/.local/share/hpc-workspace-client/access.json`                                      |
| Remote  | `~/.local/share/hpc-workspace/app/`                                                    |
| Remote  | `~/.local/share/hpc-workspace/access-token`, `archived-agents.json`, `server.log`      |
| Remote  | `~/.config/hpc-workspace/server.json`                                                  |
| Remote  | `~/.local/bin/hpc-workspace-server`, and `hpc-codex` only if installed by this project |

## Troubleshooting

- **Connection refused / timeout:** check VPN, `ssh my-hpc hostname`, then the local service journal. The service retries automatically; it does not establish VPN access.
- **Local address already in use:** choose another `--local-port`. Each local installation currently manages one cluster profile.
- **Different login node:** configure a fixed-node alias and rerun the installer.
- **Remote address already in use:** pick a free `--remote-port` and rerun the installer; the remote node is shared by many users.
- **Agents unavailable:** check `codex login status`, daemon status and the configured Codex binary/socket. Tmux/Slurm controls still work.
- **Unknown user quota:** leave `partitionLimits` empty until your own limits are confirmed; partition capacity is not a personal entitlement.
- **Persistent backend error:** inspect `~/.local/share/hpc-workspace/server.log` on the cluster.
