/**
 * Orchestrator — the glue that coordinates all middleware packages
 * 
 * Manages the ingest → compile → query → verify → store pipeline
 * that bridges OpenClaw/Hermes with the knowledge store.
 */

import * as path from 'path';
import { ObsidianBridge, type ObsidianConfig } from '@openclaw-middleware/obsidian-bridge';
import { TieredMemory, type TierConfig } from '@openclaw-middleware/tiered-memory';
import { SigmaVerifier, type SigmaConfig } from '@openclaw-middleware/sigma-verifier';
import type { 
  IngestResult, 
  QueryResult, 
  VerifyResult, 
  MiddlewareConfig 
} from './types.js';
import { SQLiteFTS } from '@openclaw-middleware/tiered-memory';
import { TypedKnowledgeGraph } from '@openclaw-middleware/tiered-memory';
import { ClaimStore } from '@openclaw-middleware/tiered-memory';

/**
 * The orchestrator pipeline
 */
export class Orchestrator {
  private obsidian: ObsidianBridge;
  private tieredMemory: TieredMemory;
  private sigmaVerifier: SigmaVerifier;
  private fts: SQLiteFTS;
  private graph: TypedKnowledgeGraph;
  private claimStore: ClaimStore;
  private config: MiddlewareConfig;

  constructor(config: MiddlewareConfig) {
    this.config = config;
    
    // Initialize Obsidian bridge
    this.obsidian = new ObsidianBridge({
      vaultPath: config.obsidianVaultPath,
      wikiPath: config.wikiPath,
      semanticCache: config.semanticCache ?? true,
      cacheTTL: config.semanticCacheTTL ?? 3600000, // 1 hour default
      llmEndpoint: config.llmEndpoint || 'http://localhost:1234/v1',
      llmModel: config.llmModel || 'nomic-embed-text',
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

    // Initialize SQLite FTS engine
    this.fts = new SQLiteFTS({
      dbPath: config.ftsDbPath || ':memory:',
    });

    // Initialize typed knowledge graph
    this.graph = new TypedKnowledgeGraph({
      graphPath: config.graphPath,
    });

    // Initialize claim store
    this.claimStore = new ClaimStore({
      claimsPath: config.claimsPath || path.join(config.graphPath, 'claims'),
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
   * Uses SQLite FTS for fast search, falls back to tiered memory
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

    let results: QueryResult['results'] = [];

    // Step 1: Search via SQLite FTS (fast, indexed)
    let ftsFailed = false;
    try {
      const ftsResults = this.fts.search({ query: question, tiers, limit });
      results = ftsResults.map(r => ({
        content: r.content,
        source: r.source || r.entryId,
        relevance: r.relevance,
        tier: r.tier,
        provenance: includeProvenance ? { originalSource: r.source || '', extractedAt: r.createdAt, chain: [] } : undefined,
      }));
    } catch (err) {
      // FTS not available, fall through to tiered memory
      ftsFailed = true;
    }

    // Step 2: If FTS failed or returned nothing, use tiered memory search
    if (ftsFailed || results.length === 0) {

    // Step 2: If FTS returned nothing, use tiered memory search
    if (results.length === 0) {
      const memoryResults = await this.tieredMemory.search(question, {
        tiers,
        limit,
        includeProvenance,
      });
      results = memoryResults;
    }

    // Step 3: Get graph context if requested
    let graphContext = null;
    if (includeGraphContext) {
      graphContext = await this.graph.getGraph();
    }

    // Step 4: Check wiki index for relevant pages
    const wikiPages = await this.obsidian.searchWiki(question, { limit: Math.max(5, Math.floor(limit / 2)) });
    results = [...results, ...wikiPages];

    return {
      results,
      graphContext,
      tiers: tiers,
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
      memoryStats: { totalEntries: Object.values(tierStats).reduce((s, t) => s + t.count, 0), tierBreakdown: tierStats },
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

  /**
   * Sync wiki changes to Obsidian vault
   */
  async syncToVault(): Promise<{ synced: number; errors: string[] }> {
    return this.obsidian.syncToVault();
  }

  /**
   * Sync Obsidian vault changes back to wiki
   */
  async syncFromVault(): Promise<{ synced: number; errors: string[] }> {
    return this.obsidian.syncFromVault();
  }

  /**
   * Add a claim with provenance
   */
  async addClaim(claim: Omit<import('@openclaw-middleware/tiered-memory/dist/claims.js').Claim, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<import('@openclaw-middleware/tiered-memory/dist/claims.js').Claim> {
    return this.claimStore.add(claim);
  }

  /**
   * Search claims
   */
  async searchClaims(query: string, options?: {
    types?: string[];
    statuses?: string[];
    limit?: number;
  }): Promise<Array<{ id: string; content: string; type: string; source: string; status: string }>> {
    const claims = await this.claimStore.search(query, options);
    return claims.map(c => ({ id: c.id, content: c.content, type: c.type, source: c.source.path, status: c.status }));
  }

  /**
   * Get graph for visualization
   */
  async getGraph(): Promise<{ nodes: Array<{ id: string; label: string; type: string }>; edges: Array<{ from: string; to: string; type: string }> }> {
    return this.graph.getGraph();
  }

  /**
   * Get claim statistics
   */
  async getClaimStats(): Promise<{ total: number; byType: Record<string, number>; byStatus: Record<string, number>; recent: Array<{ date: string; count: number }> }> {
    return this.claimStore.getStats();
  }

  /**
   * Get FTS stats
   */
  getFTSStats(): Record<string, number> {
    return this.fts.getStats();
  }
}

export type { IngestResult, QueryResult, VerifyResult, MiddlewareConfig } from './types.js';
