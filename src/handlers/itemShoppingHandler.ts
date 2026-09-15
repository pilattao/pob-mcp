/** The separately routed item advisor shares selected-build shopping semantics. */
import { handleGenerateShoppingList, type ShoppingListContext, type ShoppingListArgs } from './shoppingListHandlers.js';
import type { ShoppingRequirements } from '../services/shoppingListService.js';

export type ItemShoppingContext = ShoppingListContext;
export interface ItemShoppingArgs extends Omit<ShoppingListArgs, 'slots' | 'item_requirements'> {
  slot: string;
  item_requirements?: ShoppingRequirements;
}

export async function handleFindItemUpgrades(context: ItemShoppingContext, args: ItemShoppingArgs) {
  if (typeof args.slot !== 'string' || !args.slot.trim()) throw new Error('A nonempty item slot is required');
  return handleGenerateShoppingList(context, {
    ...args, slots: [args.slot], include_gems: false,
    item_requirements: args.item_requirements ? { [args.slot]: args.item_requirements } : undefined,
  });
}
