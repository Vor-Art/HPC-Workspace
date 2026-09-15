#!/usr/bin/env python3
"""Install this checkout for the current local and remote user, without sudo."""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile

from client import atomic_json, ssh_options, valid_port, validate, UNIT, DEFAULT_CONFIG

ROOT = Path(__file__).resolve().parent.parent
SERVER_FILES = ["server.mjs", "rpc.mjs", "config.mjs", "package.json", "public", "vendor", "scripts/serverctl.mjs"]


def archive():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as output:
        for name in SERVER_FILES:
            output.add(ROOT / name, arcname=name)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="SSH config alias or user@hostname")
    parser.add_argument("--local-port", type=int, default=8765)
    parser.add_argument("--remote-port", type=int, help="By default choose a free remote port on first install")
    parser.add_argument("--server-config", type=Path, help="JSON overrides, e.g. examples/server.yolo.json")
    parser.add_argument("--no-autostart", action="store_true")
    args = parser.parse_args()
    validate({"host": args.host, "localPort": args.local_port, "remotePort": args.remote_port or 8765, "expectedHostname": "probe"})
    for tool in ["ssh", "systemctl"]:
        if not shutil.which(tool):
            raise RuntimeError(f"Required local tool not found: {tool}")
    subprocess.run(["systemctl", "--user", "show-environment"], check=True, stdout=subprocess.DEVNULL)
    overrides = json.loads(args.server_config.read_text()) if args.server_config else {}
    if not isinstance(overrides, dict):
        raise ValueError("--server-config must contain a JSON object")
    # Allow an update using the already configured local port; reject unrelated listeners.
    own_running = subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT]).returncode == 0
    if not own_running:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", args.local_port))
    ssh = ssh_options() + ["-o", "ClearAllForwardings=yes", args.host]
    print("Checking remote Node.js, tmux and SSH access…", flush=True)
    remote_check = "set -e; command -v tmux >/dev/null; command -v tar >/dev/null; node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);if(a<18||(a===18&&b<19))process.exit(1)'"
    subprocess.run(ssh + [remote_check], check=True, timeout=20)
    print("Installing dashboard files…", flush=True)
    # This command contains no user-controlled shell interpolation. Only the
    # explicit application allowlist is uploaded, never home-directory state.
    upload = "set -e; umask 077; mkdir -p ~/.local/share/hpc-workspace/app; tar -xzf - -C ~/.local/share/hpc-workspace/app"
    subprocess.run(ssh + [upload], input=archive(), check=True, timeout=90)
    init = "node ~/.local/share/hpc-workspace/app/scripts/serverctl.mjs init"
    result = subprocess.run(ssh + [init], input=json.dumps({"config": overrides, "port": args.remote_port}).encode(),
        stdout=subprocess.PIPE, check=True, timeout=20)
    info = json.loads(result.stdout)
    config = validate({"host": args.host, "localPort": args.local_port,
        "remotePort": valid_port(info["port"]), "expectedHostname": info["hostname"]})
    subprocess.run(ssh + ["~/.local/bin/hpc-workspace-server restart"], check=True, timeout=65)
    atomic_json(DEFAULT_CONFIG, config)
    executable = Path.home() / ".local/bin/hpc-workspace"
    executable.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "scripts/client.py", executable)
    executable.chmod(0o755)
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    unit = """[Unit]
Description=HPC Workspace SSH tunnel
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=%h/.local/bin/hpc-workspace tunnel
Restart=always
RestartSec=15
TimeoutStopSec=6
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
"""
    (units / UNIT).write_text(unit)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    if not args.no_autostart:
        subprocess.run(["systemctl", "--user", "enable", UNIT], check=True)
        subprocess.run(["systemctl", "--user", "restart", UNIT], check=True)
    elif own_running:
        subprocess.run(["systemctl", "--user", "restart", UNIT], check=True)
    print(f"Installed on {info['hostname']}; remote port {info['port']}, local port {args.local_port}.")
    print(f"Open: {executable} open")
    print("Codex agents use your own remote Codex installation and login. See docs/installation.md.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
