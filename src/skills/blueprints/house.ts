import type { Blueprint, BlueprintBlock } from "../types.js";

/**
 * 7x7 oak plank house with door opening, interior furnishings.
 *
 * Top-down view (Y=1 wall level):
 *
 *   Z=6  W W W W W W W     (north wall)
 *   Z=5  W . . . . . W
 *   Z=4  W . . . . . W
 *   Z=3  W . T . . . W     T = crafting table
 *   Z=2  W . . . . . W
 *   Z=1  W . . . . . W
 *   Z=0  W W D D W W W     D = double doors
 *        0 1 2 3 4 5 6      X axis
 *
 * Y=0: floor | Y=1-3: walls | Y=4: roof
 * Doors: X=2,3 at Z=0, Y=1-2 (placed at Y=1, top half auto-generated)
 */
function generate(): Blueprint {
  const blocks: BlueprintBlock[] = [];

  // Floor (Y=0)
  for (let x = 0; x <= 6; x++) {
    for (let z = 0; z <= 6; z++) {
      blocks.push({ pos: [x, 0, z], block: "oak_planks", phase: "structure" });
    }
  }

  // Walls (Y=1 to Y=3)
  for (let y = 1; y <= 3; y++) {
    for (let x = 0; x <= 6; x++) {
      for (let z = 0; z <= 6; z++) {
        const isPerimeter = x === 0 || x === 6 || z === 0 || z === 6;
        if (!isPerimeter) continue;

        // Door opening: X=2,3 at Z=0, Y=1 and Y=2
        if (z === 0 && (x === 2 || x === 3) && (y === 1 || y === 2)) continue;

        blocks.push({ pos: [x, y, z], block: "oak_planks", phase: "structure" });
      }
    }
  }

  // Roof (Y=4)
  for (let x = 0; x <= 6; x++) {
    for (let z = 0; z <= 6; z++) {
      blocks.push({ pos: [x, 4, z], block: "oak_planks", phase: "structure" });
    }
  }

  // Interior: crafting table
  blocks.push({ pos: [2, 1, 3], block: "crafting_table", phase: "interior" });

  // Interior: double doors at the entrance (bottom half only — top auto-generates in Minecraft)
  blocks.push({ pos: [2, 1, 0], block: "oak_door", phase: "interior" });
  blocks.push({ pos: [3, 1, 0], block: "oak_door", phase: "interior" });

  // Interior: torches on walls at Y=3
  blocks.push({ pos: [3, 3, 5], block: "torch", phase: "interior" }); // north wall
  blocks.push({ pos: [1, 3, 1], block: "torch", phase: "interior" }); // SW corner
  blocks.push({ pos: [5, 3, 1], block: "torch", phase: "interior" }); // SE corner
  blocks.push({ pos: [5, 3, 4], block: "torch", phase: "interior" }); // east wall
  blocks.push({ pos: [1, 3, 4], block: "torch", phase: "interior" }); // west wall

  // Compute materials
  const materials: Record<string, number> = {};
  for (const b of blocks) {
    materials[b.block] = (materials[b.block] || 0) + 1;
  }

  return {
    name: "Oak House",
    dimensions: [7, 5, 7],
    blocks,
    entrance: { pos: [2, 1, -1], facing: "south" },
    materials,
  };
}

export const houseBlueprint = generate();
