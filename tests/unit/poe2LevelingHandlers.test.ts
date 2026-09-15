import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BuildService } from '../../src/services/buildService.js';
import { handlePlanLeveling } from '../../src/handlers/levelingHandlers.js';

const xml = (name = 'Sorceress', level = 12, skill = 'Arc') => `<PathOfBuilding2><Build className="${name}" ascendClassName="None" level="${level}" mainSocketGroup="2"><PlayerStat stat="Int" value="30"/><PlayerStat stat="Str" value="10"/><PlayerStat stat="Dex" value="10"/></Build><Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""/></Tree><Skills activeSkillSet="2"><SkillSet id="1"><Skill><Gem nameSpec="Comet" level="20"/></Skill></SkillSet><SkillSet id="2" title="Campaign"><Skill enabled="false"><Gem nameSpec="Comet" level="20"/></Skill><Skill enabled="true" mainActiveSkill="1"><Gem nameSpec="${skill}" level="5" enabled="true"/><Gem nameSpec="Spark" level="2" enabled="false"/></Skill></SkillSet></Skills></PathOfBuilding2>`;
const decode = (result: any) => result.structuredContent ?? {};
describe('PoE2 leveling read-only character plans', () => {
  let directory: string;
  let originalGame: string | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'poe2-leveling-')); originalGame = process.env.POE_GAME; process.env.POE_GAME = 'poe2'; });
  afterEach(() => { rmSync(directory, {recursive: true, force: true}); if (originalGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = originalGame; });
  function context(client: any = null) { return { buildService: new BuildService(directory), getLuaClient: () => client, ensureLuaClient: async () => {} }; }
  function live(content = xml()) {
    return { getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({name: 'Selected',className: 'Sorceress',level: 12}),
      exportBuildXml: jest.fn<() => Promise<string>>().mockResolvedValue(content),
      getStats: jest.fn<() => Promise<any>>().mockResolvedValue({Int: 30,Str: 10,Dex: 10,SpiritUnreserved: -10}),
      loadBuild: jest.fn(), saveBuild: jest.fn(), setBuildLevel: jest.fn() };
  }
  it('uses selected unsaved XML and excludes alternate sets and disabled gems', async () => {
    const client = live();
    const result = await handlePlanLeveling(context(client), {});
    const plan = decode(result);
    expect(plan.character).toMatchObject({className:'Sorceress',level:12,source:'live',skillSetId:'2'});
    expect(plan.skills.map((s: any) => s.name)).toEqual(['Arc']);
    expect(result.content[0].text).not.toMatch(/Labyrinth|Merveil|Kitava\)|rustic sash|Onslaught|6L|life nodes/i);
    expect(client.loadBuild).not.toHaveBeenCalled(); expect(client.saveBuild).not.toHaveBeenCalled(); expect(client.setBuildLevel).not.toHaveBeenCalled();
  });
  it('uses a requested file rather than a different live build', async () => {
    writeFileSync(join(directory,'Saved.xml'),xml('Witch',45,'Comet'));
    const client = live();
    const plan = decode(await handlePlanLeveling(context(client), {build_name:'Saved.xml'}));
    expect(plan.character).toMatchObject({className:'Witch',level:45,source:'file'});
    expect(plan.skills[0].name).toBe('Comet');
    expect(client.exportBuildXml).not.toHaveBeenCalled();
  });
  it('prefers unsaved selected state when the explicit file names that same build',async()=>{
    writeFileSync(join(directory,'Selected.xml'),xml('Sorceress',5,'Comet'));
    const plan=decode(await handlePlanLeveling(context(live()),{build_name:'Selected.xml'}));
    expect(plan.character).toMatchObject({source:'live',level:12});
    expect(plan.skills[0].name).toBe('Arc');
  });
  it('keeps a caller-only planning scenario explicitly partial',async()=>{
    const plan=decode(await handlePlanLeveling(context(),{class_name:'Warrior',current_level:1,main_skill:'Rolling Slam'}));
    expect(plan.status).toBe('partial');
    expect(plan.character.source).toBe('arguments');
    expect(plan.skills[0].name).toBe('Rolling Slam');
  });
  it('gates engraving by native tier and natural gem cap, not calculation rows', async () => {
    const plan = decode(await handlePlanLeveling(context(live()), {}));
    expect(plan.skills[0]).toMatchObject({name:'Arc',minimumGemLevel:5,firstRequirement:{level:5,levelRequirement:14},status:'blocked'});
    expect(plan.skills[0].milestones[0].level).toBe(5);
    expect(plan.skills[0].milestones.every((r: any) => r.level <= 20)).toBe(true);
    expect(plan.actions.some((a: string) => /Arc/.test(a) && /14/.test(a))).toBe(true);
  });
  it('never invents a class or reports missing evidence as a full plan', async () => {
    await expect(handlePlanLeveling(context(), {})).rejects.toThrow(/live|build|class/i);
  });
  it('rejects invalid class/ascendancy pairs and stale named targets', async () => {
    await expect(handlePlanLeveling(context(live()), {class_name:'Warrior',ascendancy:'Blood Mage'})).rejects.toThrow(/class|ascendancy/i);
    await expect(handlePlanLeveling(context(live()), {build_name:'Missing.xml'})).rejects.toThrow();
  });
  it('honours explicit quest progress without inferring completion from character level', async () => {
    const result = await handlePlanLeveling(context(live()), {current_stage:'act-2',completed_quests:['act-1/crowbell'],ascendancy_points:2} as any);
    const plan = decode(result);
    expect(plan.campaign.find((s: any) => s.id === 'act-1').quests.find((q: any) => q.id === 'act-1/crowbell').status).toBe('completed');
    expect(plan.campaign.find((s: any) => s.id === 'act-1').quests.find((q: any) => q.info === "Una's Lute").status).toBe('unverified');
    expect(plan.ascendancy.earnedPoints).toBe(2);
    expect(plan.campaign.map((s: any) => s.id)).toEqual(['act-1','act-2','act-3','act-4','interlude-1','interlude-2','interlude-3','epilogue']);
  });
  it('reports missing gem metadata as partial, with no fake skill progression', async () => {
    const plan = decode(await handlePlanLeveling(context(live(xml('Sorceress',12,'Nonexistent Skill'))), {}));
    expect(plan.status).toBe('partial');
    expect(plan.skills[0].milestones).toEqual([]);
    expect(plan.gaps.join(' ')).toMatch(/Nonexistent Skill/);
  });
  it('refuses to infer earned ascendancy points from a selected subclass', async () => {
    const plan = decode(await handlePlanLeveling(context(live(xml().replace('ascendClassName="None"','ascendClassName="Stormweaver"'))), {}));
    expect(plan.ascendancy.earnedPoints).toBeNull();
    expect(plan.status).toBe('partial');
    expect(plan.passives).toMatchObject({recommendedOrder:null});
  });
  it('reads native attributes explicitly when the default stat response omits them', async () => {
    const client=live();
    client.getStats=jest.fn<any>().mockImplementation(async (fields?: string[]) => fields?.includes('Int') ? {Str:10,Dex:10,Int:30} : {Life:100});
    const plan=decode(await handlePlanLeveling(context(client),{}));
    expect(plan.character.attributes).toEqual({Str:10,Dex:10,Int:30});
  });
  it('rejects changing native XML during the extra attribute read', async () => {
    const client=live();
    client.exportBuildXml.mockResolvedValueOnce(xml()).mockResolvedValue(xml('Sorceress',13));
    await expect(handlePlanLeveling(context(client),{})).rejects.toThrow(/changed/);
  });
});
