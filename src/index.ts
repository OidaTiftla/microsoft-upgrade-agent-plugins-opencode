import type { Plugin } from "@opencode-ai/plugin";

import {
  logPluginLoadFailure,
  logPluginLoadState,
} from "./plugin-diagnostics.ts";

const UpgradeAgentPlugin: Plugin = async (input, options) => {
  logPluginLoadState("module invoked");
  try {
    const { createUpgradeAgentPlugin, getPluginRuntime } =
      await import("./upgrade-agent-plugin.ts");
    return await createUpgradeAgentPlugin(getPluginRuntime(input), options);
  } catch (error) {
    logPluginLoadFailure("initialization", error);
    throw error;
  }
};

export default UpgradeAgentPlugin;
