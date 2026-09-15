// Shapes checked against the public PoE2 economy API on 2026-09-15.
// Small synthetic exchange prices make unit expectations independently checkable.
const item = (id: string, name: string) => ({ id, name, image: '', category: 'Currency', detailsId: id });
export function exchangeFixture() {
  return {
    core: { primary: 'divine', secondary: 'chaos', rates: { chaos: 10, exalted: 400 },
      items: [item('divine', 'Divine Orb'), item('chaos', 'Chaos Orb'), item('exalted', 'Exalted Orb')] },
    items: [item('alch', 'Orb of Alchemy')],
    lines: [
      { id: 'chaos', primaryValue: 0.1 },
      { id: 'exalted', primaryValue: 0.0025, volumePrimaryValue: 800, maxVolumeCurrency: 'divine', maxVolumeRate: 400 },
      { id: 'alch', primaryValue: 0.005, sparkline: { totalChange: 3, data: [null, 1, 3] } },
    ],
  };
}

export function stashFixture() {
  return {
    core: { ...exchangeFixture().core, rates: { chaos: 9.45, exalted: 352.7 } },
    // Numeric ids and inline item metadata; there is no top-level items array.
    lines: [{ id: 360, itemId: 'The Gnashing Sash Wide Belt', name: 'The Gnashing Sash',
      baseType: 'Wide Belt', detailsId: 'the-gnashing-sash-wide-belt', category: 'Belt',
      primaryValue: 749.5, listingCount: 6, corrupted: false, levelRequired: 60,
      sparkLine: { totalChange: -66.54, data: [null, 0, -66.54] } },
      { id: 361, itemId: 'The Gnashing Sash Wide Belt', name: 'The Gnashing Sash',
        baseType: 'Wide Belt', detailsId: 'the-gnashing-sash-wide-belt-corrupted',
        primaryValue: 700, listingCount: 2, corrupted: true, variant: 'corrupted variant' }],
  };
}

export function poe1Fixture() {
  return { core: { primary: 'chaos', secondary: 'divine', rates: { divine: 0.005 },
    items: [item('chaos', 'Chaos Orb'), item('divine', 'Divine Orb')] },
    items: [item('divine', 'Divine Orb')], lines: [{ id: 'divine', primaryValue: 200 }] };
}

export function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers });
}
