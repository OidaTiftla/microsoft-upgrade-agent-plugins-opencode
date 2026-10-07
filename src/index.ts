import type { Plugin } from "@opencode-ai/plugin";

import { createPluginLogger, formatPluginError } from "./plugin-logging.ts";

const UpgradeAgentPlugin: Plugin = async (input, options) => {
  const log = createPluginLogger(input.client);
  log("info", "module invoked");
  try {
    const { createUpgradeAgentPlugin, getPluginRuntime } =
      await import("./upgrade-agent-plugin.ts");
    return await createUpgradeAgentPlugin(getPluginRuntime(input), options);
  } catch (error) {
    log(
      "error",
      `Upgrade plugin initialization failed: ${formatPluginError(error)}`,
    );
    throw error;
  }
};

export default UpgradeAgentPlugin;
