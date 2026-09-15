/** Item evaluator ABI, independent of the gem evaluator and public budget schema. */
export interface NativeItemExpected {
  baseType?: string; rarity?: string; quality?: number; itemLevel?: number;
  requiredLevel?: number; socketCount?: number; corrupted?: boolean;
  weapon?: Record<string, number>;
}
export interface NativeItemReplacement {
  slotName: string;
  text?: string;
  remove?: boolean;
  candidateId: string;
  entryId: string;
  listingId: string;
  expected?: NativeItemExpected;
}
export interface NativeItemScenario { id: string; replacements: NativeItemReplacement[] }
export interface NativeItemSkillState {
  mainSkill?: string; mainSocketGroup: number;
  itemSkillBindings?: Array<{ groupIndex: number; gemIndex: number; skillId: string; slotName: string;
    itemId: number; sourceLevel: number; previousLevel: number; method: 'unique-equipped-item-grant' }>;
  groups: Array<{ index: number; source?: string; slot?: string; enabled: boolean; includeInFullDPS?: boolean;
    gems: Array<{ skillId?: string; gemId?: string; name: string; level?: number; quality?: number; enabled?: boolean; sourceLevel?: number }> }>;
}
export interface NativeItemEvaluationRequest {
  expectedBuildName: string;
  expectedXml: string;
  snapshotId: string;
  itemSetId: string | number;
  skillSetId: string | number;
  scenarios: NativeItemScenario[];
}
export interface NativeItemEvaluation {
  snapshotId: string;
  baseline: Record<string, number>;
  baselineSkills?: NativeItemSkillState;
  comparisons: Array<{ id: string; valid: boolean; inputs: NativeItemReplacement[];
    output?: Record<string, number>; deltas?: Record<string, { absolute: number; percent?: number }>;
    warnings: string[]; error?: string; skills?: NativeItemSkillState; implicitRemovals?: string[] }>;
  preservation: { xmlUnchanged: boolean; statsUnchanged: boolean; selectionsUnchanged: boolean; undoUnchanged: boolean;
    catalogUnchanged: boolean; treeUnchanged: boolean; cacheUnchanged: boolean };
  conditions: Record<string, unknown>;
}
