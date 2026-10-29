# Telegram reader

The `telegram` tool reads messages and downloads media through a shared local HTTP MCP service. It never exposes sending or account changes. One service owns the account session for all pi sessions.

Install [telegram-mcp](https://github.com/chigwell/telegram-mcp) at revision `20eaff3ea1b0dcc21f4c163167e5b3eaad16b48a` in a Python virtual environment with its locked dependencies and proxy extra. Obtain API credentials and authorize a user session locally using that project's instructions. Keep credentials and sessions private; do not paste them into pi or chat.

Store `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and the authorized `TELEGRAM_SESSION_NAME` or `TELEGRAM_SESSION_STRING` in `~/.config/telegram-mcp/account.env` with mode 600. Set `PI_TELEGRAM_ENV` to use a different private file. Relative session filenames resolve in `~/.local/share/telegram-mcp`.

Start the shared service with the virtual environment's Python:

```sh
PI_TELEGRAM_PYTHON=/path/to/venv/bin/python pi telegram-service
```

Leave it running while pi uses Telegram. It binds to `127.0.0.1:8765`, exposes read-only operations plus `download_media`, and uses an exclusive account-session lock. Pi's shared proxy and `proxyOverrides.telegram` route Telegram traffic through a private local bridge. The service receives only the bridge address, not upstream proxy credentials. A failed proxy never falls back to a direct connection. Restart the service after changing proxy settings. Stop it before using another process with the same Telegram session.

Use `telegram` with `action: list` to inspect available schemas, then `action: call` for an allowed read. Downloads stay in `~/Downloads/telegram`. Pi connects to the local endpoint by default; `TELEGRAM_MCP_URL` selects a different local HTTP endpoint. An independently started service must configure its own Telegram proxy and read-only policy; pi cannot change its upstream route.
