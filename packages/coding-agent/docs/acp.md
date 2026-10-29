# ACP for Zed

Configure a custom agent server in Zed to run this installation of pi:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "/absolute/path/to/pi",
      "args": ["acp"]
    }
  }
}
```

Log in and choose a default model in pi's terminal interface first. Each ACP session starts a separate RPC process from the same pi installation and retains a pi session file. Text and image prompts, text and thinking streams, tool calls, file locations, model selection and cancellation are supported. Tools run locally without approval prompts.

Session history lists sessions for the requested working directory and replays user and assistant text when loaded; past tool calls and images are not replayed. Terminal authentication opens pi for interactive login. Client-supplied MCP servers are not yet supported. Configure MCP servers in pi rather than sending them through the client. Editor context in the terminal interface is documented separately in [zed.md](zed.md).
