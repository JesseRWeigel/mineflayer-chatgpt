// Persistent position blacklists.
//
// badOres, badLava and badScoops were per-process Sets, and the maintenance
// loop restarts the process every hour — so every lesson the ratchets learned
// was erased on the next deploy. The andesite-cursed source cell at
// (280,39,-222) was "now blacklisted" afresh every single run for four days,
// and the rimless pool at (317,-23,-321) collected its three strikes over and
// over. Knowledge this expensive to earn belongs on disk.
//
// The file lives in logs/ (never staged) and is best-effort on both ends: a
// missing or corrupt file just means starting fresh, and a failed write means
// the process keeps its in-memory set. Delete the file to reset the ratchets
// after large world changes.

import fs from "fs";
import path from "path";

const FILE = path.join("logs", "blacklists.json");

type Store = Record<string, unknown>;

function load(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const store: Store = load();

function save(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch {
    /* best effort — the in-memory state still protects this process */
  }
}

/** A Set seeded from disk. Pair with persistBlacklist() after every add. */
export function persistentSet(name: string): Set<string> {
  const v = store[name];
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

export function persistBlacklist(name: string, s: Set<string>): void {
  store[name] = [...s];
  save();
}

/**
 * A keyed record seeded from disk — same contract as persistentSet, for
 * structured values. Added when a restart stranded Atlas's first-ever banked
 * obsidian: the 1/10 frame's location lived in a per-process Map, so the
 * block stayed in the world while every memory of it died with the deploy.
 */
export function persistentRecord<T>(name: string): Record<string, T> {
  const v = store[name];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as Record<string, T>) } : {};
}

export function persistRecord(name: string, value: Record<string, unknown>): void {
  store[name] = value;
  save();
}
