/**
 * What to say to a bot that is underground.
 *
 * The old line was an order, not an observation:
 *
 *   ALERT: Bot is UNDERGROUND (...). Use 'explore' to reach the surface — you
 *   need sunlight for trees and wood gathering. Cannot gather_wood underground.
 *
 * Correct for a bot that wants wood. Delivered unconditionally, including to
 * Forge — the Miner/Smelter, assigned story/lava_bucket, whose lava is at
 * y=-52. Measured 2026-08-15: the descent work finally put Forge underground
 * and it then spent every decision climbing back out ("Time to climb toward the
 * sun"), invoking fill_bucket zero times that hour. The context was ordering the
 * miner out of the mine.
 *
 * State the constraint; let the goal decide the direction.
 */

/** Roles whose work genuinely needs daylight, so the surface hint still helps. */
const SURFACE_ROLES = new Set(["Farmer / Crafter", "Builder"]);

export function undergroundNote(y: number, ceiling: number, role?: string): string {
  const where = `UNDERGROUND (y=${Math.round(y)}, ceiling ${ceiling} up).`;

  if (role && SURFACE_ROLES.has(role)) {
    return `${where} No wood or crops down here — head to the surface for that.`;
  }

  // Everyone else, and unknown roles: report the fact and the opportunity.
  return `${where} Cannot gather_wood here, but ores are down here and lava pools are common below y=-50.`;
}
