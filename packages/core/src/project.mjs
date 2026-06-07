/**
 * Vault projection — render state.db → Obsidian markdown (LLM-owned files).
 *
 * The db is source-of-truth; the vault is a deterministic, idempotent projection
 * for human reading / Obsidian graph view. Files carry `owner: llm` so a future
 * bidirectional sync can distinguish LLM-owned from human-owned notes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frontmatter, nowISO } from './util.mjs';

/**
 * @param {import('./db.mjs').StateDB} db
 * @param {import('./memory.mjs').TieredMemory} memory
 * @param {import('./graph.mjs').GraphStore} graph
 */
export function projectVault(db, memory, graph, cfg) {
  const root = path.join(cfg.vaultPath, cfg.wikiPath);
  const entries = memory.listActive();
  let written = 0;

  // Per-entry pages, grouped by tier.
  for (const e of entries) {
    const dir = path.join(root, e.tier);
    fs.mkdirSync(dir, { recursive: true });
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
    fs.writeFileSync(path.join(dir, `${e.id}.md`), body);
    written++;
  }

  // Concept/entity pages from the graph.
  const g = graph.getGraph();
  if (g.nodes.length) {
    const cdir = path.join(root, 'concepts');
    fs.mkdirSync(cdir, { recursive: true });
    for (const n of g.nodes) {
      const links = graph.neighbors(n.id)
        .map((e) => { const other = e.from === n.id ? e.to : e.from; const o = graph.node(other); return o ? `[[${o.label}]] (${e.type})` : null; })
        .filter(Boolean);
      const body = [
        frontmatter({ id: n.id, type: n.type, label: n.label, owner: 'llm' }),
        '', `# ${n.label}`, '', `Type: ${n.type}`, '',
        links.length ? `## Related\n${links.join('\n')}` : '',
      ].join('\n');
      fs.writeFileSync(path.join(cdir, `${n.label.replace(/[^\w.-]+/g, '_')}.md`), body);
      written++;
    }
  }

  // index.md + log.md
  fs.mkdirSync(root, { recursive: true });
  const byTier = {};
  for (const e of entries) (byTier[e.tier] ||= []).push(e);
  let idx = `# Wiki Index\n\n> Projected from state.db — ${nowISO()}\n> ${entries.length} entries · ${g.nodes.length} graph nodes\n\n`;
  for (const [tier, es] of Object.entries(byTier)) {
    idx += `## ${tier}\n`;
    for (const e of es) idx += `- [[${e.tier}/${e.id}]]: ${e.content.slice(0, 80).replace(/\n/g, ' ')}\n`;
    idx += '\n';
  }
  fs.writeFileSync(path.join(root, 'index.md'), idx);

  const logs = db.prepare('SELECT ts,operation,detail FROM log ORDER BY id DESC LIMIT 50').all();
  let logmd = `# Wiki Log\n\n> Projected from state.db — ${nowISO()}\n\n`;
  for (const l of logs) logmd += `## [${l.ts}] ${l.operation}\n\`\`\`json\n${l.detail}\n\`\`\`\n\n`;
  fs.writeFileSync(path.join(root, 'log.md'), logmd);

  return { written, vaultPath: root };
}
