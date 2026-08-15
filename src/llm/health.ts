/**
 * Is the brain actually answering?
 *
 * On 2026-08-15 Ollama wedged: /api/tags answered, chat requests never
 * completed. Every strategic call timed out, the brain fell back to
 * "Planning...", and all five bots chose idle. The swarm sat inert for hours
 * and nothing in the logs said why -- the only evidence was one undici stack
 * trace among thousands of routine lines, and the visible symptom (bots not
 * moving) was indistinguishable from a navigation failure.
 *
 * The cost was an hour spent diagnosing the stuck-detector, which was working
 * correctly and reporting exactly what was true: the bots were not moving,
 * because they had nothing to do.
 *
 * A brain that cannot think should say so once, loudly. Once, because a line
 * repeated on every failed call is how the original trace got buried.
 */

/** Consecutive failures before we call it an outage rather than flakiness. */
export const UNHEALTHY_AFTER = 4;

interface Health {
  healthy: boolean;
  consecutiveFailures: number;
}

let state: Health = { healthy: true, consecutiveFailures: 0 };

export interface CallOutcome {
  /** True on the single call that turns a healthy brain unhealthy. */
  justTripped: boolean;
  /** True on the single call that brings it back. */
  justRecovered: boolean;
}

export function recordLlmCall(ok: boolean): CallOutcome {
  if (ok) {
    const justRecovered = !state.healthy;
    state = { healthy: true, consecutiveFailures: 0 };
    return { justTripped: false, justRecovered };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const nowUnhealthy = consecutiveFailures >= UNHEALTHY_AFTER;
  const justTripped = nowUnhealthy && state.healthy;
  state = { healthy: !nowUnhealthy, consecutiveFailures };
  return { justTripped, justRecovered: false };
}

export function llmHealth(): Health {
  return { ...state };
}

/** Test seam. */
export function resetLlmHealth(): void {
  state = { healthy: true, consecutiveFailures: 0 };
}
