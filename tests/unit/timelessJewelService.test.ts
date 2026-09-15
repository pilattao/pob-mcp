import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as loader from '../../src/services/pobTreeDataLoader.js';
import { legacyJewelTree } from '../fixtures/jewelRadiusFixture.js';
import {
  parseTimelessJewelMod,
  findAffectedNodes,
  type JewelSocketInfo,
} from "../../src/services/timelessJewelService";
let savedGame: string | undefined;
beforeEach(() => {
  savedGame = process.env.POE_GAME; process.env.POE_GAME = 'poe1';
  const tree = legacyJewelTree();
  tree.nodes['11730'] = { ...tree.nodes['6712'], skill: 11730, group: 1, name: 'Endurance fixture' };
  tree.nodes['50459'] = { ...tree.nodes['40'], skill: 50459, group: 3, name: 'Distant class start fixture', classesStart: ['Duelist'] };
  jest.spyOn(loader, 'getPobTreeData').mockReturnValue(tree);
});
afterEach(() => {
  jest.restoreAllMocks(); if (savedGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = savedGame;
});

describe("parseTimelessJewelMod", () => {
  it("parses a Lethal Pride / Kaom jewel", () => {
    const info = parseTimelessJewelMod("Lethal Pride", [
      "Commanded leadership over 10678 warriors under Kaom",
      "Passives in radius are Conquered by the Karui",
      "Historic",
    ]);
    expect(info).not.toBeNull();
    expect(info?.jewelType).toBe("Lethal Pride");
    expect(info?.seed).toBe(10678);
    expect(info?.historicCharacter).toBe("Kaom");
    expect(info?.radiusClass).toBe("large");
    expect(info?.radius).toBe(1500);
  });

  it("returns null for a non-Timeless jewel", () => {
    const info = parseTimelessJewelMod("Sol Essence", [
      "+10% to Global Critical Strike Multiplier",
      "3% increased Mana Reservation Efficiency of Skills",
    ]);
    expect(info).toBeNull();
  });

  it("parses Glorious Vanity correctly", () => {
    const info = parseTimelessJewelMod("Glorious Vanity", [
      "Bathed in the blood of 5482 sacrificed in the name of Doryani",
      "Passives in radius are Conquered by the Vaal",
      "Historic",
    ]);
    expect(info).not.toBeNull();
    expect(info?.jewelType).toBe("Glorious Vanity");
    expect(info?.seed).toBe(5482);
    expect(info?.historicCharacter).toBe("Doryani");
  });

  it("parses Militant Faith correctly", () => {
    const info = parseTimelessJewelMod("Militant Faith", [
      "Carved to glorify 7000 new faithful converted by High Templar Avarius",
      "Passives in radius are Conquered by the Templars",
      "Historic",
    ]);
    expect(info).not.toBeNull();
    expect(info?.jewelType).toBe("Militant Faith");
    expect(info?.seed).toBe(7000);
    expect(info?.historicCharacter).toBe("Avarius");
  });

  it("parses Elegant Hubris correctly", () => {
    const info = parseTimelessJewelMod("Elegant Hubris", [
      "Commissioned 9001 coins to commemorate Cadiro",
      "Passives in radius are Conquered by the Eternal Empire",
      "Historic",
    ]);
    expect(info).not.toBeNull();
    expect(info?.jewelType).toBe("Elegant Hubris");
    expect(info?.seed).toBe(9001);
    expect(info?.historicCharacter).toBe("Cadiro");
  });

  it("matches Timeless name when item display name has extra suffix", () => {
    // e.g., "Lethal Pride, Timeless Jewel" or "Lethal Pride (Timeless Jewel)"
    const info = parseTimelessJewelMod("Lethal Pride, Timeless Jewel", [
      "Commanded leadership over 10678 warriors under Kaom",
    ]);
    expect(info).not.toBeNull();
    expect(info?.jewelType).toBe("Lethal Pride");
  });

  it("returns null when the name matches but the mod text is missing the seed", () => {
    const info = parseTimelessJewelMod("Lethal Pride", [
      "Passives in radius are Conquered by the Karui",
      "Historic",
    ]);
    expect(info).toBeNull();
  });
});

describe("findAffectedNodes (deterministic PoE1 fixture)", () => {
  it("returns empty result when no Timeless Jewels are equipped", () => {
    const result = findAffectedNodes(
      [
        {
          socketNodeId: "26196",
          jewelName: "Sol Essence",
          mods: ["+10% to Global Critical Strike Multiplier"],
        },
      ],
      new Set(["476", "26196"])
    );
    expect(result.timelessJewels).toHaveLength(0);
    expect(Object.keys(result.byNode)).toHaveLength(0);
  });

  it("identifies a Lethal Pride and finds nodes in its radius", () => {
    const jewels: JewelSocketInfo[] = [
      {
        socketNodeId: "26196",
        jewelName: "Lethal Pride",
        mods: [
          "Commanded leadership over 10678 warriors under Kaom",
          "Passives in radius are Conquered by the Karui",
          "Historic",
        ],
      },
    ];
    // Pass a reasonable set of allocated nodes including some likely in radius
    const allocated = new Set(["11730", "34171", "60472", "26196"]);
    const result = findAffectedNodes(jewels, allocated);
    expect(result.timelessJewels).toHaveLength(1);
    const tj = result.timelessJewels[0];
    expect(tj.jewel.jewelType).toBe("Lethal Pride");
    expect(tj.jewel.historicCharacter).toBe("Kaom");
    // Endurance (11730) is in the same group as the socket — definitely in radius
    expect(tj.affectedAllocated).toContain("11730");
    expect(result.byNode["11730"]).toBeDefined();
    expect(result.byNode["11730"].affectingJewels[0].jewel.jewelType).toBe("Lethal Pride");
  });

  it("excludes nodes far outside the radius", () => {
    const jewels: JewelSocketInfo[] = [
      {
        socketNodeId: "26196",
        jewelName: "Lethal Pride",
        mods: ["Commanded leadership over 10678 warriors under Kaom"],
      },
    ];
    // A node from the Duelist start area should be far from socket 26196
    const allocated = new Set(["26196", "50459", "11730"]); // socket + distant start + nearby node
    const result = findAffectedNodes(jewels, allocated);
    const tj = result.timelessJewels[0];
    expect(tj.affectedAllocated).toContain("11730");
    expect(tj.affectedAllocated).not.toContain("50459");
  });
});
