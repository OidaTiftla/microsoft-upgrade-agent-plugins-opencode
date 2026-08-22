# OpenCode Upgrade Agent Plugin

## Rationale

Make the existing Upgrade Agent available as the npm package `opencode-upgrade-agent` without reimplementing Microsoft’s upgrade workflows. Keep the existing agents, skills, and extender manifests as upstream-compatible source assets, and add a thin OpenCode runtime adapter around them to minimize future merge conflicts.

## Acceptance criteria (AC)

- [ ] `opencode-upgrade-agent` can be installed as an OpenCode plugin on Linux, macOS, and Windows, with installation, restart, prerequisites, and usage documented.
- [x] Before MCP startup, the plugin reports actionable diagnostics for missing `dnx`, .NET SDK 10+, Node.js, or `npx` prerequisites instead of surfacing an opaque MCP connection failure.
- [x] The plugin registers all bundled agents (16 at baseline) at runtime with the correct primary/subagent visibility, mapped permissions, and user-selected OpenCode model defaults.
- [x] A shared compatibility instruction maps Copilot behavior to OpenCode: `execute` to `bash`, `search` to `glob`/`grep`, `web` to `webfetch`, `ask_user` to `question`, `agent`/`read_agent` to `task`, MCP tool names to their OpenCode IDs, and Canvas behavior to textual status and artifact paths.
- [x] Agent conversion reports one aggregated warning for unknown optional frontmatter properties and fails initialization for unknown behavior-affecting properties, tools, or unsafe permission mappings.
- [ ] The plugin manages Core through a private MCP client that advertises sampling, discovers bundled extender manifests through a host-owned `host-extenders.json`, and exposes Core plus extender tools to OpenCode without reimplementing Microsoft workflow logic.
- [ ] Core, .NET, and TypeScript MCP package versions are pinned as one tested compatibility set in an OpenCode-owned version manifest; each package retains its independent version scheme, and packaging validates that every MCP has an explicit pin.
- [ ] Renovate proposes updates for all three MCP packages in one compatibility-stack group; MCP updates are never auto-merged and must pass integration and smoke tests.
- [ ] Core receives `APPMOD_DISABLE_TELEMETRY=true` and `APPMOD_DISABLE_MCP_APPS=true`, spawned extenders inherit the opt-outs, and compatibility validation fails if any MCP cannot disable telemetry transmission. Required existing caller-type settings and cold-start timeouts remain effective.
- [ ] MCP sampling defaults to explicit user approval and supports `ask`, `allow`, and `deny` policy modes; approval identifies the requesting MCP, purpose, selected model, token limit, content scope, and configured model provider.
- [ ] Approved sampling runs in a temporary hidden OpenCode child session with all tools denied, uses `small_model` by default and the primary model as fallback, respects MCP model preferences/token limits, propagates cancellation, and removes the child session after completion.
- [ ] The Microsoft MCP workflow remains authoritative: `get_scenarios`, `get_instructions`, and `start_task` provide scenario discovery, progressive skill loading, and task-related skill matching without exposing all bundled skills through OpenCode’s native global skill list.
- [ ] All existing workflows and all in-scope bundled skill directories (101 after removing the source baseline’s Canvas-only skill) remain available through MCP routing, including safe access to referenced files, scripts, and templates, without changing their authored contents.
- [ ] Upgrade progress is reported through text, `get_state`, and existing scenario artifacts; no agent attempts to open a Canvas or dashboard.
- [x] Copilot telemetry hooks, marketplace metadata, cloud-agent setup, Canvas extension, and documentation/assets used only by those features are removed.
- [ ] Unit tests cover manifest/frontmatter conversion, tool and permission mapping, shared compatibility injection, MCP environment construction, unknown-property diagnostics, and safe asset-path handling.
- [ ] Packaging validates that every bundled agent, skill, and extender is converted or explicitly rejected with an actionable error, so upstream additions cannot be silently omitted.
- [ ] Integration tests prove that the plugin-managed MCP bridge launches Core and both pinned extenders, proxies their tools and notifications, resolves representative scenario and lazy skills plus referenced resources, fulfills sampling through OpenCode, and returns task-related skills from a real non-empty plan.
- [ ] Integration tests prove that the primary agent can dispatch every registered worker through OpenCode `task` and consume each result directly without `read_agent`.
- [ ] Concurrent OpenCode sessions do not cross-wire MCP workflow state or extender communication.
- [ ] End-to-end smoke tests cover one representative .NET workflow and one representative TypeScript workflow, including textual interaction and status reporting.
- [ ] The repository’s formatting, validation, and full test commands pass.

## Out of Scope

