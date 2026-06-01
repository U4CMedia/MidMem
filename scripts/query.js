#!/usr/bin/env node
/**
 * Query script — search knowledge store
 * 
 * Usage: node scripts/query.js <query> [options]
 * 
 * Options:
 *   --tiers fact,memory,wisdom  Which tiers to search
 *   --limit 20                  Maximum results
 *   --provenance                Include provenance chain
 *   --graph                     Include graph context
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { Orchestrator } from '@openclaw-middleware/orchestrator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Configuration
const CONFIG = {
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || path.join(rootDir, 'wiki'),
  wikiPath: process.env.WIKI_PATH || 'wiki',
  memoryPath: process.env.MEMORY_PATH || path.join(rootDir, 'memory'),
  graphPath: process.env.GRAPH_PATH || path.join(rootDir, 'graph'),
  auditPath: process.env.AUDIT_PATH || path.join(rootDir, 'audit'),
  tiers: ['fact', 'memory', 'wisdom'],
  semanticCache: true,
  semanticCacheTTL: 3600000,
  syncToObsidian: true,
  verifyOnIngest: true,
  sigmaStrictMode: false,
};

// Parse arguments
const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
const tiersArg = args.find(a => a.startsWith('--tiers='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const includeProvenance = args.some(a => a === '--provenance');
const includeGraph = args.some(a => a === '--graph');

if (!query) {
  console.error('Usage: node scripts/query.js <query> [options]');
  process.exit(1);
}

async function main() {
  console.log(`🔍 Querying: "${query}"`);

  const orchestrator = new Orchestrator(CONFIG);

  const result = await orchestrator.query(query, {
    tiers: tiersArg ? tiersArg.split(',') : undefined,
    limit: limitArg ? parseInt(limitArg, 10) : 20,
    includeProvenance,
    includeGraphContext: includeGraph,
  });

  console.log(`\n📊 Results: ${result.results.length} found`);
  console.log(`   Query: ${result.query}`);
  console.log(`   Tiers: ${result.tiers.join(', ')}`);
  console.log(`   Timestamp: ${result.timestamp}`);

  if (result.results.length > 0) {
    console.log('\n📄 Results:');
    for (const r of result.results) {
      console.log(`\n  [${r.tier || 'unknown'}] ${r.source}`);
      console.log(`  Relevance: ${r.relevance}`);
      if (r.provenance) {
        console.log(`  Provenance: ${r.provenance.originalSource}`);
      }
      console.log(`  Content: ${r.content.slice(0, 200)}...`);
    }
  } else {
    console.log('\n  No results found.');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
