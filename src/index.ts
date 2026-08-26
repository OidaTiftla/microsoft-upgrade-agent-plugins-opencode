import type { Plugin } from "@opencode-ai/plugin";

import {
  createUpgradeAgentPlugin,
  getPluginRuntime,
} from "./upgrade-agent-plugin.ts";

const UpgradeAgentPlugin: Plugin = async (input, options) =>
  createUpgradeAgentPlugin(getPluginRuntime(input), options);

export default UpgradeAgentPlugin;
