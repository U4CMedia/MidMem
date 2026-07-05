/**
 * Shared types for the middleware orchestrator
 */

// Re-export TierConfig from tiered-memory to avoid duplication
export type { TierConfig } from '@openclaw-middleware/tiered-memory';

/**
 * Middleware configuration
 */
export interface MiddlewareConfig {
  /** Path to the Obsidian vault */
  obsidianVaultPath: string;
  /** Path to the wiki directory within the vault */
  wikiPath: string;
  /** Path to the memory directory */
  memoryPath: string;
  /** Path to the knowledge graph */
  graphPath: string;
  /** Path to the audit directory */
  auditPath: string;
  /** Knowledge tiers (default: fact → memory → wisdom) */
  tiers?: string[];
  /** Enable semantic cache (default: true) */
  semanticCache?: boolean;
  /** Semantic cache TTL in ms (default: 3600000 = 1 hour) */
  semanticCacheTTL?: number;
  /** Sync memory changes back to Obsidian (default: true) */
  syncToObsidian?: boolean;
  /** Verify on ingest (default: true) */
  verifyOnIngest?: boolean;
  /** Sigma verifier strict mode (default: false) */
  sigmaStrictMode?: boolean;
  /** LM Studio endpoint for embeddings (default: http://localhost:1234/v1) */
  llmEndpoint?: string;
  /** LM Studio model for embeddings (default: nomic-embed-text) */
  llmModel?: string;
  /** SQLite FTS database path (default: :memory:) */
  ftsDbPath?: string;
  /** Claim store path (default: graphPath/claims) */
  claimsPath?: string;
}

/**
 * Result of an ingest operation
 */
export interface IngestResult {
  success: boolean;
  concepts: Array<{ name: string; type: string; confidence: number }>;
  tieredResult: { tier: string; entryId: string; timestamp: string };
  verification: VerifyResult | null;
  logEntry: {
    timestamp: string;
    operation: string;
    source: { path: string; type: string; title?: string };
    conceptsExtracted: number;
    tieredStored: string;
    contradictionsFound: number;
  };
}

/**
 * Result of a query operation
 */
export interface QueryResult {
  results: Array<{
    content: string;
    source: string;
    relevance: number;
    tier?: string;
    provenance?: {
      originalSource: string;
      extractedAt: string;
      chain: Array<{ step: string; source: string }>;
    };
  }>;
  graphContext: {
    nodes: Array<{ id: string; label: string; type: string }>;
    edges: Array<{ from: string; to: string; type: string }>;
  } | null;
  tiers: string[];
  query: string;
  timestamp: string;
}

/**
 * Result of a verification operation
 */
export interface VerifyResult {
  conflicts: Array<{
    pageA: string;
    pageB: string;
    conflict: string;
    severity: 'low' | 'medium' | 'high';
    proof: string;
  }>;
  verified: boolean;
  timestamp: string;
}

/**
 * Configuration for the tiered memory model
 */
export interface TierConfig {
  /** Tier name */
  name: string;
  /** Tier description */
  description: string;
  /** Default TTL in ms (0 = no expiry) */
  ttl?: number;
  /** Auto-promote to next tier after TTL */
  autoPromote?: boolean;
}
