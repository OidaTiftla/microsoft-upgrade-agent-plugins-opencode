## OpenCode host compatibility

Use OpenCode tools, not Copilot host tools:

- `execute` means `bash`.
- `search` means `glob` and `grep`.
- `web` means `webfetch`.
- `ask_user` means native `question`. For a worker question with choices, render the supplied labels and descriptions as its options. For one combined confirmation, make one `question` call with the supplied fields and choices.
- Collect worker results with **one long-wait `task` call**; OpenCode `task` returns the worker result directly and synchronously.
- This supersedes any preceding background `agent` or `read_agent` instructions: `agent` dispatches native `task`; OpenCode `task` returns the worker result directly and synchronously. Keep its `task_id` when a worker needs input, then use that same `task_id` to continue the originating worker after the orchestrator resolves the answer. Never call or poll `read_agent`.
- `Upgrade/<tool>` means the OpenCode MCP tool `Upgrade_<tool>`.
- Before an agent's first `Upgrade_<tool>` call in an OpenCode session, it must call `enable_upgrade_mcp`; after success, dynamic Upgrade tools are immediately callable without refresh/new chat.
- Canvas, dashboard, `open_canvas`, and `open_dashboard` calls are unavailable; report concise text status and full artifact paths instead.
- `managing-dotnet-test-installation` and `generating-upgrade-test-baseline` describe an optional Copilot `dotnet-test`/`code-testing-generator` integration. Never run Copilot marketplace or install commands. If `code-testing-generator` is not already a registered OpenCode agent, explain that the optional integration is unavailable and follow the skill's existing Skip/user-decision path.
