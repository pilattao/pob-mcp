import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { BuildService } from '../../src/services/buildService.js';
import { BuildExportService } from '../../src/services/buildExportService.js';
import { sanitizeBuildName, resolveBuildPath } from '../../src/utils/pathSanitizer.js';

const xml = `<PathOfBuilding2>
  <Build className="Witch" ascendClassName="Blood Mage" level="93"/>
  <Items activeItemSet="2">
    <Item id="1">Rarity: RARE
Primary Staff
Paralysing Staff
Sockets: S S
Rune: Greater Vision Rune
+5 to Level of all Spell Skills</Item>
    <Item id="2">Rarity: MAGIC
Utility Staff
Chiming Staff
+2 to maximum number of Elemental Infusions</Item>
    <Item id="3">Rarity: NORMAL
Stone Charm</Item>
    <Item id="4">Rarity: MAGIC
Potent Ultimate Life Flask of the Ample
Unique ID: synthetic-life
Quality: 20
Implicits: 0
71% increased Amount Recovered</Item>
    <Item id="5">Rarity: MAGIC
Concentrated Ultimate Mana Flask of the Abundant
Unique ID: synthetic-mana
Implicits: 0
67% increased Amount Recovered</Item>
    <Item id="6">Rarity: RARE
Test Stone
Sapphire
Implicits: 0
12% increased Critical Hit Chance</Item>
    <Item id="7">Rarity: UNIQUE
Heart of the Well
Diamond
Implicits: 0
Gain 12% of Damage as Extra Chaos Damage</Item>
    <ItemSet id="1"><Slot name="Weapon 1" itemId="1"/></ItemSet>
    <ItemSet id="2"><Slot name="Weapon 1" itemId="1"/><Slot name="Weapon 1 Swap" itemId="2"/><Slot name="Charm 1" itemId="3"/><Slot name="Flask 1" itemId="4"/><Slot name="Flask 2" itemId="5"/></ItemSet>
  </Items>
  <Skills activeSkillSet="2">
    <SkillSet id="1"><Skill><Gem nameSpec="Frost Bomb" level="18" quality="20"/></Skill></SkillSet>
    <SkillSet id="2"><Skill enabled="true"><Gem nameSpec="Spark" level="20" quality="20"/><Gem nameSpec="Rapid Casting II" level="1" quality="0"/></Skill></SkillSet>
  </Skills>
  <Tree activeSpec="1"><Spec treeVersion="0_5" nodes="101,102,103">
    <URL>https://example.test/tree</URL>
    <WeaponSet1 nodes="102"/><WeaponSet2 nodes="103"/><Sockets><Socket nodeId="101" itemId="6"/><Socket nodeId="102" itemId="7"/></Sockets>
    <Overrides><AttributeOverride strNodes="101" intNodes="102,103"/></Overrides>
  </Spec></Tree>
  <Notes>Verisium &amp; Choir notes</Notes>
  <Party/><TreeView/><FutureExtension><EmptyChild/></FutureExtension>
</PathOfBuilding2>`;

