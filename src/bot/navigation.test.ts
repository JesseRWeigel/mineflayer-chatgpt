import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

// Regression guard. mineflayer-pathfinder defaults to maxDropDown=4, which is
// one block into fall-damage range, and allowParkour=true. Fall damage was the
// top death cause for weeks because only 2 of 22 construction sites capped it.
// Atlas took 19 of 22 deaths this way in a single 5h session.
//
// baseMoves() in navigation.ts is the one place allowed to call the raw
// constructor. Everything else must derive from it so fall safety cannot be
// forgotten at a new call site.
test("no module constructs Movements outside navigation.ts", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    if (file.endsWith(path.join("bot", "navigation.ts"))) continue;
    if (file.endsWith(".test.ts")) continue;

    const source = fs.readFileSync(file, "utf8");
    source.split("\n").forEach((line, i) => {
      if (line.includes("new Movements(")) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these sites bypass baseMoves() and get maxDropDown=4 plus parkour:\n  ${offenders.join("\n  ")}`,
  );
});

test("navigation.ts constructs Movements exactly once, inside baseMoves", () => {
  const source = fs.readFileSync(path.join(SRC, "bot", "navigation.ts"), "utf8");
  const constructions = source.match(/new Movements\(/g) ?? [];

  assert.equal(constructions.length, 1, "baseMoves should be the only constructor call");
  // The single construction must be inside baseMoves and must cap the drop.
  const baseMovesBody = source.slice(source.indexOf("export function baseMoves"));
  assert.match(baseMovesBody.slice(0, 400), /new Movements\(/);
  assert.match(baseMovesBody.slice(0, 400), /maxDropDown\s*=\s*3/);
  assert.match(baseMovesBody.slice(0, 400), /allowParkour\s*=\s*false/);
});

test("safeMoves and explorerMoves derive from baseMoves", () => {
  const source = fs.readFileSync(path.join(SRC, "bot", "navigation.ts"), "utf8");

  for (const fn of ["safeMoves", "explorerMoves"]) {
    const body = source.slice(source.indexOf(`export function ${fn}`));
    assert.match(body.slice(0, 300), /baseMoves\(bot\)/, `${fn} should build on baseMoves`);
  }
});
