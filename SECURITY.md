# Security and deployment scope

This is a personal control dashboard. An authenticated browser can send terminal commands, control Codex agents and cancel the owner's Slurm jobs. The token grants access equivalent to those operations under the remote Unix account.

- The server binds to `127.0.0.1`; connect through the included SSH tunnel.
- API access requires a private token or HttpOnly, SameSite=Strict cookie. Host and Origin checks protect browser requests.
- The installer creates private configuration/runtime files and validates the forwarded node. SSH host keys are checked strictly.
- Other users on a shared login node can reach loopback ports, so authentication remains necessary even with SSH forwarding.
- Do not expose the HTTP port publicly, disable SSH host-key checking, or share token-bearing URLs/logs. Runtime files belong outside this checkout.
- Codex inherits the owner's configuration unless explicitly overridden. The optional YOLO profile enables full command/filesystem access without approvals.

The dashboard is not a multi-tenant web service and does not provide per-action roles or an audit system. Each student installs their own instance under their own Unix account. Cluster administrators determine where persistent control services and Codex may run.

For a vulnerability involving credentials or command execution, contact the repository owner privately before posting reproduction details publicly. Do not include live tokens, SSH keys or Codex auth files in issues.