- Native OpenCode registration of every bundled skill.
- Plugin-provided replacements for Microsoft MCP skill routing, including `upgrade_skill_search` or `upgrade_skill_load`.
- Canvas, web dashboard, MCP UI, or another graphical status surface.
- Telemetry collection by the plugin or its MCP processes.
- GitHub Copilot marketplace, CLI plugin, App, or cloud coding-agent compatibility.
- Reimplementation of Microsoft MCP tools or workflow state management.
- Modification or forking of OpenCode’s built-in MCP client; sampling compatibility lives entirely inside this plugin.

## Technical details

### Keep the adapter thin

- Treat the existing agent files, skill trees, and `upgrade-extension.json` files as canonical source assets.
- Register converted OpenCode agents in the plugin `config` hook rather than maintaining hand-edited OpenCode copies.
- Keep host mappings in one compatibility file and conversion module; do not duplicate them across agent prompts.
- Preserve least-privilege tool access. Never convert an unknown tool to a wildcard permission.

### Let the MCP servers retain workflow ownership

- Treat the plugin-managed sampling bridge as a compatibility gate. Before completing conversion, prove scenario discovery, skill/resource loading, a sampled `start_task` call from a non-empty plan, task-related skill matching, cancellation, and concurrent-session isolation. Stop and report incompatibility if this gate fails.
- Generate host-owned, pinned copies of every discovered `extenders/*/upgrade-extension.json` manifest and index them through `host-extenders.json`; do not hardcode the current two extender paths.
- Start Core through a private MCP SDK client rather than `config.mcp`. Set `APPMOD_HOST_DIR` to the generated host index and `MODERNIZE_ORCHESTRATOR_PLUGIN_ROOT` to the bundled plugin root so Core owns extender startup, peer wiring, skill registration, and workflow state.
- Advertise MCP sampling on the private client, handle `sampling/createMessage` through a model-only OpenCode child session, and expose downstream MCP tools as same-named plugin tools with converted schemas, results, errors, notifications, and cancellation.
- Preserve the source definitions’ commands, arguments, release alignment, caller types, and timeout intent.
- Keep MCP pins in one OpenCode-owned version manifest rather than editing upstream manifests. Use Renovate custom managers with the NuGet and npm datasources; group all three MCP packages as one compatibility stack, preserve their independent versions, disable automerge, and require the compatibility gate before accepting updates.
- Do not duplicate trait detection or skill ranking in the plugin. The MCP lifecycle and skill metadata remain responsible for applicable scenarios and progressive disclosure.
- Make bundled/read-through skill resources accessible without granting unrestricted external-directory access.

### Convert host-specific behavior once

- OpenCode `task` calls return worker results directly; compatibility instructions must override Copilot’s background `agent` plus `read_agent` polling protocol.
- Use `question` for structured choices and plain text only when `question` is unavailable.
- Remove Canvas/open-dashboard instructions and report concise progress plus full artifact paths instead.
- Derive OpenCode model selection from user configuration where possible; do not retain invalid provider-less Copilot model identifiers.
- Never perform sampling silently. Default to a visible permission request associated with the originating tool call; retain approval for the current session only unless the user explicitly configures `allow`.

### Remove obsolete host packaging together

- Replace Copilot distribution manifests with npm/OpenCode package metadata and focused OpenCode installation documentation; retain `upgrade-extension.json` manifests as canonical adapter inputs.
- Remove telemetry hook registration and scripts as one concern.
- Remove marketplace files/assets, cloud-agent files, and Canvas files/references as separate focused cleanup groups to simplify review and upstream reconciliation.

## Notes / risks / open questions

- Core binds repository traits to the first path-bearing tool call and cannot switch repository roots in-process. Keep one private Core client scoped to one OpenCode project root; changing roots requires a restart, while concurrent sessions and sampling requests require explicit correlation and isolation.
- OpenCode does not currently expose MCP sampling through its built-in MCP client. The bridge must associate every server sampling request with an originating plugin tool call and must reject unassociated or concurrent ambiguous requests.
- Microsoft documents these MCP packages primarily for Copilot and VS Code. MCP-first compatibility is a hard validation gate: if OpenCode cannot obtain scenarios, routed skills, task-related skills, or referenced resources, stop and report the incompatibility rather than silently adding a second routing implementation.
- TypeScript workflow tools normally emit telemetry observations. Verify that the pinned TypeScript MCP honors the telemetry opt-out without breaking required workflow tools; otherwise stop at the compatibility gate.
- `dnx` requires .NET SDK 10 or later; repositories pinned to older SDKs may require the documented `global.json` roll-forward handling.
- Cold package caches can make first MCP initialization slow. Preserve the existing five-minute .NET startup allowance and test a cold start.
- Skill scripts and templates may resolve outside the user workspace after npm installation. Constrain access to the plugin’s bundled asset roots and reject traversal or arbitrary absolute paths.
