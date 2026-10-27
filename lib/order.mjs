// The owner's row order for the agents list (drag to reorder): $KADANS_HOME/order.json = { ids: [agentId, ...] }, ids
// only. `kadans agent order <id> ...` replaces it; listAgents shows new chats first (so one that needs you is never buried), then those rows in that order; ended ids drop out.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from './store.mjs';

export const ORDER_MAX = 50;
const orderFile = (home) => join(home, 'order.json');

export function readOrder(home) {
  try {
    const v = JSON.parse(readFileSync(orderFile(home), 'utf8'));
    return Array.isArray(v?.ids) ? [...new Set(v.ids.filter((id) => typeof id === 'string' && id))].slice(0, ORDER_MAX) : [];
  } catch {
    return [];
  }
}

const write = (home, ids) => writeAtomic(orderFile(home), `${JSON.stringify({ ids })}\n`);

// Replaces the stored order (duplicates dropped, at most ORDER_MAX ids). Returns the stored ids.
export function setOrder(home, ids) {
  const clean = [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, ORDER_MAX);
  return withLock(home, () => {
    write(home, clean);
    return clean;
  });
}

// Removes these ids from the stored order (read again under the lock, so a newer order is kept). Writes only on a change.
export function dropFromOrder(home, gone) {
  const drop = new Set(gone);
  if (!drop.size) return;
  withLock(home, () => {
    const ids = readOrder(home);
    const kept = ids.filter((id) => !drop.has(id));
    if (kept.length !== ids.length) write(home, kept);
  });
}

// The list with new (unordered) rows first as they came, then the ordered rows in the stored order (each `ordered: true`).
// Ended rows are never ordered. Returns { list, gone }: the stored ids to drop (ended, or no longer listed; an Orca-only
// id counts as gone only when Orca answered this refresh, so one slow `orca` call never wipes the order).
export function applyOrder(list, order, { ended = new Set(), present = new Set(), orcaRead = false } = {}) {
  if (!order.length) return { list, gone: [] };
  const pos = new Map(order.map((id, i) => [id, i]));
  const first = [];
  const rest = [];
  for (const a of list) (pos.has(a.id) && a.status !== 'ended' ? first : rest).push(a);
  first.sort((x, y) => pos.get(x.id) - pos.get(y.id));
  const gone = order.filter((id) => ended.has(id) || (!present.has(id) && (orcaRead || !id.startsWith('orca:'))));
  // New live rows on top (one that needs you is never buried), then the owner's order, then ended rows.
  const done = rest.filter((a) => a.status === 'ended');
  const fresh = rest.filter((a) => a.status !== 'ended');
  return { list: [...fresh, ...first.map((a) => ({ ...a, ordered: true })), ...done], gone };
}
