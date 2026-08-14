// The curriculum, rendered for the strategic prompt.
//
// Deliberately one line and one goal. The frontier can hold a dozen reachable
// advancements; showing all of them recreates the problem the skill menu had,
// where a model given a long list picks the familiar item every time.

import { frontierOf, TOTAL_ADVANCEMENTS } from "./advancement-tree.js";
import { assignFor } from "./advancement-routing.js";

export function advancementLine(role: string, earned: Set<string>): string {
  const target = assignFor(role, frontierOf(earned));
  if (!target) return "";
  const desc = target.description ? ` — ${target.description}.` : "";
  return `ADVANCEMENTS: ${earned.size}/${TOTAL_ADVANCEMENTS} earned. NEXT FOR YOU: "${target.title}" (${target.id})${desc}`;
}
