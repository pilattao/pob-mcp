import { PoeNinjaClient } from '../../src/services/poeNinjaClient';
import { handleGetCurrencyRates, handleFindArbitrage, handleCalculateTradingProfit } from '../../src/handlers/poeNinjaHandlers';
import { exchangeFixture, jsonResponse } from './poeNinjaFixtures';

const league = 'Forbidden Rites';
let context: { ninjaClient: PoeNinjaClient };
beforeEach(() => {
  context = { ninjaClient: new PoeNinjaClient({ game: 'poe2' }) };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    jsonResponse(String(url).endsWith('/leagues') ? [{ id: league }] : exchangeFixture()));
});
afterEach(() => jest.restoreAllMocks());

it('labels game, league, units and unknown source age without presentation instructions', async () => {
  const text = (await handleGetCurrencyRates(context, { league })).content[0].text;
  expect(text).toMatch(/Game: poe2/);
  expect(text).toContain(league);
  expect(text).toMatch(/Primary currency: divine/);
  expect(text).toMatch(/source.*age.*unknown/i);
  expect(text).toMatch(/reference valuation/i);
  expect(text).not.toMatch(/verbatim|show.*ALL|Last Updated|real.time/i);
});

it('requires bulk quotes instead of deriving arbitrage from aggregate valuations', async () => {
  await expect(handleFindArbitrage(context, { league, min_profit_percent: 0 })).rejects.toThrow(/bulk exchange.*not configured/i);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('labels a reference round trip as a valuation calculation, not executable profit', async () => {
  const text = (await handleCalculateTradingProfit(context, { league,
    currency_chain: ['Divine Orb', 'Chaos Orb', 'Divine Orb'], start_amount: 2 })).content[0].text;
  expect(text).toContain('Result: 2.0000 Divine Orb');
  expect(text).toMatch(/reference valuation/i);
  expect(text).toMatch(/costs.*not supplied/i);
  expect(text).not.toMatch(/Profitable arbitrage|Break-even trade|verbatim/i);
});

it('calculates supplied directional rates and destination-currency costs with explicit assumptions', async () => {
  const text = (await handleCalculateTradingProfit(context, { league,
    currency_chain: ['Divine Orb', 'Chaos Orb', 'Divine Orb'], start_amount: 2,
    user_rates: [12, 0.1], step_costs: [1, 0.05] })).content[0].text;
  expect(text).toContain('Result: 2.2500 Divine Orb');
  expect(text).toMatch(/user.supplied.*rate/i);
  expect(text).toMatch(/1\.0000 Chaos Orb/);
  expect(text).toMatch(/0\.0500 Divine Orb/);
  expect(text).toMatch(/12\.50%/);
  expect(text).toMatch(/No trades.*executed/i);
});

it('does not report a final result after an unknown intermediate currency', async () => {
  await expect(handleCalculateTradingProfit(context, { league,
    currency_chain: ['Divine Orb', 'Missing Orb', 'Divine Orb'] })).rejects.toThrow(/Missing Orb/);
});

it.each([0, -1, NaN, Infinity])('rejects invalid starting amount %s', async start_amount => {
  await expect(handleCalculateTradingProfit(context, { league,
    currency_chain: ['Divine Orb', 'Chaos Orb'], start_amount })).rejects.toThrow(/amount/i);
});

it.each([
  { user_rates: [0] }, { user_rates: [-1] }, { user_rates: [Infinity] },
  { user_rates: [12, 0.1] }, { step_costs: [-1] }, { step_costs: [Infinity] },
  { step_costs: [100] },
])('rejects invalid or unaffordable rates/costs: %j', async extra => {
  await expect(handleCalculateTradingProfit(context, { league,
    currency_chain: ['Divine Orb', 'Chaos Orb'], ...extra })).rejects.toThrow(/rate|cost/i);
});
