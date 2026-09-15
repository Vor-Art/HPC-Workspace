# Working on this HPC account

Use Slurm to allocate compute resources before training, running Python jobs,
or starting development workloads. Check the site's documentation for what is
allowed on login nodes. The dashboard is a lightweight control interface.

The user can have several tmux sessions and Slurm jobs at once. Account-wide
CPU, RAM, GPU and job-count limits still apply. Reuse a suitable allocation
when it is practical. Home directories may be shared across nodes; /tmp is
usually node-local.

Use the user's preferred Python environment and project conventions. Prefer
short, practical explanations and relevant checks over redundant tests.
When a decision is needed, request_user_input lets the dashboard display a
question and accept the user's answer.

The hpc-codex command connects a terminal to the same Codex daemon as the panel.
Dashboard settings are in ~/.config/hpc-workspace/server.json. Ask the user
which resource limits apply rather than assuming another student's quotas.
