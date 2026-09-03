import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { createLazyMcpPlugin } from "./lazy-mcp-plugin-core.ts";

export default async function lazyMcpPlugin(
  input: PluginInput,
): Promise<Hooks> {
  return createLazyMcpPlugin(input.client);
}
