// src/bot/respawn.ts
// Deciding where a bot should respawn.
//
// The respawn-loop breaker existed to fix a lethal spawn point. It was causing
// one. On firing it re-ran the connect-time landing routine, which uses
// /spreadplayers — and spreadplayers puts you on the TOPMOST safe block. On
// mountainous terrain that is a peak.
//
// Measured over one 3h46m session: 49 spawnpoints were set, clustering at
// y=114-121, while the team stash sits at y=70. Forge then died 29 times, 28 of
// them falls, with origins of y=118, 100, 95, 91, 84 and 80 — the same heights.
// Every one logged controls=none pathing=false, meaning he was not walking off
// anything; he simply started each life 45+ blocks above his base with nowhere
// to go but down.
//
// "Topmost safe block" is only safe against suffocation. It says nothing about
// what happens next.

/** How far above the stash a respawn point may sit before it is a liability.
 *  A bot has to walk home every life; 12 blocks is a climb, 45 is a cliff. */
export const MAX_SPAWN_ELEVATION_ABOVE_STASH = 12;

/** Is this landing spot fit to respawn at, given where the team's base is? */
export function isAcceptableRespawn(landedY: number, stashY: number): boolean {
  return landedY - stashY <= MAX_SPAWN_ELEVATION_ABOVE_STASH;
}

/** Where to put the spawn point after a landing that came out too high.
 *  Falls back to the landing spot when there is no stash to aim at, since an
 *  unknown base is not a reason to leave the bot with no spawn point at all. */
export function respawnTarget(
  landed: { x: number; y: number; z: number },
  stash: { x: number; y: number; z: number } | undefined,
): { x: number; y: number; z: number } {
  if (!stash) return landed;
  return isAcceptableRespawn(landed.y, stash.y) ? landed : stash;
}
