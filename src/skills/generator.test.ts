import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("saveGeneratedSkill: writes JS to skills/generated/", async () => {
  const { saveGeneratedSkill } = await import("./generator.js");
  const code = `async function myTestSkill(bot) { bot.__done = true; }`;
  const name = await saveGeneratedSkill("myTestSkill", code);

  assert.equal(name, "myTestSkill");
  const dest = path.join(__dirname, "../../skills/generated/myTestSkill.js");
  assert.ok(fs.existsSync(dest));
  assert.equal(fs.readFileSync(dest, "utf-8"), code);

  fs.unlinkSync(dest);
});
