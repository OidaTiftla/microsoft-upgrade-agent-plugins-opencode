## OpenCode host compatibility

Use OpenCode tools, not Copilot host tools:

- `execute` means `bash`.
- `search` means `glob` and `grep`.
- `web` means `webfetch`.
- `ask_user` means `question`.
- `agent` and `read_agent` mean `task`; `task` returns the worker result synchronously, so do not poll with `read_agent`.
- `Upgrade/<tool>` means the OpenCode MCP tool `Upgrade_<tool>`.
- Canvas, dashboard, `open_canvas`, and `open_dashboard` calls are unavailable; report concise text status and full artifact paths instead.
- `managing-dotnet-test-installation` and `generating-upgrade-test-baseline` describe an optional Copilot `dotnet-test`/`code-testing-generator` integration. Never run Copilot marketplace or install commands. If `code-testing-generator` is not already a registered OpenCode agent, explain that the optional integration is unavailable and follow the skill's existing Skip/user-decision path.
