# OpenCode Upgrade Agent

`opencode-upgrade-agent` brings Microsoft Upgrade Agent workflows to OpenCode. It supports .NET and TypeScript/JavaScript upgrades through the Core `Upgrade` MCP and bundled extenders.

## Install and restart OpenCode

Install the npm package, then restart OpenCode so it reloads the plugin configuration.

```bash
opencode plugin opencode-upgrade-agent
```

The plugin requires the .NET SDK 10 or later (`dnx`), Node.js, npm, and npx. It disables telemetry and MCP Apps for the Core MCP and its extenders.

## Select Upgrade and describe the work

Select `Upgrade` in OpenCode's agent picker, then describe the upgrade.

```text
upgrade my solution to .NET 10
```

The agent reports progress as text and gives full artifact paths. Canvas and dashboard features are unavailable.

Optional test-baseline generation needs an already registered `code-testing-generator` agent. OpenCode does not install Copilot plugins; choose the workflow's Skip path when that optional integration is unavailable.

Core binds an MCP process to the first repository path it receives. Restart OpenCode before switching repositories.

## Validate changes during development

```bash
npm run format
npm run typecheck
npm test # executes the following tests:
# npm run test:plugin
# npm run test:integration
# npm run test:opencode
# npm run test:package
npm run pack:dry-run
```