describe('PoE2 build file contract', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poe2-contract-'));
    await fs.mkdir(path.join(directory, 'Forbidden Rites'));
    await fs.writeFile(path.join(directory, 'Forbidden Rites', 'Choir.xml'), xml);
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('reads PoB2 root and keeps selected skill/item sets and weapon specialisations', async () => {
    const service = new BuildService(directory);
    const build = await service.readBuild('Forbidden Rites/Choir.xml');
    expect(build).toBeDefined();
    expect(build.Build?.ascendClassName).toBe('Blood Mage');
    const summary = service.generateBuildSummary(build);
    expect(summary).toContain('Spark (20/20) - Rapid Casting II (1/0)');
    expect(summary).not.toContain('Frost Bomb (18/20)');
    expect(summary).toContain('Weapon 1 Swap');
    expect(summary).toContain('Charm 1');
    const spec = service.getActiveSpec(build);
    expect(spec.WeaponSet1.nodes).toBe('102');
    expect(spec.WeaponSet2.nodes).toBe('103');
  });

  it('round-trips PoB2 XML without turning text sections into attributes', async () => {
    const build = await new BuildService(directory).readBuild('Forbidden Rites/Choir.xml');
    const output = await new BuildExportService(directory).exportBuild(JSON.parse(JSON.stringify(build)), { outputName: 'Copy' });
    const saved = await fs.readFile(output.filePath, 'utf8');
    const parser = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true });
    expect(parser.parse(saved)).toEqual(parser.parse(xml));
    expect(saved).toContain('<PathOfBuilding2>');
    expect(saved).not.toContain('__xmlRoot');
  });

  it('loads extensionless nested Windows paths from WSL without losing traversal protection', async () => {
    const build = await new BuildService(directory).readBuild('Forbidden Rites\\Choir');
    expect(build.Build?.level).toBe('93');
    expect(resolveBuildPath('Forbidden Rites\\Choir', directory)).toBe(path.join(directory, 'Forbidden Rites', 'Choir.xml'));
    expect(sanitizeBuildName('preset.json', directory)).toBe(path.join(directory, 'preset.json'));
    expect(() => resolveBuildPath('', directory)).toThrow();
    for (const unsafe of ['..\\escape', 'C:\\Windows\\file.xml', '\\\\server\\share\\file.xml', '/tmp/escape.xml']) {
      expect(() => sanitizeBuildName(unsafe, directory)).toThrow();
    }
  });

  it('fails explicitly on unrelated or ambiguous XML documents', async () => {
    const service = new BuildService(directory);
    await fs.writeFile(path.join(directory, 'Wrong.xml'), '<Settings><Build/></Settings>');
    await expect(service.readBuild('Wrong.xml')).rejects.toThrow(/build|root|format/i);
    await fs.writeFile(path.join(directory, 'Mixed.xml'), '<PathOfBuilding><Build/></PathOfBuilding><PathOfBuilding2><Build/></PathOfBuilding2>');
    await expect(service.readBuild('Mixed.xml')).rejects.toThrow(/ambiguous|root|format/i);
  });

  it('uses the same snapshot history for bare and suffixed build names', async () => {
    const service = new BuildService(directory);
    const exports = new BuildExportService(directory);
    const before = await exports.snapshotBuild(service, { buildName: 'Forbidden Rites\\Choir', description: 'Original' });
    const listing = await exports.listSnapshots('Forbidden Rites/Choir.xml');
    expect(listing.total).toBe(1);
    expect(listing.snapshots[0].id).toBe(before.snapshotId);
    await fs.writeFile(path.join(directory, 'Forbidden Rites', 'Choir.xml'), xml.replace('level="93"', 'level="94"'));
    service.invalidateBuild('Forbidden Rites\\Choir');
    expect((await service.readBuild('Forbidden Rites/Choir.xml')).Build?.level).toBe('94');
    await exports.restoreSnapshot({ buildName: 'Forbidden Rites/Choir.xml', snapshotId: before.snapshotId, backupCurrent: false });
    service.invalidateBuild('Forbidden Rites\\Choir');
    expect((await service.readBuild('Forbidden Rites/Choir.xml')).Build?.level).toBe('93');
  });

  it('reports two PoE2 flasks and separate charms from the active item set', async () => {
    const service = new BuildService(directory);
    const analysis = service.parseFlasks(await service.readBuild('Forbidden Rites/Choir'));
    expect(analysis).not.toBeNull();
    expect(analysis!.totalFlasks).toBe(2);
    expect(analysis!.flaskTypes.life).toBe(1);
    expect(analysis!.flaskTypes.mana).toBe(1);
    expect((analysis as any).charms[0].name).toBe('Stone Charm');
    const text = service.formatFlaskAnalysis(analysis!);
    expect(text).toContain('2/2');
    expect(text).toContain('Stone Charm');
    expect(text).not.toContain('/5');
    expect(text).not.toContain('of Heat');
  });

  it('resolves Sapphire/Diamond jewels from tree sockets and item IDs', async () => {
    const service = new BuildService(directory);
    const analysis = service.parseJewels(await service.readBuild('Forbidden Rites/Choir'));
    expect(analysis!.totalJewels).toBe(2);
    expect(analysis!.socketedJewels).toBe(2);
    expect(analysis!.socketPlacements.get('101')).toBe('Test Stone');
    expect(analysis!.socketPlacements.get('102')).toBe('Heart of the Well');
    expect(analysis!.warnings).toEqual([]);
  });
});
