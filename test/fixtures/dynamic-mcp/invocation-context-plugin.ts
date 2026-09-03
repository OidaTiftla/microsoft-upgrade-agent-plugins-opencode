import type { Plugin } from "@opencode-ai/plugin";

import { createInvocationContextPlugin } from "./invocation-context-plugin-core.ts";

const invocationContextPlugin: Plugin = async (input) => {
  return createInvocationContextPlugin(input.client);
};

export default invocationContextPlugin;
