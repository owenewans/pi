# Subagents

The `subagent` tool runs up to four tasks in parallel with independent conversation contexts. Each task includes a role and a self-contained instruction; the child does not receive the parent transcript. Results return to the parent when every child finishes.

- `scout` and `reviewer` have read-only file tools.
- `worker` has read, bash, edit and write tools. Its writes receive language-server diagnostics when an appropriate server is available.

Children share the current working directory and filesystem. Assign workers non-overlapping changes; no worktrees are created automatically. Children use the current model and model registry, including the configured provider route. They do not load extension tools or start other subagents. Cancelling the call aborts its children; ending the session waits for their cleanup.
