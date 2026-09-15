import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

// A compact, hand-authored PoE1 contract fixture. These selected tier chains
// exercise matching, tag ordering, hybrid text, bench and essence joins. This
// is not a download, a complete game dataset, or a runtime PoE1 fallback.
const mod = (id: string, type: string, affix: string, level: number, group: string,
  lines: string[], keys: string[], weights: number[], tags: string[]) =>
  `[${JSON.stringify(id)}] = { type=${JSON.stringify(type)}, affix=${JSON.stringify(affix)}, level=${level}, group=${JSON.stringify(group)},
    ${lines.map(v => JSON.stringify(v)).join(',')}, statOrder={1,2}, weightKey={${keys.map(v => JSON.stringify(v))}}, weightVal={${weights}}, modTags={${tags.map(v => JSON.stringify(v))}} }`;
const mods = [
  mod('Strength1','Suffix','of the Brute',1,'Strength',['+(8-12) to Strength'],['ring','str_armour','default'],[1000,1000,0],['attribute']),
  mod('Strength8','Suffix','of the Titan',74,'Strength',['+(43-50) to Strength'],['ring','str_armour','default'],[1000,1000,0],['attribute']),
  mod('IncreasedLife1','Prefix','Healthy',1,'IncreasedLife',['+(10-19) to maximum Life'],['weapon','default'],[0,1000],['resource','life']),
  mod('IncreasedLife6','Prefix','Stalwart',36,'IncreasedLife',['+(60-69) to maximum Life'],['fishing_rod','weapon','default'],[0,0,1000],['resource','life']),
  mod('IncreasedLife11','Prefix','Vigorous',73,'IncreasedLife',['+(145-159) to maximum Life'],['weapon','default'],[0,1000],['resource','life']),
  mod('IncreasedLife12','Prefix','Fecund',81,'IncreasedLife',['+(160-179) to maximum Life'],['weapon','default'],[0,1000],['resource','life']),
  mod('FireResist1','Suffix','of the Whelpling',1,'FireResistance',['+(6-11)% to Fire Resistance'],['armour','ring','default'],[1000,1000,0],['elemental','fire','resistance']),
  mod('FireResist4','Suffix','of the Drake',36,'FireResistance',['+(24-29)% to Fire Resistance'],['armour','ring','default'],[1000,1000,0],['elemental','fire','resistance']),
  mod('FireResist6','Suffix','of the Dragon',60,'FireResistance',['+(36-41)% to Fire Resistance'],['armour','ring','default'],[1000,1000,0],['elemental','fire','resistance']),
  mod('FireResist8','Suffix','of Tzteosh',84,'FireResistance',['+(46-48)% to Fire Resistance'],['armour','ring','default'],[1000,1000,0],['elemental','fire','resistance']),
  mod('ArmourLife','Prefix',"Crocodile's",46,'ArmourAndLife',['+(97-144) to Armour','+(34-38) to maximum Life'],['str_armour','default'],[1000,0],['defences','life']),
  mod('IncreasedLifeEnhancedMod','Prefix','Essences',82,'IncreasedLifeEnhanced',['+(100-120) to maximum Life','(5-7)% increased maximum Life'],['default'],[0],['resource','life']),
  mod('GreedEssence7','Prefix','Essences',82,'IncreasedLife',['+(180-189) to maximum Life'],['default'],[0],['resource','life']),
  mod('FireImplicit','Suffix','',1,'FireResistance',['+(20-30)% to Fire Resistance'],['default'],[0],['fire']),
  mod('AddedPhysicalDamage1','Prefix','Glinting',1,'PhysicalDamage',['Adds (4-6) to (8-10) Physical Damage to Attacks'],['ring','default'],[1000,0],['physical','attack']),
  mod('Mana1','Prefix','Beryl',1,'IncreasedMana',['+(10-19) to maximum Mana'],['default'],[1000],['mana']),
  mod('Armour1','Prefix','Protective',1,'ArmourPercent',['(10-20)% increased Armour'],['str_armour','default'],[1000,0],['defences']),
  mod('ColdResist1','Suffix','of the Inuit',1,'ColdResistance',['+(6-11)% to Cold Resistance'],['armour','ring','default'],[1000,1000,0],['cold']),
];

export function useLegacyCraftFixture() {
  const keys = ['POE_GAME','POB_INSTALL_DIR','POE_MCP_SUITE_POB_DIR','POE_MCP_SUITE_ROOT'] as const;
  const old = keys.map(k => process.env[k]);
  const root = mkdtempSync(join(tmpdir(), 'core-craft-poe1-'));
  const write = (name: string, text: string) => { const p = join(root, 'src', name); mkdirSync(dirname(p), {recursive:true}); writeFileSync(p,text); };
  write('GameVersions.lua', 'liveTargetVersion="3_0"');
  write('Data/ModExplicit.lua', `return {${mods.join(',\n')}}`);
  write('Data/Bases/body.lua', `local itemBases=...
    itemBases["Astral Plate"]={type="Body Armour",subType="Armour",tags={armour=true,body_armour=true,default=true,str_armour=true},implicit="+(8-12)% to all Elemental Resistances",req={level=62,str=180}}`);
  write('Data/Bases/helmet.lua', `local itemBases=...
    itemBases["Hubris Circlet"]={type="Helmet",subType="Energy Shield",tags={armour=true,helmet=true,default=true,int_armour=true},req={level=69,int=154}}`);
  write('Data/Bases/ring.lua', `local itemBases=...
    itemBases["Sapphire Ring"]={type="Ring",tags={ring=true,default=true},implicit="+(20-30)% to Cold Resistance",req={level=8}}
    itemBases["Ruby Ring"]={type="Ring",tags={ring=true,default=true},req={level=16}}`);
  write('Data/Essence.lua', 'return { ["Greed7"]={name="Deafening Essence of Greed",type=1,tier=7,mods={["Body Armour"]="GreedEssence7"}} }');
  write('Data/ModMaster.lua', `return { {type="Suffix",affix="of Craft",level=60,group="ColdAndLightningResistance",
    "+(25-30)% to Cold and Lightning Resistances",types={["Body Armour"]=true},modTags={"cold","lightning","resistance"}} }`);
  process.env.POE_GAME='poe1'; process.env.POB_INSTALL_DIR=root;
  return {root, cleanup() { keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]); rmSync(root,{recursive:true,force:true}); }};
}
