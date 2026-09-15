import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as loader from '../../src/services/pobTreeDataLoader.js';
import { legacyJewelTree } from '../fixtures/jewelRadiusFixture.js';

let savedGame: string | undefined;
beforeEach(() => { savedGame = process.env.POE_GAME; process.env.POE_GAME = 'poe1'; jest.spyOn(loader, 'getPobTreeData').mockReturnValue(legacyJewelTree()); });
afterEach(() => { jest.restoreAllMocks(); if (savedGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = savedGame; });
import {
  isRadiusEffectMod,
  categorizeRadiusMod,
  findRadiusEffectJewels,
} from "../../src/services/radiusEffectJewelService";

describe("isRadiusEffectMod", () => {
  it("matches Energy From Within style transform mods", () => {
    expect(
      isRadiusEffectMod(
        "Increases and Reductions to Life in Radius are Transformed to apply to Energy Shield"
      )
    ).toBe(true);
  });

  it("matches multiplier mods like Might of the Meek", () => {
    expect(
      isRadiusEffectMod("50% increased Effect of non-Keystone Passive Skills in Radius")
    ).toBe(true);
  });

  it("matches 'Notable Passive Skills in Radius grant nothing'", () => {
    expect(isRadiusEffectMod("Notable Passive Skills in Radius grant nothing")).toBe(true);
  });

  it("excludes Timeless Jewel signature mods", () => {
    expect(
      isRadiusEffectMod("Commanded leadership over 10678 warriors under Kaom")
    ).toBe(false);
    expect(
      isRadiusEffectMod("Passives in radius are Conquered by the Karui")
    ).toBe(false);
    expect(
      isRadiusEffectMod("Denoted service of 23456 dekhara in the akhara of Asenath")
    ).toBe(false);
  });

  it("excludes attribute threshold mods", () => {
    expect(
      isRadiusEffectMod(
        "With at least 40 Strength in Radius, 1% increased Strength per 10 Strength on Allocated Passives"
      )
    ).toBe(false);
    expect(
      isRadiusEffectMod("With 40 Intelligence in Radius, 20% increased Effect of Auras")
    ).toBe(false);
  });

  it("excludes mods without 'in radius'", () => {
    expect(isRadiusEffectMod("+50 to maximum Life")).toBe(false);
    expect(isRadiusEffectMod("20% increased Damage")).toBe(false);
  });

  it("strips PoB mod-source prefixes like {crafted}", () => {
    expect(
      isRadiusEffectMod(
        "{crafted}50% increased Effect of non-Keystone Passive Skills in Radius"
      )
    ).toBe(true);
  });

  it("strips trailing [fractured] tags", () => {
    expect(
      isRadiusEffectMod("Notable Passive Skills in Radius grant nothing [fractured]")
    ).toBe(true);
  });
});

describe("categorizeRadiusMod", () => {
  it("labels transform mods", () => {
    expect(
      categorizeRadiusMod(
        "Increases and Reductions to Life in Radius are Transformed to apply to Energy Shield"
      )
    ).toBe("transform");
  });

  it("labels grant mods", () => {
    expect(categorizeRadiusMod("Notable Passive Skills in Radius grant nothing")).toBe(
      "grant"
    );
  });

  it("labels multiplier mods", () => {
    expect(
      categorizeRadiusMod("50% increased Effect of non-Keystone Passive Skills in Radius")
    ).toBe("multiplier");
    expect(
      categorizeRadiusMod("Doubles small Strength bonuses to Maximum Life in Radius")
    ).toBe("multiplier");
  });

  it("falls back to 'other' for unknown patterns", () => {
    expect(categorizeRadiusMod("Something weird in Radius")).toBe("other");
  });
});

describe("findRadiusEffectJewels (deterministic PoE1 fixture)", () => {
  it("returns empty result when no jewels have qualifying mods", () => {
    const jewels = [
      {
        socketNodeId: "26196",
        jewelName: "Plain Crimson Jewel",
        mods: ["+10 to Strength", "20% increased Critical Strike Multiplier"],
      },
    ];
    const allocated = new Set<string>(["26196"]);
    const r = findRadiusEffectJewels(jewels, allocated);
    expect(r.jewelsScanned).toBe(1);
    expect(r.jewelsWithRadiusEffects).toBe(0);
    expect(r.jewels).toHaveLength(0);
  });

  it("does NOT pick up Timeless Jewel signature mods", () => {
    const jewels = [
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
    const r = findRadiusEffectJewels(jewels, new Set());
    expect(r.jewelsWithRadiusEffects).toBe(0);
  });

  it("identifies Energy-From-Within-style transform mods", () => {
    // The fixture puts the Life node exactly 1000 units from this socket.
    const jewels = [
      {
        socketNodeId: "26196",
        jewelName: "Energy From Within",
        mods: [
          "Increases and Reductions to Life in Radius are Transformed to apply to Energy Shield",
        ],
        radius: 1500,
      },
    ];
    const allocated = new Set<string>(["6712"]);
    const r = findRadiusEffectJewels(jewels, allocated);
    expect(r.jewelsWithRadiusEffects).toBe(1);
    expect(r.jewels[0].radiusMods).toHaveLength(1);
    expect(r.jewels[0].radiusMods[0].category).toBe("transform");
    expect(r.jewels[0].affectedAllocated).toContain("6712");
  });

  it("does NOT mistake attribute-threshold mods for generic radius effects", () => {
    const jewels = [
      {
        socketNodeId: "26196",
        jewelName: "Synthetic attribute-threshold jewel",
        mods: [
          "With at least 40 Strength in Radius, 1% increased Strength per 10 Strength on Allocated Passives in Radius",
        ],
      },
    ];
    const r = findRadiusEffectJewels(jewels, new Set());
    expect(r.jewelsWithRadiusEffects).toBe(0);
  });
});
