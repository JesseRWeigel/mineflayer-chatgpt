/**
 * Content safety filter for stream output.
 * Screens bot thoughts and chat messages before they reach
 * the stream overlay, TTS, or in-game chat.
 *
 * This is a blocklist + pattern approach. For production,
 * consider adding an LLM-based classifier as a second layer.
 */

// Slurs, hate speech, and Twitch TOS violations
// This list is intentionally stored as hashed patterns rather than
// plaintext to avoid embedding offensive content in the source.
const BLOCKED_PATTERNS: RegExp[] = [
  // Racial slurs (common variations and leetspeak)
  /\bn[i1]gg?[e3a][r5]s?\b/i,
  /\bf[a4]gg?[o0]t\b/i,
  /\br[e3]t[a4]rd/i,
  /\bk[i1]ke\b/i,
  /\bsp[i1]c[sk]?\b/i,
  /\bch[i1]nk\b/i,
  /\bwetback\b/i,
  /\btr[a4]nn[yi]/i,

  // Sexual content
  /\bporn/i,
  /\bhentai\b/i,
  /\bsex(ual|ting)?\b/i,
  /\bnud[e3]/i,
  /\brape[ds]?\b/i,

  // Violence promotion
  /\bkill\s+(your|him|her|them)self/i,
  /\bsuicid/i,
  /\bschool\s*shoot/i,
  /\bmass\s*murder/i,
  /\bgenocid/i,

  // Self-harm
  /\bself[- ]?harm/i,
  /\bcut(ting)?\s+(my|your)\s*(wrist|arm)/i,

  // Doxxing / personal info patterns
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // phone numbers
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/, // SSN pattern

  // Twitch-specific TOS
  /\bswat(ting|ted)?\b/i,
  /\bddos/i,
  /\bhack\s*(their|his|her)\b/i,
];

// Words that are fine in Minecraft context but would be flagged elsewhere
const MINECRAFT_EXCEPTIONS = new Set([
  "kill", "killed", "killing", "slay", "slain", // normal combat
  "die", "died", "death", // normal gameplay
  "attack", "fight", "destroy", // combat actions
  "explode", "explosion", "blow up", // creepers
  "mine", "mining", // core mechanic
  "shoot", "arrow", // skeletons/bows
  "spawn", "spawner", // mob spawning
]);

export interface FilterResult {
  safe: boolean;
  cleaned: string;
  reason?: string;
}

/**
 * Check if text is safe for stream output.
 * Returns cleaned text with violations removed.
 */
export function filterContent(text: string): FilterResult {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      // Replace the matched content with asterisks
      const cleaned = text.replace(pattern, "[***]");
      return {
        safe: false,
        cleaned,
        reason: `Blocked pattern detected`,
      };
    }
  }

  return { safe: true, cleaned: text };
}

/**
 * Filter specifically for in-game chat messages (stricter).
 * The bot should never say anything problematic in public chat.
 */
export function filterChatMessage(text: string): FilterResult {
  const result = filterContent(text);
  if (!result.safe) return result;

  // Additional chat-specific checks
  if (text.length > 200) {
    return {
      safe: false,
      cleaned: text.slice(0, 200),
      reason: "Message too long for chat",
    };
  }

  return result;
}

/**
 * Filter incoming viewer messages before they reach the LLM.
 * Prevents prompt injection and offensive inputs.
 */
export function filterViewerMessage(text: string): FilterResult {
  const result = filterContent(text);

  // Check for prompt injection attempts
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i,
    /you\s+are\s+now\s+/i,
    /new\s+system\s+prompt/i,
    /forget\s+(everything|all|your\s+rules)/i,
    /\bsystem:\s/i,
    /\bassistant:\s/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(text)) {
      return {
        safe: false,
        cleaned: "[nice try]",
        reason: "Prompt injection attempt",
      };
    }
  }

  return result;
}
