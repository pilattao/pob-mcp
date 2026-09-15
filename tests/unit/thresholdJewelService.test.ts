import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as loader from '../../src/services/pobTreeDataLoader.js';
import { legacyJewelTree } from '../fixtures/jewelRadiusFixture.js';

let savedGame: string | undefined;
beforeEach(() => { savedGame = process.env.POE_GAME; process.env.POE_GAME = 'poe1'; jest.spyOn(loader, 'getPobTreeData').mockReturnValue(legacyJewelTree()); });
afterEach(() => { jest.restoreAllMocks(); if (savedGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = savedGame; });
import {
  parseThresholdMods,
  evaluateThreshold,
  evaluateBuildThresholds,
  type ThresholdMod,
} from "../../src/services/thresholdJewelService";

describe("parseThresholdMods", () => {
  it("parses 'With at least N Strength in Radius' patterns", () => {
    const mods = [
      "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength",
      "+10 to maximum Life",
    ];
    const r = parseThresholdMods(mods);
    expect(r).toHaveLength(1);
    expect(r[0].attribute).toBe("Strength");
    expect(r[0].requiredAmount).toBe(40);
  });

  it("parses Dexterity and Intelligence thresholds", () => {
    const r = parseThresholdMods([
      "With at least 40 Dexterity in Radius, 1% chance to Dodge",
      "With at least 40 Intelligence in Radius, 20% increased Effect of Auras",
    ]);
    expect(r).toHaveLength(2);
    expect(r.map((t) => t.attribute).sort()).toEqual(["Dexterity", "Intelligence"]);
  });

  it("handles the shorter 'With N <Attr> in Radius' wording", () => {
    const r = parseThresholdMods([
      "With 40 Intelligence in Radius, 20% increased Effect of Auras",
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].requiredAmount).toBe(40);
  });

  it("strips {crafted} / [fractured] mod-source annotations", () => {
    const r = parseThresholdMods([
      "{crafted}With at least 40 Strength in Radius, X% increased Y [crafted]",
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].rawMod).not.toContain("{crafted}");
    expect(r[0].rawMod).not.toContain("[crafted]");
  });

  it("returns empty for jewels with no threshold mods", () => {
    expect(
      parseThresholdMods([
        "+105 to maximum Life",
        "+30% to Fire Resistance",
        "5% increased Movement Speed",
      ])
    ).toEqual([]);
  });
});

describe("evaluateThreshold (deterministic PoE1 fixture)", () => {
  const threshold: ThresholdMod = {
    attribute: "Strength",
    requiredAmount: 40,
    rawMod: "With at least 40 Strength in Radius, X",
  };

  it("returns triggered=false when no attribute is present in radius", () => {
    const r = evaluateThreshold(threshold, "7162", new Set<string>());
    expect(r.triggered).toBe(false);
    expect(r.attributeInRadius).toBe(0);
    expect(r.margin).toBe(-40);
  });

  it("uses the override radius when provided", () => {
    const r = evaluateThreshold(threshold, "7162", new Set<string>(), 100);
    expect(r.radius).toBe(100);
  });

  it('counts unallocated attributes for legacy With-at-least thresholds', () => {
    const tree = legacyJewelTree();
    tree.nodes['40'].stats = ['+40 to Strength'];
    jest.spyOn(loader, 'getPobTreeData').mockReturnValue(tree);
    const result = evaluateThreshold(threshold, '7162', new Set());
    expect(result.attributeInRadius).toBe(40);
    expect(result.triggered).toBe(true);
  });

  it('uses base all-attribute and dual-attribute bonuses but not conditional or increased bonuses', () => {
    const tree = legacyJewelTree();
    tree.nodes['40'].stats = ['+10 to all Attributes', '+15 to Strength and Dexterity', '-5 to Strength', '20% increased Strength', '+99 to Strength while on Full Life'];
    jest.spyOn(loader, 'getPobTreeData').mockReturnValue(tree);
    expect(evaluateThreshold(threshold, '7162', new Set()).attributeInRadius).toBe(20);
  });

  it('reads a legacy item Radius header instead of assuming every threshold has Small radius', () => {
    const tree = legacyJewelTree(); tree.nodes['6712'].stats = ['+40 to Strength'];
    jest.spyOn(loader, 'getPobTreeData').mockReturnValue(tree);
    const result = evaluateBuildThresholds([{ socketNodeId: '26196', jewelName: 'Divine Inferno', mods: ['Radius: Medium', 'With at least 40 Strength in Radius, Combust is Disabled'] }], new Set());
    expect(result.evaluations[0].radius).toBe(1200);
    expect(result.evaluations[0].triggered).toHaveLength(1);
  });
});

describe("evaluateBuildThresholds (integration)", () => {
  it("skips jewels with no threshold mods and reports the rest", () => {
    const result = evaluateBuildThresholds(
      [
        {
          socketNodeId: "26196",
          jewelName: "Lethal Pride",
          mods: [
            "Commanded leadership over 10678 warriors under Kaom",
            "Passives in radius are Conquered by the Karui",
            "Historic",
          ],
        },
        {
          socketNodeId: "7162",
          jewelName: "Synthetic attribute-threshold jewel",
          mods: [
            "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength",
            "Implicit: +5 to all Attributes",
          ],
        },
        {
          socketNodeId: "9408",
          jewelName: "Generic Crimson Jewel",
          mods: [
            "+10% to Critical Strike Multiplier with Two Handed Melee Weapons",
            "Gain 3 Life per Enemy Hit with Attacks",
          ],
        },
      ],
      new Set<string>()
    );
    expect(result.jewelsScanned).toBe(3);
    expect(result.jewelsWithThresholds).toBe(1);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].jewelName).toBe("Synthetic attribute-threshold jewel");
    // No attribute nodes in this fixture's radius → not triggered.
    expect(result.evaluations[0].notTriggered).toHaveLength(1);
    expect(result.evaluations[0].triggered).toHaveLength(0);
  });
});
