<div align="center">

# pi

terminal coding agent with background subagents, continuous goals and code intelligence.

<a href="https://count.owenewans.org/owenewans/pi?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/pi?theme=moebooru-h&notitle" alt="repository views"></a>

`typescript` `coding-agent` `terminal`

</div>

Personal fork of [Pi](https://github.com/earendil-works/pi), based on version 1.5.0.

## features

- Continuous goals with `/goal`, `/goal resume` and `/stop`.
- Up to four background subagents with isolated sessions and extension hooks. Workers share the filesystem; scouts and reviewers have read-only tools.
- Native Antigravity OAuth, model discovery and quotas, plus Codex live and cached web search through the existing account.
- Claude and ChatGPT quota windows when the provider reports them.
- AST search and edits, hashline edits, GDB sessions, SSH tools and browser integration.
- Optional LSP navigation and rename, repository maps, indexed search, formatting and compiler checks in parent and worker sessions.

## build

Requires Node.js 22.19 or newer, npm and Git. Build this checkout to use the fork; the upstream npm package does not contain these changes.

```sh
git clone --branch owenewans https://github.com/owenewans/pi.git
cd pi
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
node packages/coding-agent/dist/bundle/cli.js
```

`hydrate:model-data` downloads the pinned model catalog. The offline build uses that local data without refreshing it.

To expose the build as `pi`, add `$HOME/.local/bin` to `PATH` and create a symlink from the repository root:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/packages/coding-agent/dist/bundle/cli.js" "$HOME/.local/bin/pi"
```

## usage

Start `pi` in a project directory. Use `/login` to connect a provider and `/model` to select a model.

```text
/goal fix the failing tests and run the checks
/goal
/stop
/goal resume
```

The `subagent` tool starts background jobs and delivers results automatically. Read [subagents](packages/coding-agent/docs/subagents.md) for roles and lifecycle details.

Configuration and credentials live in `~/.pi/agent`, or the directory set by `PI_CODING_AGENT_DIR`. Put global instructions in that directory's `AGENTS.md` and project instructions in the project's `AGENTS.md`. Configure `httpProxy` in the agent directory's `settings.json` for Pi-managed network requests.

## code intelligence

The optional [code-intelligence package](extensions/code-intelligence) combines:

| component | purpose |
|---|---|
| pi-lsp | persistent language servers, navigation, diagnostics and workspace edits |
| Fovea | AST repository maps and structural queries |
| FFF | indexed file and content search |
| pi-autoformat | formatting and compiler feedback after mutations |

Install from the repository root:

```sh
npm --prefix extensions/code-intelligence ci --ignore-scripts --legacy-peer-deps
npm --prefix extensions/code-intelligence run setup
```

Setup requires Linux x86_64, Python 3, curl and GNU patch. It downloads pinned Ruff and rust-analyzer binaries through `httpProxy` when `PI_CODING_AGENT_DIR` is set, or through `HTTPS_PROXY` / `ALL_PROXY`. Install other language toolchains separately.

Add the package's absolute path to `packages` in your agent-directory `settings.json`. Add `"+tool_search"` to `defaultTools` for advanced LSP tool discovery. [configuration.mjs](extensions/code-intelligence/configuration.mjs) exports `configuration()` with these settings:

| returned value | destination in the agent directory |
|---|---|
| `lsp` | the `lsp` key in `settings.json` |
| `fovea` | `fovea.json` |
| `fff` | `pi-fff.json` |
| `autoformat` | `extensions/pi-autoformat/config.json` |

Merge settings with existing configuration, then restart Pi. The configuration covers C/C++, Go, Rust, JS/TS and Python. Shell and Zig formatting/checking require their external tools; Fovea does not provide Zig structure. Compiler checks use offline dependency modes, so fetch project dependencies beforehand.

## development

```sh
npm run check
npm run test:scripts
npm --prefix extensions/code-intelligence test
```

`npm --prefix extensions/code-intelligence run test:live` exercises real language servers and toolchains for C, Go, Rust, JS/TS and Python, including parent/child sessions. It requires those tools and uses a local test model.

## documentation

[terminal usage](packages/coding-agent/docs/usage.md) · [settings](packages/coding-agent/docs/settings.md) · [providers](packages/coding-agent/docs/providers.md) · [extensions](packages/coding-agent/docs/extensions.md) · [ACP](packages/coding-agent/docs/acp.md) · [RPC](packages/coding-agent/docs/rpc.md)

## license

[MIT](license). Upstream copyright and bundled third-party licenses remain with their authors.
