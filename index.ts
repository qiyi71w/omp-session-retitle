import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, loadRules } from "./src/config.ts";
import { RetitleController } from "./src/controller.ts";
import { generateTitle } from "./src/omp.ts";

export default function retitleExtension(pi: ExtensionAPI): void {
  const controller = new RetitleController(pi, {
    loadConfig: cwd => loadConfig(cwd, getAgentDir(), process.env.OMP_RETITLE_CONFIG),
    loadRules,
    generate: generateTitle,
  });
  pi.registerCommand("retitle", {
    description: "Refresh the title from the current branch; undo restores the previous title, cancel stops generation",
    getArgumentCompletions: prefix => ["undo", "cancel"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: (args, ctx) => controller.handle(args, ctx),
  });
  const invalidate = () => controller.invalidate();
  pi.on("session_start", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_switch", invalidate);
  pi.on("session_before_branch", invalidate);
  pi.on("session_branch", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("session_shutdown", invalidate);
  pi.on("agent_start", invalidate);
  pi.on("message_start", invalidate);
}
