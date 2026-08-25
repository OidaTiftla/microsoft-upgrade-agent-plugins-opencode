# OpenCode Upgrade Agent

`opencode-upgrade-agent` brings Microsoft Upgrade Agent workflows to OpenCode. It supports .NET and TypeScript/JavaScript upgrades through the Core `Upgrade` MCP and bundled extenders.

## Install and restart OpenCode

Install the npm package, then restart OpenCode so it reloads the plugin configuration.

```bash
opencode plugin opencode-upgrade-agent
```

Shared prerequisites are the .NET SDK 10 or later (`dnx`), Node.js, and npx. The plugin sets `APPMOD_DISABLE_TELEMETRY=true` and `APPMOD_DISABLE_MCP_APPS=true` for the Core MCP process and its spawned extenders. These settings are opt-outs; they are not independent network-level telemetry verification.

## Platform support

Supported platforms and architectures:

- Windows x64 and arm64
- macOS x64 and arm64
- Linux x64 and arm64

This matches the six published optional packages of the pinned `@microsoft/jsts-upgrade-assistant@0.1.6` TypeScript MCP: `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`.

The manual sampling gate differs by platform: macOS and Linux may copy existing local provider authentication into an isolated temporary home; Windows requires `OPENCODE_AUTH_CONTENT` because the test does not copy an authentication file where it cannot enforce a secure ACL.

## Sampling policy

Configure the plugin as a tuple when changing sampling behavior:

```json
{
  "plugin": [["opencode-upgrade-agent", { "sampling": "ask" }]]
}
```

- `ask` — default; approval discloses the MCP, purpose, provider/model, token limit, and a bounded content preview
- `allow` — runs MCP sampling without approval
- `deny` — rejects MCP sampling

Sampling uses `small_model` by default, then the parent-session model. Exact MCP hints only select configured candidates. The Core MCP runs privately inside the plugin; it is not registered in `config.mcp`. Scenario and task skills remain MCP-provided paths, not native global OpenCode skills.

OpenAI backends that reject `max_output_tokens` use the sampling instruction and post-response OpenCode token accounting validation instead of a provider-side cap.

## Select Upgrade and describe the work

Select `Upgrade` in OpenCode's agent picker, then describe the upgrade.

```text
upgrade my solution to .NET 10
```

The agent reports progress as text and gives full artifact paths. Canvas and dashboard features are unavailable.

Optional test-baseline generation needs an already registered `code-testing-generator` agent. OpenCode does not install Copilot plugins; choose the workflow's Skip path when that optional integration is unavailable.

Core binds an MCP process to the first repository path it receives. Restart OpenCode before switching repositories.

## Limitations

The compatibility gate runs the required TypeScript tools under the telemetry and MCP Apps opt-out, but cannot prove vendor transport suppression. Egress-sensitive environments should enforce their own network policy.

## Validate a source checkout during development

```bash
npm run format
npm run typecheck
npm test # executes the following tests:
# npm run test:plugin
# npm run test:integration
# npm run test:opencode
# npm run test:package
```

## Manual credentialed sampling gate

Excluded from `npm test` and the published npm package; run from a source checkout. It proves a sampled `Upgrade_start_task` through the production plugin after a canonical plan, with exact-once resume/start tool evidence. See the platform note above for authentication handling.

```bash
OPENCODE_UPGRADE_E2E_MODEL=provider/model npm run test:sampling-e2e
```
