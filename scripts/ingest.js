#!/usr/bin/env node
/**
 * Ingest script — idempotent source ingestion
 * 
 * Usage: node scripts/ingest.js <source-path> [--type article|paper|transcript|note|code|other]
 * 
 * Processes a source document through the middleware pipeline:
 * 1. Extract concepts via Obsidian bridge
 * 2. Verify with Sigma verifier
 * 3. Store in tiered memory
 * 4. Update wiki index and log
 */

import * as fs from 'fs/promises';
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
const sourcePath = args.find(a => !a.startsWith('--'));
const typeArg = args.find(a => a.startsWith('--type='))?.split('=')[1] || 'note';
const type = typeArg || 'note';

if (!sourcePath) {
  console.error('Usage: node scripts/ingest.js <source-path> [--type article|paper|transcript|note|code|other]');
  process.exit(1);
}

async function main() {
  console.log(`📥 Ingesting: ${sourcePath}`);
  console.log(`   Type: ${type}`);

  // Resolve source path
  const resolvedPath = path.isAbsolute(sourcePath) ? sourcePath : path.join(rootDir, sourcePath);

  // Check if source exists
  try {
    await fs.access(resolvedPath);
  } catch {
    console.error(`❌ Source not found: ${resolvedPath}`);
    process.exit(1);
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(CONFIG);

  // Ingest the source
  const result = await orchestrator.ingest({
    path: resolvedPath,
    type: type,
    title: path.basename(resolvedPath),
  });

  if (result.success) {
    console.log('✅ Ingest successful');
    console.log(`   Concepts extracted: ${result.conceptsExtracted}`);
    console.log(`   Tier: ${result.tieredResult.tier}`);
    console.log(`   Entry ID: ${result.tieredResult.entryId}`);
    if (result.verification && result.verification.conflicts.length > 0) {
      console.log(`   ⚠️  Contradictions found: ${result.verification.conflicts.length}`);
      for (const conflict of result.verification.conflicts) {
        console.log(`      - ${conflict.pageA} ↔ ${conflict.pageB}: ${conflict.conflict}`);
      }
    }
  } else {
    console.error('❌ Ingest failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
