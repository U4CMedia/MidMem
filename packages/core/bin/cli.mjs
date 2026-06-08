#!/usr/bin/env node
/** ocmw — middleware CLI. Replaces the scaffold's disconnected scripts/. */
import { Orchestrator } from '../src/index.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]; flags[k] = v; }
  else pos.push(rest[i]);
}
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const o = new Orchestrator();
try {
  switch (cmd) {
    case 'init': out({ db: o.cfg.dbPath, vault: o.cfg.vaultPath, tiers: o.memory.tierNames }); break;
    case 'ingest': out(await o.ingest({ path: pos[0], type: flags.type || 'note', title: flags.title, scope: flags.scope, curated: !!flags.curated })); break;
    case 'remember': out(await o.storeMemory({ content: pos.join(' '), tier: flags.tier || 'memory', type: flags.type || 'insight', scope: flags.scope, curated: !!flags.curated })); break;
    case 'query': out(await o.query(pos.join(' '), { tiers: flags.tiers?.split(','), scopes: flags.scopes?.split(','), limit: Number(flags.limit) || 20, includeGraphContext: !!flags.graph })); break;
    case 'bridge': { const { bridgeMemory } = await import('../src/bridge.mjs'); out(await bridgeMemory(o)); break; }
    case 'handoff': out(await o.handoffBrief({ task: pos.join(' '), profile: flags.profile || 'local', scopes: flags.scopes?.split(','), tiers: flags.tiers?.split(',') })); break;
    case 'recall': out(o.recall(pos[0])); break;
    case 'brief': out(o.brief()); break;
    case 'lint': out(o.lint()); break;
    case 'project': out(o.project()); break;
    case 'promote': out(await o.promote(pos[0], pos[1], { curated: !!flags.curated })); break;
    default:
      out('Usage: ocmw <init|ingest <path>|remember <text>|query <text>|recall <id>|brief|lint|project|promote <id> <tier>|bridge|handoff <task>> [--type --title --tier --tiers --scope --scopes --limit --graph --curated --profile local|frontier]');
  }
} catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
finally { o.close(); }
