# Background task plugin

> [!WARNING] The code is prototype quality to validate the idea.

This repository contains the multi-file development sources for the Amp `background_task` plugin.

The Amp-loadable plugin is generated output:

```sh
bun run build
```

The build writes:

```text
.amp/plugins/background-task.js
```

Keep `.amp/plugins/background-task.js` treated as generated code. Edit files under `src/` and rebuild.

Useful commands:

```sh
bun test
bun run build
```

## How it works

The plugin connects as a tmux control model client and uses
separate tmux servers as the process manager.

It allows driving interactive processes like python3 REPLs,
vim, etc and notifying the agent about interesting output as a result.

Only running processes are retained as background tasks. When a process exits, the plugin delivers
any configured exit notification, optionally including its final snapshot, and then removes the tmux
task session.

See [./OVERVIEW.md] for all the details.
