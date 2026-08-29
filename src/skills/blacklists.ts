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

/**
 * A Set seeded from disk — a live SINGLETON per name, so every module asking
 * for "badLava" shares one object and sees each other's additions. The copy
 * semantics bit once: the march retired a pool three times over while the
 * cast-time fetch, holding its own copy, kept electing the same unreachable
 * source five runs straight.
 */
const liveSets = new Map<string, Set<string>>();
export function persistentSet(name: string): Set<string> {
  let s = liveSets.get(name);
  if (!s) {
    const v = store[name];
    s = new Set(Array.isArray(v) ? (v as string[]) : []);
    liveSets.set(name, s);
  }
  return s;
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

/**
 * Every cell belonging to a REGISTERED portal frame, as "x,y,z" keys.
 *
 * Jesse's rule after the self-cannibalization incident: once a portal frame
 * exists, there is no reason to mine obsidian from it, ever. This is the
 * mechanical form of that rule — a registry-wide no-touch list that
 * mineObsidian consults, so protection covers every frame the swarm has
 * ever banked, current mission or otherwise, independent of which caller
 * forgot to pass an exclusion.
 */
export function protectedFrameCells(): Set<string> {
  const out = new Set<string>();
  const frames = persistentRecord<{ origin: { x: number; y: number; z: number }; axis: "x" | "z" }>("bankedFrames");
  for (const entry of Object.values(frames)) {
    if (!entry?.origin || !entry.axis) continue;
    for (const p of frameCellsOf(entry.origin, entry.axis)) out.add(`${p.x},${p.y},${p.z}`);
  }
  return out;
}

// Local copy of the 4x5 frame footprint (portal-geometry's framePositions),
// duplicated here to keep blacklists dependency-free at the bottom of the
// import graph. WIDTH=2, HEIGHT=3, cornerless — 10 cells plus floor/lintel.
function frameCellsOf(
  origin: { x: number; y: number; z: number },
  axis: "x" | "z",
): Array<{ x: number; y: number; z: number }> {
  const at = (w: number, h: number) =>
    axis === "x"
      ? { x: origin.x + w, y: origin.y + h, z: origin.z }
      : { x: origin.x, y: origin.y + h, z: origin.z + w };
  const cells: Array<{ x: number; y: number; z: number }> = [];
  for (let w = 0; w < 2; w++) {
    cells.push(at(w, -1)); // floor
    cells.push(at(w, 3)); // lintel
  }
  for (let h = 0; h < 3; h++) {
    cells.push(at(-1, h)); // left jamb
    cells.push(at(2, h)); // right jamb
  }
  return cells;
}
