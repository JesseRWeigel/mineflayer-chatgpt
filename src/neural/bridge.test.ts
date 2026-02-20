import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

function startMockServer(port: number, response: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      conn.once("data", () => { conn.write(response + "\n"); conn.end(); });
    });
    server.listen(port, () => resolve(server));
  });
}

test("buildObservation: formats bot state into structured obs", async () => {
  const { buildObservation } = await import("./bridge.js");
  const mockBot = {
    health: 18, food: 16,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 }, yaw: 0 },
    inventory: { items: () => [{ name: "iron_sword" }, { name: "shield" }] },
    entities: {},
  } as any;

  const obs = buildObservation(mockBot);
  assert.equal(obs.bot_health, 18);
  assert.equal(obs.has_sword, true);
  assert.equal(obs.has_shield, true);
  assert.equal(obs.nearest_hostile, null);
});

test("queryNeural: sends obs and parses action response", async () => {
  const TEST_PORT = 19998;
  const server = await startMockServer(TEST_PORT, JSON.stringify({ action: "attack", confidence: 0.95 }));
  try {
    const { queryNeural } = await import("./bridge.js");
    const mockObs = {
      bot_health: 18, bot_food: 16, bot_pos: [0,64,0] as [number,number,number],
      nearest_hostile: null, all_entities: [],
      has_sword: true, has_shield: false, has_bow: false,
    };
    const result = await queryNeural(mockObs, TEST_PORT);
    assert.equal(result.action, "attack");
    assert.equal(result.confidence, 0.95);
  } finally {
    server.close();
  }
});
