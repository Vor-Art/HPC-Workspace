#!/usr/bin/env python3
"""Local dashboard launcher and foreground SSH tunnel. Python standard library only."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import webbrowser

UNIT = "hpc-workspace-tunnel.service"
DEFAULT_CONFIG = Path.home() / ".config/hpc-workspace/client.json"
STATE = Path.home() / ".local/share/hpc-workspace-client"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def valid_port(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1024 <= value <= 65535:
        raise ValueError("Ports must be integers in 1024..65535")
    return value


def validate(config):
    host = config.get("host", "")
    if not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]*", host):
        raise ValueError("Use a hostname or SSH config alias for host")
    valid_port(config.get("localPort"))
    valid_port(config.get("remotePort"))
    if not isinstance(config.get("expectedHostname"), str) or not config["expectedHostname"]:
        raise ValueError("expectedHostname is missing; rerun install.sh")
    return config


def atomic_json(filename, value):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=filename.name + ".", dir=filename.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, filename)
    finally:
        Path(temporary).unlink(missing_ok=True)


def ssh_options():
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ForwardX11=no", "-o", "RemoteCommand=none", "-o", "RequestTTY=no",
            "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]


def request(config, route="/health", token=None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    req = urllib.request.Request(f"http://127.0.0.1:{config['localPort']}{route}", headers=headers)
    with HTTP.open(req, timeout=2) as response:
        return json.load(response)


def tunnel(config):
    # Both remote bootstrap and forwarding use ONE SSH connection. This also
    # prevents a round-robin login hostname from splitting the two operations.
    with tempfile.TemporaryDirectory(prefix="hpcw-") as temporary:
        socket = str(Path(temporary) / "ssh")
        master_args = ssh_options() + ["-M", "-S", socket, "-o", "ControlPersist=no",
            "-o", "ExitOnForwardFailure=yes", "-N", "-L",
            f"127.0.0.1:{config['localPort']}:127.0.0.1:{config['remotePort']}", config["host"]]
        master = subprocess.Popen(master_args, stdout=subprocess.DEVNULL)
        try:
            mux = ssh_options() + ["-S", socket, "-o", "ControlMaster=no"]
            for _ in range(60):
                if master.poll() is not None:
                    raise RuntimeError(f"SSH exited ({master.returncode}); check network, keys and local port")
                if Path(socket).exists():
                    check = subprocess.run(mux + ["-O", "check", config["host"]],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
                    if check.returncode == 0:
                        break
                time.sleep(0.2)
            else:
                raise RuntimeError("SSH control connection did not become ready")
            node = subprocess.run(mux + [config["host"], "hostname"],
                stdout=subprocess.PIPE, text=True, check=True, timeout=10).stdout.strip()
            if node != config["expectedHostname"]:
                raise RuntimeError("SSH reached a different login node; configure a fixed-node SSH alias and reinstall")
            result = subprocess.run(mux + [config["host"], "~/.local/bin/hpc-workspace-server token"],
                stdout=subprocess.PIPE, text=True, check=True, timeout=65)
            try:
                remote = json.loads(result.stdout)
            except (ValueError, TypeError):
                raise RuntimeError("Invalid response from the remote dashboard helper") from None
            if remote.get("hostname") != config["expectedHostname"]:
                raise RuntimeError("SSH reached a different login node; configure a fixed-node SSH alias and reinstall")
            if remote.get("port") != config["remotePort"]:
                raise RuntimeError("Remote port changed; rerun install.sh to sync client configuration")
            token = remote.get("token", "")
            if not re.fullmatch(r"[a-f0-9]{64}", token):
                raise RuntimeError("Invalid dashboard access token")
            state = request(config, "/api/state", token)
            if state.get("host") != config["expectedHostname"]:
                raise RuntimeError("Forwarded dashboard does not match the configured node")
            atomic_json(STATE / "access.json", {"token": token, "host": config["host"], "port": config["localPort"]})
            print(f"Connected: http://127.0.0.1:{config['localPort']}", flush=True)
            code = master.wait()
            raise RuntimeError(f"SSH disconnected ({code})")
        finally:
            if master.poll() is None:
                master.terminate()
                try:
                    master.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    master.kill()
                    master.wait()


def open_panel(config, no_browser=False):
    subprocess.run(["systemctl", "--user", "start", UNIT], check=True)
    for _ in range(30):
        try:
            access = json.loads((STATE / "access.json").read_text())
            if access["host"] == config["host"] and access["port"] == config["localPort"]:
                request(config, "/api/state", access["token"])
                if not no_browser:
                    webbrowser.open(f"http://127.0.0.1:{config['localPort']}/#token={access['token']}")
                print(f"Dashboard: http://127.0.0.1:{config['localPort']}")
                return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.5)
    raise RuntimeError(f"Dashboard is not reachable yet. The service will retry; see journalctl --user -u {UNIT}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["open", "tunnel", "status", "stop", "restart"])
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("HPC_WORKSPACE_CLIENT_CONFIG", DEFAULT_CONFIG)))
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    config = validate(json.loads(args.config.read_text()))
    if args.command == "tunnel":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        tunnel(config)
    elif args.command == "open":
        open_panel(config, args.no_browser)
    else:
        subprocess.run(["systemctl", "--user", args.command, UNIT], check=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
