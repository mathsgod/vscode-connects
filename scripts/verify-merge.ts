/**
 * Standalone verification of the merge semantics used by HostStore.
 * This exercises the core dedupe + tombstone + import merge logic
 * without requiring the VS Code runtime.
 *
 * Run: npx ts-node scripts/verify-merge.ts   (or compile then node)
 */

import * as crypto from 'crypto';

// Minimal HostEntry shape (mirrors src/storage.ts)
interface HostEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  keepAlive?: boolean;
  group?: string;
  updatedAt?: number;
}

// --- Core merge helpers (copied/adapted from storage.ts) ---

function getAll(raw: HostEntry[], tombstones: Record<string, number>): HostEntry[] {
  const byId = new Map<string, HostEntry>();
  for (const h of raw) {
    const prev = byId.get(h.id);
    const hTs = h.updatedAt ?? 0;
    if (!prev || hTs > (prev.updatedAt ?? 0)) {
      byId.set(h.id, h);
    }
  }
  const filtered: HostEntry[] = [];
  for (const [id, h] of byId) {
    const tomb = tombstones[id];
    const entryTs = h.updatedAt ?? 0;
    if (tomb && entryTs <= tomb) continue;
    filtered.push(h);
  }
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

function upsertInto(
  raw: HostEntry[],
  tombstones: Record<string, number>,
  entry: HostEntry
): { raw: HostEntry[]; tombstones: Record<string, number> } {
  const now = Date.now();
  const e: HostEntry = { ...entry, updatedAt: now };

  const tombs = { ...tombstones };
  if (tombs[e.id]) delete tombs[e.id];

  const byId = new Map<string, HostEntry>();
  for (const h of raw) {
    const prev = byId.get(h.id);
    const hTs = h.updatedAt ?? 0;
    if (!prev || hTs > (prev.updatedAt ?? 0)) {
      byId.set(h.id, h);
    }
  }
  byId.set(e.id, e);

  const merged = Array.from(byId.values());
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return { raw: merged, tombstones: tombs };
}

function deleteWithTombstone(
  raw: HostEntry[],
  tombstones: Record<string, number>,
  id: string
): { raw: HostEntry[]; tombstones: Record<string, number> } {
  const now = Date.now();
  const tombs = { ...tombstones, [id]: now };
  const pruned = raw.filter((h) => h.id !== id);
  return { raw: pruned, tombstones: tombs };
}

function importFromJsonInto(
  raw: HostEntry[],
  tombstones: Record<string, number>,
  json: string
): { raw: HostEntry[]; tombstones: Record<string, number>; added: number; updated: number; errors: string[] } {
  let parsed: any;
  const errors: string[] = [];
  try { parsed = JSON.parse(json); } catch { return { raw, tombstones, added: 0, updated: 0, errors: ['Invalid JSON'] }; }
  if (!Array.isArray(parsed)) return { raw, tombstones, added: 0, updated: 0, errors: ['Expected array'] };

  const now = Date.now();
  const byId = new Map<string, HostEntry>();
  for (const h of raw) {
    const prev = byId.get(h.id);
    const hTs = h.updatedAt ?? 0;
    if (!prev || hTs > (prev.updatedAt ?? 0)) byId.set(h.id, h);
  }

  let added = 0, updated = 0;
  const tombs = { ...tombstones };

  for (const r of parsed) {
    if (!r || typeof r !== 'object') { errors.push('non-object'); continue; }
    const name = String(r.name || '').trim();
    const host = String(r.host || '').trim();
    if (!name || !host) { errors.push('missing name/host'); continue; }
    const id = (typeof r.id === 'string' && r.id) ? r.id : crypto.randomUUID();
    const importedTs = typeof r.updatedAt === 'number' ? r.updatedAt : undefined;
    const ts = importedTs && importedTs > 0 ? importedTs : now;
    const entry: HostEntry = {
      id, name, host,
      port: Number(r.port) || 22,
      username: r.username ? String(r.username).trim() || undefined : undefined,
      password: r.password ? String(r.password) : undefined,
      privateKey: r.privateKey ? String(r.privateKey) : undefined,
      passphrase: r.passphrase ? String(r.passphrase) : undefined,
      keepAlive: !!r.keepAlive,
      group: r.group ? String(r.group).trim() || undefined : undefined,
      updatedAt: ts,
    };
    const prev = byId.get(id);
    const prevTs = prev?.updatedAt ?? 0;
    if (tombs[id]) delete tombs[id];
    if (prev) {
      if (ts >= prevTs) { byId.set(id, entry); updated++; }
    } else {
      byId.set(id, entry); added++;
    }
  }

  const merged = Array.from(byId.values());
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return { raw: merged, tombstones: tombs, added, updated, errors };
}

// --- Test scenarios ---

function assert(cond: any, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else { console.log('PASS:', msg); }
}

function run() {
  console.log('=== Merge semantics verification ===\n');

  // 1) Basic upsert preserves unrelated records (the key "merge" requirement)
  let raw: HostEntry[] = [
    { id: 'A', name: 'Alpha', host: 'a.example.com', port: 22, updatedAt: 100 },
    { id: 'B', name: 'Bravo', host: 'b.example.com', port: 22, updatedAt: 200 },
  ];
  let tombs: Record<string, number> = {};
  const res1 = upsertInto(raw, tombs, { id: 'C', name: 'Charlie', host: 'c.example.com', port: 22 });
  raw = res1.raw; tombs = res1.tombstones;
  const all1 = getAll(raw, tombs);
  assert(all1.length === 3, 'upsert adds without dropping existing');
  assert(all1.some(h => h.id === 'A'), 'Alpha still present after adding Charlie');
  assert(all1.some(h => h.id === 'B'), 'Bravo still present after adding Charlie');

  // 2) Delete uses tombstone; older copy arriving later is suppressed
  const res2 = deleteWithTombstone(raw, tombs, 'B');
  raw = res2.raw; tombs = res2.tombstones;
  const all2 = getAll(raw, tombs);
  assert(all2.length === 2, 'after delete, only 2 visible (A,C)');
  assert(!all2.some(h => h.id === 'B'), 'Bravo is gone after delete');

  // Simulate a stale copy of Bravo arriving via sync (older timestamp)
  raw = [...raw, { id: 'B', name: 'Bravo', host: 'b.example.com', port: 22, updatedAt: 150 }];
  const all2b = getAll(raw, tombs);
  assert(all2b.length === 2 && !all2b.some(h => h.id === 'B'), 'stale Bravo (ts 150) suppressed by tomb (ts ~now)');

  // 3) Export includes updatedAt; import roundtrip preserves it and merges
  const exported = JSON.stringify(getAll(raw, tombs), null, 2);
  assert(exported.includes('"updatedAt"'), 'export includes updatedAt');

  // Import a newer copy of Alpha and a brand new Delta
  const importJson = JSON.stringify([
    { id: 'A', name: 'Alpha', host: 'a.example.com', port: 22, updatedAt: 999999 },
    { id: 'D', name: 'Delta', host: 'd.example.com', port: 22, updatedAt: 500 },
  ]);
  const res3 = importFromJsonInto(raw, tombs, importJson);
  raw = res3.raw; tombs = res3.tombstones;
  const all3 = getAll(raw, tombs);
  const alpha = all3.find(h => h.id === 'A')!;
  assert(alpha && (alpha.updatedAt ?? 0) >= 999999, 'import newer Alpha wins');
  assert(all3.some(h => h.id === 'D'), 'Delta imported');
  assert(all3.some(h => h.id === 'C'), 'Charlie (untouched) survives import');

  // 4) Import older copy does not regress a newer local record
  const importOldAlpha = JSON.stringify([
    { id: 'A', name: 'Alpha', host: 'a.example.com', port: 22, updatedAt: 10 },
  ]);
  const before = getAll(raw, tombs).find(h => h.id === 'A')!.updatedAt ?? 0;
  const res4 = importFromJsonInto(raw, tombs, importOldAlpha);
  raw = res4.raw; tombs = res4.tombstones;
  const after = getAll(raw, tombs).find(h => h.id === 'A')!.updatedAt ?? 0;
  assert(after === before, 'older import does not regress newer local Alpha');

  // 5) Tombstone wins over an imported update with older timestamp
  const res5 = deleteWithTombstone(raw, tombs, 'D');
  raw = res5.raw; tombs = res5.tombstones;
  const importOldD = JSON.stringify([{ id: 'D', name: 'Delta', host: 'd.example.com', port: 22, updatedAt: 1 }]);
  const res6 = importFromJsonInto(raw, tombs, importOldD);
  raw = res6.raw; tombs = res6.tombstones;
  const visibleD = getAll(raw, tombs).some(h => h.id === 'D');
  assert(!visibleD, 'tombstone suppresses older imported Delta');

  // 6) Import of a newer Delta clears the tombstone and revives it
  const importNewD = JSON.stringify([{ id: 'D', name: 'Delta', host: 'd.example.com', port: 22, updatedAt: Date.now() + 10000 }]);
  const res7 = importFromJsonInto(raw, tombs, importNewD);
  raw = res7.raw; tombs = res7.tombstones;
  const visibleD2 = getAll(raw, tombs).some(h => h.id === 'D');
  assert(visibleD2, 'newer import after tombstone revives Delta');

  console.log('\n=== All checks completed ===');
}

run();
