# Contributing

Use Node.js 18.19+ and Python 3.10+. The server has no build step; `ws` is already vendored.

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

These checks use temporary directories and fake cluster commands. They do not connect to SSH, allocate resources or call a model.

For a local UI preview without Codex, save this as an ignored `preview.local.json`:

```json
{
  "port": 8769,
  "codex": { "enabled": false },
  "clusterLabel": "Local development"
}
```

```bash
HPC_WORKSPACE_CONFIG="$PWD/preview.local.json" node server.mjs
```

Open `http://127.0.0.1:8769/#token=YOUR_TOKEN`, replacing `YOUR_TOKEN` with the contents of `~/.local/share/hpc-workspace/access-token`. The page clears the fragment after login. A computer without Slurm shows its command errors in the resource view. Use a separate `dataDir` when an existing installation uses that directory.

Keep personal configuration, credentials, runtime files and real conversation screenshots out of commits. Keep examples fictional and explain changed configuration fields in `docs/configuration.md`. Preserve upstream licenses when updating vendored code.
