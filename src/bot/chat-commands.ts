import { filterViewerMessage } from "../safety/filter.js";

export type ChatCommand =
  | { name: "status" | "come" | "stay" | "resume" | "inventory" }
  | { name: "goal"; operation: "show" | "clear" }
  | { name: "goal"; operation: "set"; text: string };

export type ParsedChatCommand =
  | { kind: "chat" }
  | { kind: "denied" }
  | { kind: "invalid"; message: string }
  | { kind: "command"; command: ChatCommand };

/** Parse only exact command names, authorizing before interpreting arguments. */
export function parseChatCommand(username: string, message: string, whitelist: readonly string[]): ParsedChatCommand {
  const input = message.trim();
  if (!input.startsWith("!")) return { kind: "chat" };
  if (!username || !whitelist.some((player) => player.trim().toLowerCase() === username.toLowerCase())) {
    return { kind: "denied" };
  }
  if (!filterViewerMessage(input).safe) return { kind: "invalid", message: "Command rejected by the safety filter." };

  const [name, ...args] = input.slice(1).split(/\s+/);
  switch (name.toLowerCase()) {
    case "status":
    case "come":
    case "stay":
    case "resume":
    case "inventory":
      if (args.length) return { kind: "invalid", message: `Usage: !${name.toLowerCase()}` };
      return {
        kind: "command",
        command: { name: name.toLowerCase() as "status" | "come" | "stay" | "resume" | "inventory" },
      };
    case "goal": {
      const operation = args[0]?.toLowerCase() ?? "show";
      if (operation === "set" && args.length > 1) {
        return { kind: "command", command: { name: "goal", operation, text: args.slice(1).join(" ") } };
      }
      if ((operation === "show" || operation === "clear") && args.length <= 1) {
        return { kind: "command", command: { name: "goal", operation } };
      }
      return { kind: "invalid", message: "Usage: !goal set <text> | !goal clear | !goal show" };
    }
    default:
      return { kind: "invalid", message: "Commands: !status, !come, !stay, !resume, !goal, !inventory" };
  }
}
