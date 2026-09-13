# Changelog

All notable changes to the OpenCode Microsoft Upgrade Agent adapter are documented in this file. Upstream Microsoft Upgrade Agent workflow, skill, and extender changes are not tracked here.

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
