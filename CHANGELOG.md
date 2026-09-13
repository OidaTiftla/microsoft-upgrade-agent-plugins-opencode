# Changelog

All notable changes to the OpenCode Microsoft Upgrade Agent adapter are documented in this file. Upstream Microsoft Upgrade Agent workflow, skill, and extender changes are not tracked here.

## [0.2.0] - 2026-09-13

### Added

- Lazy Upgrade MCP controls for enabling, inspecting, listing, and disabling
  the integration when needed.
- An authenticated local proxy for dynamically exposing Core Upgrade tools
  while preserving session correlation, cancellation, and cleanup.
- Guidance for configuring separate primary and small OpenCode models.
- Worker question handling that resumes the originating task with its
  existing task ID.

### Changed

- Improved MCP startup diagnostics, readiness checks, and cross-platform
  process and path handling.
- Raised the Node.js requirement to 22.18.0 for native TypeScript execution.
- Updated the compatible OpenCode and TypeScript Upgrade MCP dependencies.

## [0.1.1] - 2026-08-30

### Fixed

- Exposed the `./server` package entry point required for OpenCode to load the plugin.

### Changed

- Updated the OpenCode plugin and MCP SDK dependencies.
- Updated the bundled TypeScript/JavaScript Upgrade MCP compatibility set.

## [0.1.0] - 2026-08-30

### Added

- Initial OpenCode adapter for Microsoft Upgrade Agent workflows.
- Runtime conversion and registration of bundled Upgrade agents for OpenCode.
- Private Core Upgrade MCP bridge with .NET and TypeScript/JavaScript extenders.
- OpenCode-compatible tool, permission, sampling, and progress-reporting behavior.
- Validation for converted assets, package contents, MCP compatibility, and OpenCode integration.

### Changed

- Migrated the Upgrade Agent distribution from Copilot-specific packaging to the `opencode-microsoft-upgrade-agent` npm plugin.

### Removed

- Copilot-only marketplace, telemetry, Canvas, dashboard, and cloud-agent integrations.
