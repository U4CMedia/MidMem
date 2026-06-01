/**
 * Orchestrator — the glue that coordinates all middleware packages
 * 
 * Manages the ingest → compile → query → verify → store pipeline
 * that bridges OpenClaw/Hermes with the knowledge store.
 */

import { ObsidianBridge, type ObsidianConfig } from '@openclaw-middleware/obsidian-bridge';
import { TieredMemory, type TierConfig } from '@openclaw-middleware/tiered-memory';
import { SigmaVerifier, type SigmaConfig } from '@openclaw-middleware/sigma-verifier';
import type { 
  IngestResult, 
  QueryResult, 
  VerifyResult, 
  MiddlewareConfig 
} from './types.js';

/**
 * The orchestrator pipeline
 */
export class Orchestrator {
  private obsidian: ObsidianBridge;
  private tieredMemory: TieredMemory;
  private sigmaVerifier: SigmaVerifier;
  private config: MiddlewareConfig;

  constructor(config: MiddlewareConfig) {
    this.config = config;
    
    // Initialize Obsidian bridge
    this.obsidian = new ObsidianBridge({
      vaultPath: config.obsidianVaultPath,
      wikiPath: config.wikiPath,
      semanticCache: config.semanticCache ?? true,
      cacheTTL: config.semanticCacheTTL ?? 3600000, // 1 hour default
    });

    // Initialize tiered memory
    this.tieredMemory = new TieredMemory({
      tiers: config.tiers ?? ['fact', 'memory', 'wisdom'],
      memoryPath: config.memoryPath,
      syncToObsidian: config.syncToObsidian ?? true,
    });

    // Initialize sigma verifier
    this.sigmaVerifier = new SigmaVerifier({
      graphPath: config.graphPath,
      auditPath: config.auditPath,
      strictMode: config.sigmaStrictMode ?? false,
    });
  }

  /**
   * Ingest a new source document
   */
  async ingest(source: {
    path: string;
    type: 'article' | 'paper' | 'transcript' | 'note' | 'code' | 'other';
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IngestResult> {
    const { path, type, title, metadata } = source;

    // Step 1: Extract concepts via Obsidian bridge
    const extraction = await this.obsidian.extractConcepts(path, type);

    // Step 2: Check for contradictions with existing wiki
    let verification: VerifyResult | null = null;
    if (this.config.verifyOnIngest !== false) {
      verification = await this.sigmaVerifier.verify(extraction.concepts);
    }

    // Step 3: Store in tiered memory
    const tieredResult = await this.tieredMemory.store({
      content: extraction.summary,
      type: 'ingest',
      source: { path, type, title, metadata },
      concepts: extraction.concepts,
      tier: 'memory', // Default to memory tier; wisdom requires manual curation
    });

    // Step 4: Update wiki index and log
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation: 'ingest',
      source: { path, type, title },
      conceptsExtracted: extraction.concepts.length,
      tieredStored: tieredResult.tier,
      contradictionsFound: verification?.conflicts.length ?? 0,
    };

    await this.obsidian.appendLog(logEntry);
    await this.obsidian.updateIndex();

    return {
      success: true,
      concepts: extraction.concepts,
      tieredResult,
      verification,
      logEntry,
    };
  }

  /**
   * Query the knowledge store with provenance
   */
  async query(
    question: string,
    options?: {
      tiers?: string[];
      limit?: number;
      includeProvenance?: boolean;
      includeGraphContext?: boolean;
    }
  ): Promise<QueryResult> {
    const {
      tiers = ['fact', 'memory', 'wisdom'],
      limit = 20,
      includeProvenance = true,
      includeGraphContext = false,
    } = options ?? {};

    // Step 1: Search tiered memory
    const memoryResults = await this.tieredMemory.search(question, {
      tiers,
      limit,
      includeProvenance,
    });

    // Step 2: Get graph context if requested
    let graphContext = null;
    if (includeGraphContext) {
      graphContext = await this.sigmaVerifier.getGraphContext(question);
    }

    // Step 3: Check wiki index for relevant pages
    const wikiPages = await this.obsidian.searchWiki(question, { limit: limit / 2 });

    return {
      results: [...memoryResults, ...wikiPages],
      graphContext,
      tiers: memoryResults.map(r => r.tier),
      query: question,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run the lint/health check on the wiki
   */
  async lint(): Promise<{
    orphans: string[];
    contradictions: VerifyResult['conflicts'];
    staleClaims: Array<{ page: string; claim: string; supersededBy: string }>;
    missingReferences: Array<{ page: string; missing: string }>;
    summary: { totalPages: number; totalLinks: number; avgLinksPerPage: number };
  }> {
    const [orphans, wikiSummary] = await this.obsidian.checkOrphans();
    const contradictions = await this.sigmaVerifier.detectConflicts();

    // Find stale claims (claims that newer sources contradict)
    const staleClaims = await this.sigmaVerifier.findStaleClaims();

    // Find missing references (pages that reference non-existent pages)
    const missingReferences = await this.obsidian.findMissingReferences();

    return {
      orphans,
      contradictions,
      staleClaims,
      missingReferences,
      summary: wikiSummary,
    };
  }

  /**
   * Get a brief summary of current knowledge state
   */
  async brief(): Promise<{
    tiers: Record<string, { count: number; lastUpdated: string }>;
    wikiStats: { totalPages: number; totalLinks: number };
    memoryStats: { totalEntries: number; tierBreakdown: Record<string, number> };
    recentActivity: Array<{ timestamp: string; operation: string; summary: string }>;
  }> {
    const tierStats = await this.tieredMemory.getStats();
    const wikiStats = await this.obsidian.getStats();
    const recentActivity = await this.obsidian.getRecentActivity(10);

    return {
      tiers: tierStats,
      wikiStats,
      memoryStats: memoryStats,
      recentActivity,
    };
  }

  /**
   * Forget/remove a memory entry
   */
  async forget(
    entryId: string,
    options?: { softDelete?: boolean; cascade?: boolean }
  ): Promise<{ success: boolean; message: string }> {
    const { softDelete = true, cascade = false } = options ?? {};
    return this.tieredMemory.forget(entryId, { softDelete, cascade });
  }

  /**
   * Archive old memories
   */
  async archive(options?: {
    olderThan?: number; // milliseconds
    tiers?: string[];
  }): Promise<{ archived: number; message: string }> {
    return this.tieredMemory.archive(options);
  }
}

export type { IngestResult, QueryResult, VerifyResult, MiddlewareConfig } from './types.js';
