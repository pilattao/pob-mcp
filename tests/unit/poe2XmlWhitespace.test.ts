import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { BuildService } from '../../src/services/buildService';
import { BuildExportService } from '../../src/services/buildExportService';

const suite = path.resolve(__dirname, '../../..');
const key = 'questAct 2Valley of the TitansMedallion';
const choice = '30% increased Charm Charges Gained\n\t+1 Charm Slot';
const opaque = ' \tRune & Skill\r\n\t"Granted" <unchanged>  ';
const fixture = `<?xml version="1.0"?>
<PathOfBuilding2>
  <Build className="Witch" level="40"/>
  <Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""/></Tree>
  <Config activeConfigSet="1"><ConfigSet id="1" title="  Chosen\t ">
    <Input name="${key}" string="${choice}"/>
  </ConfigSet></Config>
  <Items activeItemSet="1"><Item id="1" opaque=" \tRune &amp; Skill\r\n\t&quot;Granted&quot; &lt;unchanged&gt;  ">Rarity: NORMAL
Chiming Staff
Sockets: S S
Rune: Test Rune
Grants Skill: Level 17 Sigil of Power</Item><ItemSet id="1"><RuneSlot slotName="Weapon 1 Rune #1" runeName="  Test &amp; Rune\t "/></ItemSet></Items>
  <Opaque label=" \tline one\r\nline two\rline three\t " encoded="&amp;#10; &amp;#x9; &quot;&apos;&lt;&gt;"/>
  <Notes><![CDATA[example attr="  literal\n\ttext  " &amp; is text]]></Notes>
</PathOfBuilding2>`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
let directory: string;
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'poe2-xml-whitespace-'));});
afterEach(async()=>{await fs.rm(directory,{recursive:true,force:true});});

it('retains every literal attribute whitespace character while preserving entity and rune values',()=>{
  const b:any=new BuildService(directory).parseBuildContent(fixture);
  expect(b.Config.ConfigSet.Input.string).toBe(choice);
  expect(b.Config.ConfigSet.title).toBe('  Chosen\t ');
  expect(b.Items.Item.opaque).toBe(opaque);
  expect(b.Items.ItemSet.RuneSlot.runeName).toBe('  Test & Rune\t ');
  expect(b.Opaque.label).toBe(' \tline one\r\nline two\rline three\t ');
  expect(b.Opaque.encoded).toBe('&#10; &#x9; "\'<>');
  expect(b.Items.Item['#text']).toContain('Grants Skill: Level 17 Sigil of Power');
  expect(b.Notes).toBe('example attr="  literal\n\ttext  " &amp; is text');
});

