const DIAGNOSTICS_ENVIRONMENT_VARIABLE = "OPENCODE_UPGRADE_AGENT_DIAGNOSTICS";

export function logPluginLoadState(state: string): void {
  if (process.env[DIAGNOSTICS_ENVIRONMENT_VARIABLE] !== "1") return;
  console.error(`opencode upgrade-agent: ${state}`);
}

export function logPluginLoadFailure(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logPluginLoadState(`${stage} failed: ${message}`);
}
