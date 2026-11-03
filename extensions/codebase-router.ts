import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodebaseRouter } from "../src/controller.js";
import { openRouterSettings, registerSettingsCommand } from "../src/settings-ui.js";

export default function codebaseRouterExtension(pi: ExtensionAPI) {
	const controller = registerCodebaseRouter(pi, { agentDir: getAgentDir(), projectConfigDir: CONFIG_DIR_NAME, openSettings: openRouterSettings });
	registerSettingsCommand(pi, controller);
}
