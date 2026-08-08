// src/bot/fall-tracker.ts
// Tracks how far a bot fell, for death attribution.
//
// The first version of this logged nothing across two fall deaths. It updated
// "last ground Y" on every movement tick where onGround was true — but a falling
// bot LANDS before it dies, and that landing fires a grounded tick which
// overwrote the height with the bottom of the fall. Drop computed as ~0 and the
// log suppressed itself.
//
// The height that matters is the ground the bot left, captured on the
// ground -> airborne transition and held until the next one, so it survives the
// landing tick and is still readable when the death event arrives.

export interface FallTracker {
  /** `context` describes what was moving the bot at this instant. It is only
   *  retained if this tick is the moment the bot leaves the ground, which is the
   *  one sample that says what walked it off the edge. */
  update(y: number, onGround: boolean, now: number, context?: string): void;
  /** Blocks fallen from the last ground the bot left, given where it ended up. */
  dropFrom(currentY: number): number;
  /** Height the fall started from — the ground the bot walked off. */
  originY(): number;
  /** How long it has been airborne, or since it landed. */
  airborneMs(now: number): number;
  /** What was moving the bot when it left the ground. */
  originContext(): string;
  /**
   * The last sample taken while the bot was still standing — what it was ON.
   *
   * Distinct from originContext() on purpose. By the ground -> airborne tick the
   * bot is already over the gap, so anything read about the world BELOW it then
   * describes where it is falling to, not where it left. Controls and velocity
   * are only meaningful at departure; footing is only meaningful one tick earlier.
   */
  originFooting(): string;
}

export function createFallTracker(initialY: number): FallTracker {
  let onGroundPrev = true;
  let lastGroundY = initialY;
  let fallStartY = initialY;
  let leftGroundAt = 0;
  let departureContext = "";
  // The two halves of a fall origin, sampled one tick apart. lastGroundContext
  // trails the feet exactly as lastGroundY does, and freezes at the same moment.
  let lastGroundContext = "";
  let footingContext = "";

  return {
    update(y, onGround, now, context = "") {
      if (onGround) {
        // Whatever is true while standing is the last honest description of the
        // ground. Held here, frozen below, for the same reason as lastGroundY.
        lastGroundContext = context;
        if (onGroundPrev) {
          // Continuous ground contact — no fall is pending, so the origin tracks
          // the feet. Without this a bot walking down a 10-block slope reported a
          // 10-block fall, because the origin sat at wherever it first spawned.
          fallStartY = y;
        }
        // Else: this tick IS the landing. Hold the frozen origin so the death
        // event, which fires immediately after fall damage, can still read it.
        // A bot that survives resumes tracking on the next grounded tick.
        lastGroundY = y;
      } else if (onGroundPrev) {
        // Ground -> airborne: the only moment the fall origin is knowable.
        fallStartY = lastGroundY;
        leftGroundAt = now;
        departureContext = context;
        footingContext = lastGroundContext;
      }
      onGroundPrev = onGround;
    },
    dropFrom(currentY) {
      return fallStartY - currentY;
    },
    originY() {
      return fallStartY;
    },
    airborneMs(now) {
      return leftGroundAt === 0 ? 0 : now - leftGroundAt;
    },
    originContext() {
      return departureContext;
    },
    originFooting() {
      return footingContext;
    },
  };
}