it('exports native literal whitespace, survives repeated export and preserves the source bytes',async()=>{
  const file=path.join(directory,'Original.xml');await fs.writeFile(file,fixture);
  const service=new BuildService(directory),exporter=new BuildExportService(directory);
  let value=await service.readBuild('Original.xml');
  for(let i=0;i<2;i++){
    const output=await exporter.exportBuild(value,{outputName:`Copy-${i}.xml`});
    const xml=await fs.readFile(output.filePath,'utf8');
    expect(xml).toContain(`string="${choice}"`);
    expect(xml).toContain('opaque=" \tRune &amp; Skill\r\n\t&quot;Granted&quot; &lt;unchanged&gt;  "');
    expect(xml).not.toMatch(/&#(?:0*(?:9|10|13|32)|x0*(?:9|a|d|20));/i);
    value=service.parseBuildContent(xml);
    expect((value as any).Items.Item.opaque).toBe(opaque);
  }
  expect(await fs.readFile(file,'utf8')).toBe(fixture);
});

it('protects only attributes, leaving attribute-looking text, comments and CDATA unchanged',()=>{
  const xml='<PathOfBuilding2><!-- <Fake x=" \r\n "/> --><Build level="1"/><Notes><![CDATA[<Fake x="  a\n\tb  "/>]]></Notes><Future opaque=\' \tA &quot;B&quot;\r\nC \'>text attr="  literal  "</Future></PathOfBuilding2>';
  const b:any=new BuildService(directory).parseBuildContent(xml);
  expect(b.Notes).toBe('<Fake x="  a\n\tb  "/>');
  expect(b.Future.opaque).toBe(' \tA "B"\r\nC ');
  expect(b.Future['#text']).toBe('text attr="  literal  "');
  expect(b.Fake).toBeUndefined();
});

it('does not reinterpret opaque entity-looking strings or leak parser markers across reads',()=>{
  const parser=new BuildService(directory);
  const token='&pobMcpAttributeWhitespace0_32;';
  const xml='<PathOfBuilding2><Build level="1"/><Opaque value=" \t&amp;pobMcpAttributeWhitespace0_32; &#x27; &amp;#13;\u00a0 "/></PathOfBuilding2>';
  const first:any=parser.parseBuildContent(xml);
  expect(first.Opaque.value).toBe(` \t${token} ' &#13;\u00a0 `);
  expect((parser.parseBuildContent(fixture) as any).Items.Item.opaque).toBe(opaque);
  expect((parser.parseBuildContent(xml) as any).Opaque.value).toBe(first.Opaque.value);
});

const native=process.env.POE2_XML_NATIVE_TEST==='1'?describe:describe.skip;
native('offline native ConfigTab round-trip',()=>{
  it('retains native quest effects and opaque attributes through actual BuildService/export and restoration',async()=>{
    const privateFile=process.env.POE2_XML_PRIVATE_FILE;
    const original=privateFile?await fs.readFile(privateFile,'utf8'):fixture;
    const sourceHash=hash(original);
    // Every write, including snapshot restoration, targets this disposable copy.
    const copy=path.join(directory,'Character.xml');await fs.writeFile(copy,original);
    const builds=new BuildService(directory),exporter=new BuildExportService(directory);
    const snapshot=await exporter.snapshotBuild(builds,{buildName:'Character.xml',tag:'Before round-trip'});
    const output=await exporter.exportBuild(await builds.readBuild('Character.xml'),{outputName:'Roundtrip.xml'});
    const after=await fs.readFile(output.filePath,'utf8');
    await fs.writeFile(copy,after);
    const restored=await exporter.restoreSnapshot({buildName:'Character.xml',snapshotId:snapshot.snapshotId});
    expect(restored.restoredXml).toBe(original);
    expect(await fs.readFile(copy,'utf8')).toBe(original);
    if(privateFile)expect(hash(await fs.readFile(privateFile,'utf8'))).toBe(sourceHash);
    const request=path.join(directory,'native-check.json');
    await fs.writeFile(request,JSON.stringify({before:original,after,restored:restored.restoredXml,fullBuild:!!privateFile}));
    const python=path.join(suite,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const {stdout}=await promisify(execFile)(python,[path.join(suite,'tests/poe2/quest_roundtrip_worker.py'),request],{cwd:suite,maxBuffer:2_000_000,timeout:60000});
    const line=stdout.split('\n').find(s=>s.startsWith('QUEST_ROUNDTRIP_RESULT '));
    expect(line).toBeDefined();
    const proof=JSON.parse(line!.slice('QUEST_ROUNDTRIP_RESULT '.length));
    if(privateFile)expect(hash(await fs.readFile(privateFile,'utf8'))).toBe(sourceHash);
    console.info('Native preservation evidence:',proof);
    if(process.env.POE2_XML_PROOF_OUTPUT)await fs.writeFile(process.env.POE2_XML_PROOF_OUTPUT,JSON.stringify({...proof,originalSha256:sourceHash,restoredSha256:hash(restored.restoredXml)},null,2)+'\n');
    expect(proof.attributesEqual).toBe(true);
    expect(proof.runeAndItemDataEqual).toBe(true);
    expect(proof.mathEqual).toBe(true);
    expect(proof.restoredEqual).toBe(true);
    expect(proof.before.questCharmLimit).toBe(1);
    expect(proof.before.questCharmChargesGained).toBe(30);
    // Keep this strict cross-owner gate: a correct whitespace reader does not
    // make mixed-content reordering by the export writer a successful round-trip.
    expect(proof.nativeDocumentEqual).toBe(true);
    console.info('Native XML round-trip and restoration:',{...proof,originalSha256:sourceHash,restoredSha256:hash(restored.restoredXml)});
  },60000);
});
