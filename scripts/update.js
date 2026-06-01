#!/usr/bin/env node
/**
 * Update script — update wiki pages
 * 
 * Usage: node scripts/update.js <page-path> [--content "new content"]
 * 
 * Updates a wiki page and runs Sigma verifier to check for contradictions.
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
const pagePath = args.find(a => !a.startsWith('--'));
const contentArg = args.find(a => a.startsWith('--content='))?.split('=').slice(1).join('=');

if (!pagePath) {
  console.error('Usage: node scripts/update.js <page-path> [--content "new content"]');
  process.exit(1);
}

async function main() {
  console.log(`📝 Updating: ${pagePath}`);

  const orchestrator = new Orchestrator(CONFIG);

  // Read current content
  let currentContent = '';
  try {
    currentContent = await orchestrator.readPage(pagePath);
    console.log(`   Current content length: ${currentContent.length} chars`);
  } catch {
    console.log('   Page does not exist yet — creating new page');
  }

  // Update content
  const newContent = contentArg || currentContent;
  await orchestrator.writePage(pagePath, newContent);

  // Run verification
  const verification = await orchestrator.lint();
  
  if (verification.contradictions.length > 0) {
    console.log(`\n⚠️  ${verification.contradictions.length} contradictions detected:`);
    for (const conflict of verification.contradictions) {
      console.log(`   - ${conflict.pageA} ↔ ${conflict.pageB}: ${conflict.conflict}`);
    }
  } else {
    console.log('\n✅ Update successful — no contradictions detected');
  }

  // Update index
  await orchestrator.updateIndex();
  console.log('   Index updated');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
