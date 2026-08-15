/**
 * Is this bot actually wedged, or just working in one place?
 *
 * The unstick timer used to compare the bot's position against an anchor that
 * only advanced when it moved more than 2 blocks in a single sample. A bot
 * mining out a vein, smelting at a furnace, or building a wall never clears
 * that in one 25s tick, so the anchor stayed put, the clock never reset, and
 * after 90 seconds the bot was "rescued" by digging it out mid-action.
 *
 * Measured live 2026-08-15: 892 unstick events across 5 bots in 5.5 hours --
 * roughly continuous firing at the 90s floor. In the same window the swarm
 * finished 14 skills and earned nothing. The rescue for wedged bots was
 * interrupting every bot that was working.
 *
 * Comparing against the PREVIOUS SAMPLE instead fixes it: anything a bot
 * actually does moves it more than a block in 25 seconds, and a genuinely
 * wedged bot does not move at all.
 *
 * Pure so the distinction is testable without a server.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface StuckState {
  /** Where the bot was at the previous sample. */
  lastPos: Vec3Like;
  /** When it was last seen to have moved meaningfully. */
  lastMoveAt: number;
}

/**
 * Movement required between consecutive samples to count as progress.
 *
 * Below 1 block so slow legitimate work still registers; above physics jitter
 * so a bot shoved by a mob or resting on a slab edge does not read as active.
 */
export const SAMPLE_MOVE_BLOCKS = 0.75;

function distance(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function freshState(pos: Vec3Like, now: number): StuckState {
  return { lastPos: { ...pos }, lastMoveAt: now };
}

/**
 * Fold one position sample into the state.
 *
 * The reference point advances every sample regardless, which is the whole
 * correction: a bot travelling steadily but slowly used to look stationary
 * because the anchor it was measured against never moved.
 */
export function sampleMovement(state: StuckState, pos: Vec3Like, now: number): StuckState {
  const moved = distance(pos, state.lastPos) >= SAMPLE_MOVE_BLOCKS;
  return {
    lastPos: { ...pos },
    lastMoveAt: moved ? now : state.lastMoveAt,
  };
}

export function isStuck(state: StuckState, now: number, stuckMs: number): boolean {
  return now - state.lastMoveAt > stuckMs;
}
