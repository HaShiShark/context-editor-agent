# App Agent

`app_agent` contains the product-specific agent layer for the desktop app.

Read it in this order:

1. `session_agent.py` owns one chat session's agent state: settings, history,
   instructions, enabled tools, and the call into `AgentCore`.
2. `settings.py` reads and writes desktop app settings, including provider,
   model, persona, context limits, and tool toggles.
3. `tools.py` defines the local tool catalog and executes enabled tools.

Provider clients and provider adapter selection live in `agent_runtime`, because
they are runtime concerns rather than desktop-product state.
