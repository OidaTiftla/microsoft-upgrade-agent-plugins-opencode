import type { Plugin } from "@opencode-ai/plugin";

import { createUpgradeAgentPlugin } from "./upgrade-agent-plugin.ts";

const UpgradeAgentPlugin: Plugin = async () => createUpgradeAgentPlugin();

export default UpgradeAgentPlugin;
