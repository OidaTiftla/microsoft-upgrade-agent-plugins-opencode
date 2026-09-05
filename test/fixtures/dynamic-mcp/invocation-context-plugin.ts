import type { Plugin } from "@opencode-ai/plugin";

import { createInvocationContextPluginFromInput } from "./invocation-context-plugin-core.ts";

const invocationContextPlugin: Plugin = async (input) => {
  return createInvocationContextPluginFromInput(input);
};

export default invocationContextPlugin;
