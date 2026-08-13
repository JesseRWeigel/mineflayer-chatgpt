// tools/extract-advancements.ts
//
// The advancement tree is the curriculum. It is extracted at build time rather
// than read at runtime because the runtime has no business unzipping a 18MB jar
// on every decision, and because a checked-in file makes the tree diffable when
// the server version changes.
//
// Usage: npx tsx tools/extract-advancements.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NESTED = "META-INF/versions/1.21.4/server-1.21.4.jar";
const OUTER = path.resolve("server/cache/mojang_1.21.4.jar");
const TMP = path.resolve(".advancement-extract");

/** Shape of one row in the generated file. The runtime re-declares this in
 *  src/bot/advancement-tree.ts; this copy documents the tool's output and is
 *  deliberately local, since a build script exports nothing. */
interface AdvancementNode {
  id: string;
  parent: string | null;
  title: string;
  description: string;
  category: string;
}

function bare(id: string): string {
  return id.replace(/^minecraft:/, "");
}

function main(): void {
  mkdirSync(TMP, { recursive: true });
  execFileSync("unzip", ["-o", "-q", OUTER, NESTED, "-d", TMP]);
  const inner = path.join(TMP, NESTED);

  const listing = execFileSync("unzip", ["-Z1", inner], { encoding: "utf-8" });
  const paths = listing
    .split("\n")
    .filter((p) => p.startsWith("data/minecraft/advancement/") && p.endsWith(".json"))
    .filter((p) => !p.includes("/recipes/"));

  const lang = JSON.parse(
    execFileSync("unzip", ["-p", inner, "assets/minecraft/lang/en_us.json"], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Record<string, string>;

  const nodes: AdvancementNode[] = paths.map((p) => {
    const raw = JSON.parse(execFileSync("unzip", ["-p", inner, p], { encoding: "utf-8" }));
    const id = p.replace("data/minecraft/advancement/", "").replace(/\.json$/, "");
    const display = raw.display ?? {};
    return {
      id,
      parent: raw.parent ? bare(raw.parent) : null,
      title: lang[display.title?.translate] ?? id,
      description: lang[display.description?.translate] ?? "",
      category: id.split("/")[0],
    };
  });

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(path.resolve("src/data"), { recursive: true });
  writeFileSync(path.resolve("src/data/advancement-tree.json"), JSON.stringify(nodes, null, 2) + "\n");
  console.log(`Wrote ${nodes.length} advancements to src/data/advancement-tree.json`);
}

main();
