import { XMLParser } from 'fast-xml-parser';

// Actual multi-line choice from PoB2 Data/QuestRewards.lua; raw LF + TAB matter
// to the native parser. Keep whitespace handling owned by the shared XML layer.
export const questKey = 'questAct 2Valley of the TitansMedallion';
export const questChoice = '30% increased Charm Charges Gained\n\t+1 Charm Slot';

export const persistenceXml = (level = 81, life = 1200) => `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding2>
  <Build className="Sorceress" ascendClassName="Stormweaver" level="${level}"><PlayerStat stat="Life" value="${life}"/><PlayerStat stat="TotalDPS" value="0"/></Build>
  <Items activeItemSet="2" useSecondWeaponSet="true">
    <Item id="1">Rarity: RARE
Synthetic Staff
Chiming Staff
Sockets: S S
Rune: Greater Vision Rune
+3 to Level of all Spell Skills</Item>
    <Item id="2">Rarity: NORMAL
Stone Charm</Item>
    <ItemSet id="1" title="Inactive"><Slot name="Weapon 1" itemId="1"/></ItemSet>
    <ItemSet id="2" title="Selected"><Slot name="Weapon 1 Swap" itemId="1"/><Slot name="Charm 1" itemId="2"/></ItemSet>
  </Items>
  <Skills activeSkillSet="2"><SkillSet id="1"><Skill><Gem nameSpec="Frost Bomb" level="18"/></Skill></SkillSet><SkillSet id="2"><Skill enabled="true" mainActiveSkill="1"><Gem nameSpec="Spark" level="20" quality="20"/><Gem nameSpec="Rapid Casting II" level="1" enabled="false"/></Skill></SkillSet></Skills>
  <Tree activeSpec="2"><Spec title="Inactive" treeVersion="0_5" nodes="201,202"/><Spec title="Selected" treeVersion="0_5" nodes="101,102,103"><URL>https://example.test/synthetic-tree</URL><WeaponSet1 nodes="102"/><WeaponSet2 nodes="103"/><Overrides><AttributeOverride intNodes="101"/></Overrides></Spec></Tree>
  <Config activeConfigSet="2"><ConfigSet id="1"><Input name="enemyLevel" number="70"/></ConfigSet><ConfigSet id="2"><Input name="enemyLevel" number="83"/><Input name="${questKey}" string="${questChoice}"/></ConfigSet></Config>
  <Notes>Original &amp; synthetic notes</Notes><FutureExtension><EmptyChild/></FutureExtension>
</PathOfBuilding2>`;

export const document = (xml: string) => new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true }).parse(xml);
export async function eventually(check: () => boolean | Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out waiting for a file workflow condition');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
