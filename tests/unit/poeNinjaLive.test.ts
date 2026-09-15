import { PoeNinjaClient, type EconomyOverview } from '../../src/services/poeNinjaClient';

// Opt-in, exact league required. Three public category GETs plus league validation;
// only conditional revalidation where the provider requests it. No accounts or orders.
const live = process.env.POE2_NINJA_LIVE === '1' ? describe : describe.skip;
live('public PoE2 economy primary-source contract', () => {
  const client = new PoeNinjaClient({ game: 'poe2' });
  const league = process.env.POE2_NINJA_LIVE_LEAGUE;
  const datasets: EconomyOverview[] = [];
  beforeAll(async () => {
    if (!league) throw new Error('Set POE2_NINJA_LIVE_LEAGUE to the exact public league id');
    for (const category of ['Currency', 'Fragments', 'UniqueAccessories']) {
      datasets.push(await client.getEconomyOverview(league, category));
    }
  }, 60000);

  it.each([0, 1, 2])('normalizes public dataset %s with its own rates and provenance', index => {
    const data = datasets[index];
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.provenance).toMatchObject({ game: 'poe2', league, sourceAgeSeconds: null });
    expect(data.provenance.source).toContain('/poe2/api/economy/');
    expect(data.quoteEvidence).toBe('missing-directional-quotes');
    for (const row of data.rows) {
      expect(Number.isFinite(row.primaryValue)).toBe(true);
      expect(row.values[data.primaryCurrency]).toBe(row.primaryValue);
      if (data.rates.chaos) expect(row.values.chaos).toBeCloseTo(row.primaryValue * data.rates.chaos, 8);
    }
    console.info('PoE2 economy evidence:', JSON.stringify({ ...data.provenance,
      primaryCurrency: data.primaryCurrency, rates: data.rates, rows: data.rows.length,
      first: { name: data.rows[0].name, primaryValue: data.rows[0].primaryValue, values: data.rows[0].values } }));
  });

  it('prices a real unique through the public lookup interface with explicit variant filters', async () => {
    const sample = datasets[2].rows[0];
    const lookup = await client.getItemPrice(league!, sample.name, {
      category: 'UniqueAccessories', detailsId: sample.detailsId, corrupted: sample.corrupted,
    });
    expect(lookup.status).toBe('priced');
    expect(lookup.price?.name).toBe(sample.name);
    expect(lookup.price?.chaosValue).toBeGreaterThan(0);
    expect(lookup.price?.sourceKind).toBe('stash-estimate');
    expect(lookup.price?.provenance.source).toContain('type=UniqueAccessories');
    expect(lookup.price?.provenance.sourceAgeSeconds).toBeNull();
  });
});
