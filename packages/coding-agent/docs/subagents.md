# Subagents

The `subagent` tool starts background tasks and returns their IDs immediately. The parent can continue independent work while children run. Each completed or failed child delivers its own result automatically and normally wakes the parent. Do not poll while waiting.

```json
{"tasks":[{"role":"scout","task":"Find the session lifecycle hooks and report relevant paths."}]}
```

Each task needs a self-contained instruction. Children have independent conversation contexts and do not receive the parent transcript.

- `scout` and `reviewer` can call only `read`, `grep`, `find` and `ls`. Nested calls and startup hooks cannot activate other tools.
- `worker` inherits the parent's active tools and tool restrictions, including extension tools, except `subagent`.

Children share the working directory and filesystem. Assign workers non-overlapping changes; no worktrees are created automatically. Children use native agent sessions with the same model runtime and provider route. They cannot switch models or register providers. Each child reruns the parent's approved extension factories with its own runner, hooks, event bus and factory-local state. Module globals remain shared; extensions must manage shared resources per session. CLI and inline extensions, effective flags, resources, agent directory and project trust are inherited without package installation or fresh discovery.

Children have in-memory settings and sessions. Parent tasks and continuous goals are not copied. Children cannot delegate through `subagent` or the child-session API. Extension code still runs with host permissions; read-only roles restrict tool calls, not arbitrary extension code.

## Manage jobs

| Arguments | Effect |
|---|---|
| `tasks`, optionally `action: "start"` | Start tasks and return IDs |
| `action: "list"` | Show job IDs and states |
| `action: "result", id` | Read a job's current state and completed output |
| `action: "stop", id` | Abort one job and wait for cleanup |
| `action: "clear"` | Remove finished jobs |

At most four children run per session, across all calls. The last 32 jobs remain available in memory; older finished jobs are removed when necessary. Each output is limited to 50,000 characters.

Children survive parent turns and interrupts. Explicitly stopping a child suppresses its completion notification. Changing branches or ending the session aborts all children and waits for cleanup; results cannot leak into another branch. Child sessions emit `session_shutdown` and release provider resources after completion, failure or cancellation.

Results received during parent work enter the transcript without interrupting its response, then trigger continuation at the next normal settlement. An explicit parent interrupt cancels that continuation, not the children or their stored results. Results received during manual compaction remain available for the next prompt.

## Extension hosts

`ctx.createChildSession({ instructions, readOnly })` creates a native child without exposing the parent runtime. `instructions` are appended to the inherited system prompt. Call `prompt(text)` and always await `dispose()` in `finally`; disposal emits shutdown and releases session resources. `abort()` stops the current child run. Nested children are rejected.

This API requires a bound session host and a resource loader with `createChildLoader(settingsManager)`. `DefaultResourceLoader` supplies an isolated snapshot of approved factories and effective resources. Custom loaders must provide equivalent cloning; unsupported loaders fail explicitly. Bare `ExtensionRunner` fixtures must inject `createChildSession` through their context actions or use a native session fixture.
