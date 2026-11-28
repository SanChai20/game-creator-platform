# hearthcade-acp

Use your own coding agent in the HearthCade console. The bridge starts an agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) on your computer and connects it to the console's workbench
(`/console/workbench`). The agent runs with your files; the console is its window.

```sh
npx -y https://hearthcade.com/acp/hearthcade-acp-1.0.3.tgz claude     # or codex, gemini, copilot, cursor, opencode…
npx -y https://hearthcade.com/acp/hearthcade-acp-1.0.3.tgz list       # every agent it knows
npx -y https://hearthcade.com/acp/hearthcade-acp-1.0.3.tgz -- my-agent --acp   # any ACP agent by its command
```

Needs Node.js 22 or newer. The first run shows a code to approve in the console; the computer is then remembered
(`~/.hearthcade/workbench.json`, valid 90 days, removable in the console). `logout` forgets it.

- The agent gets HearthCade's MCP tools through a local proxy on 127.0.0.1 that holds the access token, so the token
  never reaches the agent. The access is revoked when the bridge stops.
- The bridge offers the agent no file or terminal capabilities of its own: the agent works in the folder you started
  it in with its own tools, and asks for permission in the console.
