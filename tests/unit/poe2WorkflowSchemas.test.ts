import { describe, expect, it } from '@jest/globals';
import { getSkillGemToolSchemas, getTradeToolSchemas, getPoeNinjaToolSchemas } from '../../src/server/toolSchemas.js';

describe('PoE2 workflow discovery contracts', () => {
  it('allows native comparisons of gem levels and stat sets without requiring a saved file', () => {
    const schema = getSkillGemToolSchemas().find(t => t.name === 'compare_gem_setups').inputSchema;
    expect(schema.required).not.toContain('build_name');
    expect(schema.properties.metric.enum).toContain('CombinedDPS');
    expect(schema.properties.evaluation_skill_index.minimum).toBe(0);
    const gem = schema.properties.setups.items.properties.gems.items.anyOf.find((s: any) => s.type === 'object');
    expect(gem.properties.level.minimum).toBe(1);
    expect(gem.properties.statSet).toBeDefined();
    expect(gem.properties.refIndex.minimum).toBe(1);
  });
  it('exposes item constraints and explicit denomination on the routed shopping workflow', () => {
    const schema = getTradeToolSchemas().find(t => t.name === 'generate_shopping_list').inputSchema;
    expect(schema.properties.currency.type).toBe('string');
    expect(schema.properties.item_requirements.additionalProperties.properties.minSpirit.minimum).toBe(0);
    expect(schema.properties.item_requirements.additionalProperties.properties.itemCategory.type).toBe('string');
    expect(schema.properties.max_searches.minimum).toBe(0);
  });
  it('does not advertise aggregate valuations as executable arbitrage quotes', () => {
    const desc = getPoeNinjaToolSchemas().find(t => t.name === 'find_arbitrage').description;
    expect(desc).not.toMatch(/passive income|real-time poe.ninja rates to identify market inefficiencies/);
    expect(desc).toMatch(/directional/i);
  });
});
