# Subagents

The `subagent` tool starts background tasks and returns their IDs immediately. The parent can continue independent work while children run. Each completed or failed child delivers its own result automatically and normally wakes the parent. Do not poll while waiting.

```json
{"tasks":[{"role":"scout","task":"Find the session lifecycle hooks and report relevant paths."}]}
```

Each task needs a self-contained instruction. Children have independent conversation contexts and do not receive the parent transcript.

- `scout` and `reviewer` have read-only file tools.
- `worker` has read, bash, edit and write tools. Its writes receive language-server diagnostics when an appropriate server is available.

Children share the working directory and filesystem. Assign workers non-overlapping changes; no worktrees are created automatically. Children use the current model and model registry, including the configured provider route. They do not load extension tools or delegate further.

## Manage jobs

| Arguments | Effect |
|---|---|
| `tasks`, optionally `action: "start"` | Start tasks and return IDs |
| `action: "list"` | Show job IDs and states |
| `action: "result", id` | Read a job's current state and completed output |
| `action: "stop", id` | Abort one job and wait for cleanup |
| `action: "clear"` | Remove finished jobs |

At most four children run per session, across all calls. The last 32 jobs remain available in memory; older finished jobs are removed when necessary. Each output is limited to 50,000 characters.

Children survive parent turns and interrupts. Explicitly stopping a child suppresses its completion notification. Changing branches or ending the session aborts all children and waits for cleanup; results cannot leak into another branch.

Results received during parent work enter the transcript without interrupting its response, then trigger continuation at the next normal settlement. An explicit parent interrupt cancels that continuation, not the children or their stored results. Results received during manual compaction remain available for the next prompt.
