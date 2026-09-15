import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

// Hand-authored native PoB2 subset: actual mixed Lua tables, base tags and
// representative Strength/hybrid definitions. Independent of installed files.
export function useNativeCraftFixture() {
  const keys = ['POE_GAME','POB_INSTALL_DIR','POE_MCP_SUITE_POB_DIR','POE2_COE_BUNDLE_PATH','POE_DATA_MCP_CACHE_DIR'] as const;
  const old = keys.map(k => process.env[k]);
  const root = mkdtempSync(join(tmpdir(),'core-craft-poe2-'));
  const write = (name: string, text: string) => { const p=join(root,name);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text); };
  write('GameVersions.lua','liveTargetVersion="0_1"');
  write('Data/Bases/crossbow.lua',`local itemBases=...
    itemBases["Makeshift Crossbow"]={type="Crossbow",tags={crossbow=true,default=true,ranged=true,two_hand_weapon=true,twohand=true,weapon=true},req={}}
    itemBases["Tense Crossbow"]={type="Crossbow",tags={crossbow=true,default=true,weapon=true},req={str=8,dex=8},implicit="(20-30)% increased Bolt Speed"}`);
  write('Data/Bases/jewel.lua','local itemBases=... itemBases["Ruby"]={type="Jewel",tags={jewel=true,default=true},req={}}');
  write('Data/ModItem.lua',`return {
    ["Strength1"]={type="Suffix",affix="of the Brute","+(5-8) to Strength",statOrder={992},level=1,group="Strength",weightKey={"crossbow","default"},weightVal={1,0},modTags={"attribute"}},
    ["Strength2"]={type="Suffix",affix="of the Wrestler","+(9-12) to Strength",statOrder={992},level=11,group="Strength",weightKey={"crossbow","default"},weightVal={1,0},modTags={"attribute"}},
    ["Strength8"]={type="Suffix",affix="of the Titan","+(31-33) to Strength",statOrder={992},level=74,group="Strength",weightKey={"crossbow","default"},weightVal={1,0},modTags={"attribute"}},
    ["LocalIncreasedPhysicalDamagePercentAndAccuracyRating1"]={type="Prefix",affix="Squire's","(15-19)% increased Physical Damage","+(16-20) to Accuracy Rating",statOrder={830,835},level=8,group="LocalIncreasedPhysicalDamagePercentAndAccuracyRating",weightKey={"weapon","default"},weightVal={1,0},modTags={"physical_damage","damage","physical","attack"}},
    ["EssenceOnly"]={type="Prefix",affix="Essences","(70-90)% increased Physical Damage",level=80,group="EssencePhysical",weightKey={"default"},weightVal={0},modTags={"physical"}}
  }`);
  // Native analysis/listing must not depend on Essence.lua or ModMaster.lua.
  process.env.POE_GAME='poe2';process.env.POB_INSTALL_DIR=root;
  const bundlePath=join(root,'coe','poe2','bundle.json');
  process.env.POE2_COE_BUNDLE_PATH=bundlePath;
  write('coe/poe2/bundle.json',JSON.stringify(coeFixture()));
  return {root,bundlePath,write,cleanup(){keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);rmSync(root,{recursive:true,force:true});}};
}

// Verified schema from sources/crafting/poe2.py and CoE's public PoE2 worker
// package_worker_simulator_processor_poe2.js?v=1789404199 (2026-09-15).
// This small class pool uses representative real IDs and weights, not a full
// game snapshot. Two selected tiers make hand-computed probabilities testable.
export function coeFixture() {
  const lang=['Makeshift Crossbow','Crossbows','Heavy','+# to [Strength|Strength]','of the Brute',
    '#% increased [Physical] Damage','Adds # to # [Fire|Fire] Damage','Adds # to # [Cold|Cold] Damage',
    '+# to [Dexterity|Dexterity]','#% increased [Attack] Speed','Essence damage','Sapphire Ring'];
  const group=(id:number,type:number,family:number,influence=6)=>({id,type,domain:1,families:[family],influence,tags:[],adds:[],gtags:[],gvals:[],rank:0});
  const mod=(id:number,key:string,group:number,minlvl:number,label:number,statlabel:number,power:number)=>({id,key,group,minlvl,maxlvl:100,power,label,
    stats:[{index:id,label:statlabel,range:[power,power+3],inverted:false,values:true}],desc:null});
  return {game:'poe2',source:'https://beta.craftofexile.com/?game=poe2',patch:'4.5.5.1.5',fetched_at:1789486032,checked_at:1789486032,
    files:{data:'https://beta.craftofexile.com/json/poe2/4.5.5.1.5/data.json?v=1788821693',lang:'https://beta.craftofexile.com/json/poe2/4.5.5.1.5/localization/english.json?v=1788821693'},lang,
    data:{classes:{entries:[{id:58,label:1,class:80,legacy:false,affixes:null,rarity:null,unmodifiable:null}]},
      items:{entries:[{id:2204,key:'Metadata/Items/Weapons/TwoHandWeapons/Crossbows/FourCrossbow1',label:0,class:58,domain:1,drop:1,
        tags:[0,8,32],implicits:[],enchants:[],skills:null,embed:null,corrupt:false,unmodifiable:false}]},
      mods:{entries:[mod(609,'LocalIncreasedPhysicalDamagePercent1',24,1,2,5,40),mod(610,'LocalIncreasedPhysicalDamagePercent2',24,11,2,5,50),
        mod(522,'LocalAddedFireDamageTwoHand1',50,1,2,6,2),mod(542,'LocalAddedColdDamageTwoHand1',51,1,2,7,2),
        mod(0,'Strength1',48,1,4,3,5),mod(1,'Strength2',48,11,4,3,9),mod(9,'Dexterity1',49,1,4,8,5),
        mod(960,'LocalIncreasedAttackSpeed1',31,1,4,9,5),mod(9999,'EssenceOnly',999,1,2,10,100),mod(2167,'CorruptionOnly',38,1,2,10,100)],stateffects:{}},
      modgroups:{entries:[group(24,1,87),group(50,1,3),group(51,1,4),group(48,2,147),group(49,2,148),group(31,2,38),group(999,1,721,1001),group(38,5,606)]},
      classmods:{'58':{'609':1000,'610':1000,'522':1000,'542':800,'0':500,'1':500,'9':500,'960':1000,'9999':100000,'2167':1}},
      families:{entries:[{id:87,key:'LocalPhysicalDamagePercent'},{id:3,key:'FireDamage'},{id:4,key:'ColdDamage'},{id:147,key:'Strength'},
        {id:148,key:'Dexterity'},{id:38,key:'AttackSpeed'},{id:721,key:'EssenceDamage'},{id:606,key:'AttributeRequirements'}]},
      enums:{types:{'1':'PREFIX','2':'SUFFIX','5':'CORRUPTED'},domains:{'1':'ITEM'}},
      methods:{crafting:[{constraints:['rarity_rare','can_be_rare','open_affix'],elements:[{handler:'poe2_exalted'}]},
        {constraints:['rarity_magic','open_affix'],elements:[{handler:'poe2_augmentation'}]},
        {constraints:['rarity_magic','can_be_rare'],elements:[{handler:'poe2_regal'}]}]}
    }};
}
