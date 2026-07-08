/**
 * Vault projection — render state.db → Obsidian markdown (LLM-owned files).
 *
 * The db is source-of-truth; the vault is a deterministic, idempotent projection
 * for human reading / Obsidian graph view. Files carry `owner: llm` so a future
 * bidirectional sync can distinguish LLM-owned from human-owned notes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frontmatter, nowISO, canonicalConceptKey } from './util.mjs';

/** A projection pass must survive any single bad page — the vault sits on a network share
 *  where one entry can be individually broken (e.g. a server-corrupt CIFS name that EACCESes
 *  every open while the rest of the dir works). Collect a capped sample of per-file failures
 *  and keep writing; the caller reports them. */
const MAX_ERROR_SAMPLE = 8;
function safeWrite(file, body, state) {
  try { fs.writeFileSync(file, body); return true; }
  catch (e) {
    state.failed++;
    if (state.errors.length < MAX_ERROR_SAMPLE) state.errors.push(`${path.basename(file)}: ${e.code || e.message}`);
    return false;
  }
}

/** Remove stale projected pages: any .md in `dir` not in `keep`. The projection owns these
 *  dirs outright (owner: llm), so a page with no live backing row is stale by definition —
 *  without this, archived/expired entries stay visible in the vault forever. */
function pruneDir(dir, keep) {
  let pruned = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if (!f.endsWith('.md') || keep.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); pruned++; } catch { /* share hiccup — next pass */ }
  }
  return pruned;
}

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./graph.mjs').GraphStore} graph
 */
export function projectVault(db, memory, graph, cfg) {
  const root = path.join(cfg.vaultPath, cfg.wikiPath);
  // Root must exist before anything else — if THIS fails the vault is gone (unmounted share),
  // which is a whole-projection failure and should throw as before.
  fs.mkdirSync(root, { recursive: true });
  const entries = memory.listActive();
  let written = 0;
  let pruned = 0;
  const state = { failed: 0, errors: [] };
  const keepByDir = new Map(); // dir → Set of filenames that belong in this projection

  // Per-entry pages, grouped by tier.
  for (const e of entries) {
    const dir = path.join(root, e.tier);
    fs.mkdirSync(dir, { recursive: true });
    if (!keepByDir.has(dir)) keepByDir.set(dir, new Set());
    keepByDir.get(dir).add(`${e.id}.md`);
    const concepts = (e.concepts || []).map((c) => `[[${c.name}]]`);
    const fm = frontmatter({
      id: e.id, tier: e.tier, type: e.type, status: e.status,
      created: e.created_at, updated: e.updated_at, owner: 'llm',
      source: e.source_id || undefined,
    });
    const body = [
      fm, '', `# ${e.type}: ${e.id}`, '', e.content, '',
      concepts.length ? `## Concepts\n${concepts.join(' · ')}` : '',
      e.provenance ? `\n## Provenance\n\`\`\`json\n${JSON.stringify(e.provenance, null, 2)}\n\`\`\`` : '',
    ].join('\n');
    if (safeWrite(path.join(dir, `${e.id}.md`), body, state)) written++;
  }

  // Concept/entity pages from the graph. Filenames come from the CANONICAL key, not the raw
  // label — the vault share is case-insensitive, so case-variant labels used to collapse into
  // one file nondeterministically; the canonical (lowercase) slug makes the collision impossible.
  const g = graph.getGraph();
  if (g.nodes.length) {
    const cdir = path.join(root, 'concepts');
    fs.mkdirSync(cdir, { recursive: true });
    const ckeep = new Set();
    keepByDir.set(cdir, ckeep);
    for (const n of g.nodes) {
      const links = graph.neighbors(n.id)
        .map((e) => { const other = e.from === n.id ? e.to : e.from; const o = graph.node(other); return o ? `[[${o.label}]] (${e.type})` : null; })
        .filter(Boolean);
      const body = [
        frontmatter({ id: n.id, type: n.type, label: n.label, owner: 'llm' }),
        '', `# ${n.label}`, '', `Type: ${n.type}`, '',
        links.length ? `## Related\n${links.join('\n')}` : '',
      ].join('\n');
      const fname = `${(canonicalConceptKey(n.label) || n.id).replace(/[^\w.-]+/g, '_')}.md`;
      if (safeWrite(path.join(cdir, fname), body, state)) written++;
      ckeep.add(fname); // keep even on failure — a half-broken name must not get pruned into worse state
    }
  }

  // Prune pages whose backing row is gone (archived/expired/merged) from the dirs we own.
  for (const [dir, keep] of keepByDir) pruned += pruneDir(dir, keep);
  // A tier dir can also empty out entirely (everything expired) — sweep known tier dirs too.
  for (const t of memory.tierNames) {
    const dir = path.join(root, t);
    if (!keepByDir.has(dir)) pruned += pruneDir(dir, new Set());
  }

  // index.md + log.md
  const byTier = {};
  for (const e of entries) (byTier[e.tier] ||= []).push(e);
  let idx = `# Wiki Index\n\n> Projected from state.db — ${nowISO()}\n> ${entries.length} entries · ${g.nodes.length} graph nodes\n\n`;
  for (const [tier, es] of Object.entries(byTier)) {
    idx += `## ${tier}\n`;
    for (const e of es) idx += `- [[${e.tier}/${e.id}]]: ${e.content.slice(0, 80).replace(/\n/g, ' ')}\n`;
    idx += '\n';
  }
  if (safeWrite(path.join(root, 'index.md'), idx, state)) written++;

  const logs = db.prepare('SELECT ts,operation,detail FROM log ORDER BY id DESC LIMIT 50').all();
  let logmd = `# Wiki Log\n\n> Projected from state.db — ${nowISO()}\n\n`;
  for (const l of logs) logmd += `## [${l.ts}] ${l.operation}\n\`\`\`json\n${l.detail}\n\`\`\`\n\n`;
  if (safeWrite(path.join(root, 'log.md'), logmd, state)) written++;

  return { written, pruned, failed: state.failed, errors: state.errors, vaultPath: root };
}
