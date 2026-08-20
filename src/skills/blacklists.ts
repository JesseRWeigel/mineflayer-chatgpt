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

type Store = Record<string, string[]>;

function load(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const store: Store = load();

/** A Set seeded from disk. Pair with persistBlacklist() after every add. */
export function persistentSet(name: string): Set<string> {
  return new Set(store[name] ?? []);
}

export function persistBlacklist(name: string, s: Set<string>): void {
  store[name] = [...s];
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch {
    /* best effort — the in-memory set still protects this process */
  }
}
