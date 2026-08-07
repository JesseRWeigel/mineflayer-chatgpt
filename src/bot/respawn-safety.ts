// src/bot/respawn-safety.ts
// Deciding whether a freshly respawned bot should run before it resumes work.
//
// Bots respawn at the team base and immediately resume whatever they were
// doing. Measured over one 9h25m session, the first action after a death was
// explore 23 times, go_to 13, mine_block 5, attack 3 — and flee zero times.
// So a bot that is killed by a zombie standing at the base respawns two blocks
// from it and walks straight back into the same mob.
//
// Flora died three times in 76 seconds that way, all at y=69 with the stash at
// y=70, while Blade and Forge died at y=68 in the same minutes. Her role has
// flee but NO attack, so running is her only defence and nothing ever chose it
// for her.
//
// Fleeing works when it is picked: 119 successful flees in the same session.
// The gap is that nothing looks for danger at the moment a bot is most exposed,
// which is the instant it respawns with no armour and no weapon.

/** How close a hostile must be to make resuming work a bad idea. */
export const RESPAWN_DANGER_RADIUS = 12;

/** Should a just-respawned bot flee before doing anything else? */
export function shouldFleeOnRespawn(distanceToNearestHostile: number | null): boolean {
  if (distanceToNearestHostile === null) return false;
  if (!Number.isFinite(distanceToNearestHostile)) return false;
  return distanceToNearestHostile <= RESPAWN_DANGER_RADIUS;
}
