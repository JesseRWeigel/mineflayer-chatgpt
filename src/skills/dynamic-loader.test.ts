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

// THE BUG THIS TEST EXISTS FOR.
//
// runDynamicSkill raced the skill against a 120s watchdog:
//
//   const timeoutPromise = new Promise((_, reject) =>
//     setTimeout(() => reject(...), 120_000));
//   await Promise.race([vmPromise, timeoutPromise]);
//
// and never cleared the timer when the skill won. The timer then held the event
// loop open for the remaining two minutes and eventually rejected a promise
// nobody was listening to.
//
// Measured 2026-08-15: this one test FILE took 128 seconds while its two tests
// took 180ms between them. It was the entire test suite's runtime -- and once
// --test-force-exit was removed (it had been silently discarding tests), that
// cost became visible on every run. In production every dynamic skill
// invocation left one of these behind.

test("dynamic-loader: a finished skill leaves no watchdog timer behind", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testQuick.js");
  fs.writeFileSync(skillPath, `async function testQuick(bot) { bot.__quick = true; }`);
  loadDynamicSkills();

  const before = (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;
  await skillRegistry.get("testQuick")!.execute({} as any, {}, new AbortController().signal, () => {});
  const after = (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;

  assert.ok(
    after <= before,
    `skill execution leaked ${after - before} timer(s); the 120s watchdog must be cleared when the skill wins the race`,
  );

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testQuick");
});
