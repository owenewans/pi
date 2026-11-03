<div align="center">

# pi

terminal coding agent with background subagents, continuous goals and code intelligence.

<a href="https://count.owenewans.org/owenewans/pi?theme=moebooru-h&notitle"><img src="https://count.owenewans.org/owenewans/pi?theme=moebooru-h&notitle" alt="repository views"></a>

`typescript` `coding-agent` `terminal`

</div>

## features

- continuous tasks with `/goal`, pause and resume
- up to four background subagents, with isolated sessions and read-only scout/reviewer tools
- native Antigravity OAuth, model discovery and quotas
- Codex live and cached web search
- Claude and ChatGPT quota windows
- AST search and edits, hashline edits, GDB, SSH and browser tools
- optional LSP navigation and rename, Fovea repository maps, FFF indexed search, automatic formatting and compiler checks in parent and worker sessions

## install

Requires Node.js 22.19 or newer, npm and Git. Add `$HOME/.local/bin` to `PATH`.

```sh
git clone --branch owenewans https://github.com/owenewans/pi.git
cd pi
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/packages/coding-agent/dist/bundle/cli.js" "$HOME/.local/bin/pi"
```

## usage

```sh
pi
pi --continue
pi -p "explain this repository"
```

Use `/login` to connect a provider and `/model` to select a model.
Settings and credentials live in `~/.pi/agent`, or `PI_CODING_AGENT_DIR`.

## documentation

- [settings](packages/coding-agent/docs/settings.md)
- [providers](packages/coding-agent/docs/providers.md)
- [subagents](packages/coding-agent/docs/subagents.md)
- [extensions](packages/coding-agent/docs/extensions.md)
- [code intelligence configuration](extensions/code-intelligence/configuration.mjs)
- [ACP](packages/coding-agent/docs/acp.md)
- [RPC](packages/coding-agent/docs/rpc.md)

## license

[MIT](license)
