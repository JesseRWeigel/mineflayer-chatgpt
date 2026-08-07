// src/bot/death-trap.ts
// Refusing to walk back into the place that just killed you, repeatedly.
//
// Forge died 31 times in under two hours, median gap 53 seconds, five of them
// inside 94 seconds. He was wearing an iron chestplate and boots for 16 of
// them, so armour was not the gap. His deaths cluster at two coordinates: 13
// near (296,61,-304) and 9 near (288,66,-312). He respawns at base, walks back
// to the same tunnel, and dies again.
//
// Two existing mechanisms failed to help:
//
//   the respawn-loop breaker fired 7 times and resets the SPAWN point, but the
//   danger is not at spawn, it is where he walks to
//
//   memory.shouldAvoidLocation has existed all along with ZERO callers, and the
//   prompt does say "RECENT DEATHS at (x,y,z)" — the model read it and went
//   back thirteen times. Advice the model ignores is not a guard.
//
// The base is deliberately exempt. Deaths cluster there too (9 near the stash),
// and blacklisting the stash would stop the swarm depositing, which is worse
// than the deaths it would prevent.

export interface DeathRecord {
  x: number;
  y: number;
  z: number;
  timestamp?: string;
}

/** Horizontal radius that counts as "the same place". */
export const TRAP_RADIUS = 8;
/** Deaths inside the window before a place is treated as lethal. */
export const TRAP_DEATH_THRESHOLD = 3;
/** How far back to look. Old deaths should not condemn a spot forever. */
export const TRAP_WINDOW_MS = 20 * 60 * 1000;

/** How many recent deaths happened within TRAP_RADIUS of this point. */
export function deathsNear(
  target: { x: number; z: number },
  deaths: DeathRecord[],
  now: number,
  windowMs: number = TRAP_WINDOW_MS,
): number {
  let n = 0;
  for (const d of deaths) {
    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (Number.isFinite(t) && now - t > windowMs) continue;
    }
    if (Math.hypot(d.x - target.x, d.z - target.z) <= TRAP_RADIUS) n++;
  }
  return n;
}

/** Should the bot refuse to travel here?
 *
 *  `atBase` is passed in rather than computed so the caller owns the base
 *  definition, and so this stays pure and testable. */
export function isDeathTrap(
  target: { x: number; z: number },
  deaths: DeathRecord[],
  now: number,
  atBase: boolean,
): boolean {
  if (atBase) return false; // never blacklist the stash — the swarm has to deposit
  return deathsNear(target, deaths, now) >= TRAP_DEATH_THRESHOLD;
}
