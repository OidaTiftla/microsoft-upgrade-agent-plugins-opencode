# OpenCode Microsoft Upgrade Agent

`opencode-microsoft-upgrade-agent` brings Microsoft Upgrade Agent workflows to OpenCode. It supports .NET and TypeScript/JavaScript upgrades through the Core `Upgrade` MCP and bundled extenders.

## Install and restart OpenCode

Install the npm package, then restart OpenCode so it reloads the plugin configuration.

```bash
opencode plugin opencode-microsoft-upgrade-agent
```

Shared prerequisites are the .NET SDK 10 or later (`dnx`), Node.js 22.18.0 or later, and npx. Node.js 22.18.0 is required because the buildless package launches its TypeScript proxy directly with Node.js native type stripping. The plugin sets `APPMOD_DISABLE_TELEMETRY=true`, `APPMOD_DISABLE_MCP_APPS=true`, and `DOTNET_CLI_TELEMETRY_OPTOUT=true` for the Core MCP process and its spawned extenders. These settings are opt-outs; they are not independent network-level telemetry verification. `DOTNET_NOLOGO=true` suppresses .NET CLI first-run banners.

## Platform support

Supported platforms and architectures:

- Windows x64 and arm64
- macOS x64 and arm64
- Linux x64 and arm64

This matches the six published optional packages of the pinned `@microsoft/jsts-upgrade-assistant@0.1.6` TypeScript MCP: `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`.

The manual sampling gate differs by platform: macOS and Linux may copy existing local provider authentication into an isolated temporary home; Windows requires `OPENCODE_AUTH_CONTENT` because the test does not copy an authentication file where it cannot enforce a secure ACL.

## Configure both model roles

Set OpenCode's top-level `model` and `small_model` in `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "provider/main-model-id",
  "small_model": "provider/fast-model-id",
  "plugin": [["opencode-microsoft-upgrade-agent", { "sampling": "ask" }]]
}
```

- `model` — primary/main model for Upgrade orchestration, repository analysis, planning, and complex edits
- `small_model` — faster, lower-cost model for MCP sampling and bundled lightweight worker agents

Choose a capable, long-context model with reliable tool calling for `model`. Choose an available, authenticated model that is faster and cheaper for `small_model`; use exact `provider/model-id` values and replace the example IDs with models enabled for your provider. If `small_model` is omitted or malformed, sampling falls back to the parent-session model; an unavailable configured model is not automatically replaced.

## Sampling policy

Set `sampling` in the plugin tuple shown above:

- `ask` — default; approval occurs once per chat session when enabling, before any future Core sampling
- `allow` — runs MCP sampling without approval
- `deny` — rejects MCP sampling

To require OpenCode to prompt before sampling, set the project-level permission in `.opencode/opencode.jsonc`:

```jsonc
{
  "permission": {
    "sampling": "ask",
  },
}
```

Restart OpenCode after changing this setting. The plugin's `sampling` option controls the Core MCP policy; the OpenCode permission controls whether OpenCode asks for authorization.

Approval is limited to the current chat session and occurs when `enable_upgrade_mcp` runs. OpenCode 1.18.23 renders the generic `Call tool sampling` prompt and hides MCP prompt previews, provider/model, token details, metadata, and patterns. See the [OpenCode permission renderer](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/tui/src/routes/session/permission.tsx).

Sampling prefers `small_model`, then the parent-session model. Exact MCP hints select a candidate only when it matches one of those configured models; model preferences with higher intelligence priority favor the main model. The Core client remains private inside the plugin. A thin local `Upgrade` proxy MCP is dynamically registered and connected only while enabled. Scenario and task skills remain MCP-provided paths, not native global OpenCode skills.

OpenAI backends that reject `max_output_tokens` use the sampling instruction and post-response OpenCode token accounting validation instead of a provider-side cap.

## Enable Upgrade when needed

At startup, the plugin exposes only four native controls: `enable_upgrade_mcp`, `get_upgrade_mcp_status`, `list_upgrade_mcp_tools`, and `disable_upgrade_mcp`. It does not start or register Upgrade at startup. Have users or agents call `enable_upgrade_mcp`; after it succeeds, the `Upgrade_*` tools are immediately available in the same chat without a refresh. Use the status and list controls to inspect the connection and available tools, and `disable_upgrade_mcp` to disconnect them.

## Select Upgrade and describe the work

Select `Upgrade` in OpenCode's agent picker, then have it enable Upgrade and describe the work.

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
