"""Read installed PoB2 code and execute its geometry in an isolated Lua VM.

Uses the suite's existing lupa runtime. Never connects to or changes the GUI.
No installed game data is copied into repository fixtures.
"""
import json
import sys
import re
from pathlib import Path
from lupa.luajit21 import LuaRuntime

root = Path(sys.argv[1])
version = sys.argv[2]
lua = LuaRuntime(unpack_returned_tuples=True)
g = lua.globals()
lua.execute("function newClass() CapturedClass={}; return CapturedClass end")
tree_source = (root / "Classes/PassiveTree.lua").read_text()
lua.execute(tree_source)
g.tree = lua.execute((root / f"TreeData/{version}/tree.lua").read_text())
g.data = lua.table()
lua.execute((root / "Data/Misc.lua").read_text(), g.data)
data_source = (root / "Modules/Data.lua").read_text()
radius_definition = data_source.split("data.jewelRadii = {", 1)[1].split("\ndata.jewelRadius =", 1)[0]
lua.execute("data.jewelRadii = {" + radius_definition)
setter = data_source.split("data.setJewelRadiiGlobally = function", 1)[1].split("\ndata.jewelRadii =", 1)[0]
lua.execute("data.setJewelRadiiGlobally = function" + setter)
g.data.setJewelRadiiGlobally(version)
lua.execute("""
self={nodes=tree.nodes, sockets={}, scaleImage=1, nodeOverlay={},
  orbitAnglesByOrbit=tree.constants.orbitAnglesByOrbit,
  orbitRadii=tree.constants.orbitRadii,
  GetNodeTargetSize=function() return {width=0} end,
  GetAssetByName=function() return {width=0} end,
  ProcessStats=function() end}
for id,node in pairs(tree.nodes) do
  node.id=id; node.o=node.orbit; node.oidx=node.orbitIndex
  node.group=tree.groups[node.group]
  node.type=node.classesStart and 'ClassStart' or node.isAscendancyStart and 'AscendClassStart'
    or node.isJewelSocket and 'Socket' or node.isKeystone and 'Keystone'
    or node.isNotable and 'Notable' or node.isMastery and 'Mastery' or 'Normal'
  CapturedClass.ProcessNode(self,node)
  if node.isJewelSocket then self.sockets[id]=node end
end
""")
membership = tree_source.split("-- Precalculate the lists of nodes that are within each radius of each socket", 1)[1].split("\n\tfor name, keystone", 1)[0]
lua.execute(membership)

# Run native Time-Lost node-target functions; only modifier recording is stubbed.
parser = (root / "Modules/ModParser.lua").read_text()
small = parser.split('["(%d+)%% increased Effect of Small Passive Skills in Radius$"] = ', 1)[1].split('\n\t["(%d+)%% increased Effect of Notable', 1)[0].rstrip().removesuffix(',')
notable = parser.split('["(%d+)%% increased Effect of Notable Passive Skills in Radius$"] = ', 1)[1].split('\n\t["^(%w+) Passive Skills', 1)[0].rstrip().removesuffix(',')
g.smallFunc = lua.eval(small)(10)
g.notableFunc = lua.eval(notable)(10)
g.applies = lua.eval("""function(func,node)
  local out={}; out.NewMod=function(self,...) self[#self+1]={} end
  func(node,out,{modSource='Fixture'})
  return #out > 0
end""")
spec = (root / 'Classes/PassiveSpec.lua').read_text()
condition = re.search(r'if (node.type ~= "ClassStart" and node.type ~= "Socket" and not node.ascendancyName) then', spec).group(1)
g.canAllocate = lua.eval('function(node) return ' + condition + ' end')

socket_ids = [7960, 21984, 32763, 61419, 61834]
result = {"version": version, "radii": [], "sockets": {}, "positions": {}}
for index, radius in g.data.jewelRadius.items():
    result["radii"].append({"index": index, "inner": radius["inner"] * g.data.gameConstants.PassiveTreeJewelDistanceMultiplier,
                            "outer": radius["outer"] * g.data.gameConstants.PassiveTreeJewelDistanceMultiplier})
for socket_id in socket_ids:
    socket = g.self.sockets[socket_id]
    memberships = {}
    for index, radius_nodes in socket.nodesInRadius.items():
        memberships[str(index)] = sorted(str(node_id) for node_id, _ in radius_nodes.items())
    small_nodes = socket.nodesInRadius[1]
    large_nodes = socket.nodesInRadius[4]
    result["sockets"][str(socket_id)] = {
        "memberships": memberships,
        "smallTargets": sorted(str(i) for i, n in small_nodes.items() if g.applies(g.smallFunc, n)),
        "notableTargets": sorted(str(i) for i, n in large_nodes.items() if g.applies(g.notableFunc, n)),
        "mediumRingTargets": sorted(str(i) for i, n in socket.nodesInRadius[8].items() if g.canAllocate(n)),
    }
for _, node in g.tree.nodes.items():
    if node.x is not None and str(node.orbit) not in result["positions"]:
        result["positions"][str(node.orbit)] = {"id": str(node.id), "x": node.x, "y": node.y}

unique_texts = lua.execute((root / "Data/Uniques/jewel.lua").read_text())
catalog = [text.strip().splitlines()[0] for _, text in unique_texts.items()]
result["catalog"] = catalog
result["attributeThresholdItems"] = [text.strip().splitlines()[0] for _, text in unique_texts.items() if "With at least" in text and "in Radius" in text]
mods = lua.execute((root / 'Data/ModJewel.lua').read_text())
result['attributeThresholdAffixes'] = [key for key, mod in mods.items() if any(
    isinstance(line, str) and re.search(r'With(?: at least)? .*?(Strength|Dexterity|Intelligence) in Radius', line)
    for index, line in mod.items() if isinstance(index, int))]
bases = lua.table()
lua.execute((root / 'Data/Bases/jewel.lua').read_text(), bases)
result['timeLostBases'] = sorted(name for name, _ in bases.items() if name.startswith('Time-Lost '))
print(json.dumps(result))
