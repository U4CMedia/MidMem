#!/usr/bin/env node
/**
 * Lint script — wiki health check
 * 
 * Usage: node scripts/lint.js
 * 
 * Runs a comprehensive health check on the wiki:
 * - Detects orphan pages (no inbound links)
 * - Detects contradictions between pages
 * - Finds stale claims
 * - Finds missing references
 * - Reports wiki statistics
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

async function main() {
  console.log('🔍 Running wiki health check...\n');

  const orchestrator = new Orchestrator(CONFIG);
  const result = await orchestrator.lint();

  // Report statistics
  console.log('📊 Wiki Statistics:');
  console.log(`   Total pages: ${result.summary.totalPages}`);
  console.log(`   Total links: ${result.summary.totalLinks}`);
  console.log(`   Avg links per page: ${result.summary.avgLinksPerPage.toFixed(1)}`);

  // Report orphans
  console.log(`\n📄 Orphan Pages (${result.orphans.length}):`);
  if (result.orphans.length > 0) {
    for (const orphan of result.orphans) {
      console.log(`   - ${orphan}`);
    }
  } else {
    console.log('   None — all pages have inbound links');
  }

  // Report contradictions
  console.log(`\n⚠️  Contradictions (${result.contradictions.length}):`);
  if (result.contradictions.length > 0) {
    for (const conflict of result.contradictions) {
      console.log(`   [${conflict.severity.toUpperCase()}] ${conflict.pageA} ↔ ${conflict.pageB}`);
      console.log(`      ${conflict.conflict}`);
    }
  } else {
    console.log('   None — no contradictions detected');
  }

  // Report stale claims
  console.log(`\n🕰️  Stale Claims (${result.staleClaims.length}):`);
  if (result.staleClaims.length > 0) {
    for (const stale of result.staleClaims) {
      console.log(`   [${stale.severity.toUpperCase()}] ${stale.claim}`);
      console.log(`      Superseded by: ${stale.supersededBy}`);
    }
  } else {
    console.log('   None — no stale claims detected');
  }

  // Report missing references
  console.log(`\n🔗 Missing References (${result.missingReferences.length}):`);
  if (result.missingReferences.length > 0) {
    for (const missing of result.missingReferences) {
      console.log(`   ${missing.page} → ${missing.missing}`);
    }
  } else {
    console.log('   None — all references resolve');
  }

  console.log('\n✅ Health check complete');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
