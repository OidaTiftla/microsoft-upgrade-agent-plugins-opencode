## Dynamic-MCP proof of concept

### Context-correlation spike (phase 1)

- isolated fixture only; does not modify or migrate `Upgrade`
- `test/fixtures/dynamic-mcp/invocation-context-plugin.ts`
  - enables a dynamically registered local stdio proxy MCP
  - starts a token-authenticated `127.0.0.1` IPC listener only while enabled
  - registers `{ sessionID, callID, tool }` in `tool.execute.before` and releases it in `tool.execute.after`
- `invocation-context-proxy_get_invocation_context`
  - returns the active invocation context through the authenticated local IPC channel
  - one proxy invocation at a time; unmatched or concurrent calls fail clearly
- **Not Core sampling yet**
  - no Core MCP changes, sampling requests, or Upgrade migration

### Sampling-authorization spike (phase 2)

- isolated fixture only; does not modify or migrate `src/upgrade-agent-plugin.ts`
- shared sampling-authorization abstraction models two strategies
  - current `SessionScopedSamplingAuthorizer`
    - native `enable_invocation_context_proxy` calls `ToolContext.ask` before IPC startup or MCP registration/connection
    - records approved session IDs for a future IPC sampling request to check
  - future `PerSamplingAuthorizer`
    - exposes `enforce` for a future IPC sampling data plane to call
    - calls `ToolContext.ask` for every sampling request with a request-specific permission pattern
    - remains unused by current dynamic proxy hooks
- no child-session sampling, Core client, or IPC sampling request exists in this phase
- per-sampling content preview is the intended future approval behavior
  - current dynamic proxy hooks do not provide a `ToolContext` for an incoming proxy sampling request
  - therefore this phase can only request session-scoped approval at enable time; content preview is unavailable

#### Manual verification

1. Load `test/fixtures/dynamic-mcp/invocation-context-plugin.ts` as a local OpenCode plugin.
2. Invoke `enable_invocation_context_proxy` and approve its session-scoped sampling authorization prompt.
3. Invoke `invocation-context-proxy_get_invocation_context` in the same chat.
4. Verify JSON containing the current `sessionID`, `callID`, and qualified `tool`; then invoke `disable_invocation_context_proxy`.

- **Do not build on the static-contract work**
  - isolated experimental plugin
  - no checked-in tool cache
  - revert/replace current approach only after proof succeeds

### 1. Local development fixture

- `test/fixtures/dynamic-mcp/hello-mcp.ts`
  - stdio MCP server
  - one `hello_world` tool
  - process-start marker for assertions

- `test/fixtures/dynamic-mcp/lazy-mcp-plugin.ts`
  - native bootstrap tools: `enable_hello_mcp`, `get_hello_mcp_status`, `list_hello_mcp_tools`, and `disable_hello_mcp`
  - no MCP server started during plugin/config initialization

- development loading
  - local plugin path in temporary `OPENCODE_CONFIG_CONTENT`
  - or `.opencode/plugins/lazy-mcp-plugin.ts`
  - no npm publish/install required

### 2. Bootstrap behavior

- `enable_hello_mcp`
  - idempotently call OpenCode’s runtime MCP-add API
  - add local stdio `hello-mcp`
  - OpenCode starts it, calls `tools/list`, registers `hello_world`
  - immediately make `hello-mcp_hello_world` callable in the current chat
  - no new chat or tool-list refresh is required
  - return the connected status and each available tool definition immediately, including `hello-mcp_hello_world` and its description (`Return a friendly greeting.`)
  - example: “Hello MCP enabled; status=connected; available tool: `hello-mcp_hello_world` — Return a friendly greeting.; invoke `hello-mcp_hello_world` directly; no new chat or tool-list refresh is required.”

- `get_hello_mcp_status`
  - call `client.mcp.status({ throwOnError: true })` only
  - never add, connect, or disconnect the MCP server
  - report a missing `hello-mcp` entry as `not registered`
  - report `connected`, `disabled`, or `failed`; include the failure error
  - for `connected`, return the same `hello-mcp_hello_world` definition and direct-invocation instruction as `enable_hello_mcp`

- `list_hello_mcp_tools`
  - query the existing Hello MCP status only; never add, connect, or disconnect it
  - for `connected`, return all shared qualified Hello MCP tool definitions and direct-invocation guidance
  - for absent, `disabled`, or `failed`, return no-tools-available with the status and failure error where relevant

- discovery APIs
  - `tool.ids` and `tool.list` are diagnostic only
  - direct invocation is the acceptance criterion; neither API needs to be refreshed

- no persistent contract cache
  - active tool definitions held only by OpenCode’s live MCP registry
  - disposed on disconnect/restart

### 3. Tests

- startup
  - no Hello MCP process marker
  - `opencode mcp list` contains no `hello-mcp`
  - regular-agent chat context contains no `hello_world`

- enable
  - invoke `enable_hello_mcp`
  - process starts exactly once
  - MCP status reports connected
  - directly invoke `hello-mcp_hello_world` in the same chat
  - `hello-mcp_hello_world` returns expected text

- idempotency/failure
  - second enable → no second process
  - invalid MCP command → actionable bootstrap error
  - retry after failure succeeds

- disable
  - invoke a minimal `disable_hello_mcp` control tool
  - call OpenCode runtime disconnect API
  - verify process exit
  - verify subsequent direct invocation no longer receives `hello_world`

- status
  - missing entry → `not registered`
  - connected → tool definition and direct-invocation instruction
  - disabled → `disabled`
  - failed → `failed` and the MCP error
  - status checks make no add/connect/disconnect calls

- list
  - connected → all shared qualified tool definitions and direct-invocation guidance
  - absent, disabled, or failed → concise no-tools-available result with status/error
  - list checks make no add/connect/disconnect calls

### 4. Decision gate

- current CLI: `1.18.21`
- package target: `1.18.23`
- both exact versions expose runtime MCP add/disconnect through the plugin SDK client
- live result confirms direct invocation immediately after enable in the current chat
- discovery APIs are not required for the confirmed behavior
  - [MCP runtime API](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts)

### 5. Upgrade-plugin migration

- bootstrap tool allowed only for `Upgrade` agent
- default agents receive no Upgrade MCP tools
- selected `Upgrade` agent enables MCP
- dynamically registered real `Upgrade_*` tools become directly callable in the current chat
- disable/disconnect clears them for subsequent direct invocations

- **Key risk**
  - runtime API currently exposes `disconnect`; full removal/unregistration after disconnect remains part of the POC acceptance test
