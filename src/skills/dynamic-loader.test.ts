import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("dynamic-loader: loads a JS skill into the registry", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testEcho.js");
  fs.writeFileSync(skillPath, `async function testEcho(bot) { bot.__testResult = "echo"; }`);

  loadDynamicSkills();

  assert.ok(skillRegistry.has("testEcho"), "testEcho should be in registry");
  assert.equal(skillRegistry.get("testEcho")!.name, "testEcho");

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testEcho");
});

test("dynamic-loader: skill executes in sandboxed context", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testMock.js");
  fs.writeFileSync(skillPath, `async function testMock(bot) { bot.__ran = true; }`);

  loadDynamicSkills();

  const skill = skillRegistry.get("testMock")!;
  const mockBot = { __ran: false } as any;
  const result = await skill.execute(mockBot, {}, new AbortController().signal, () => {});

  assert.ok(mockBot.__ran, "skill should have set __ran on bot");
  assert.ok(result.success);

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testMock");
});
