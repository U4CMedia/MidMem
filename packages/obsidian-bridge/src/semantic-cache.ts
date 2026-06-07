/**
 * SemanticCache — LM Studio integration for concept deduplication
 * 
 * Vanilla approach: uses LM Studio's local API for embedding-based
 * semantic cache. No external vector DB dependency.
 * 
 * Provides:
 * - Embedding generation via LM Studio
 * - Cosine similarity search
 * - TTL-based cache expiration
 * - Configurable similarity threshold
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface SemanticCacheConfig {
  llmEndpoint: string;
  llmModel: string;
  similarityThreshold?: number;
  cacheDir: string;
  maxEntries?: number;
}

interface CacheEntry {
  key: string;
  hash: string;
  embedding: number[];
  value: string;
  timestamp: number;
}

/**
 * Semantic cache with LM Studio embeddings
 */
export class SemanticCache {
  private config: SemanticCacheConfig;
  private cache: Map<string, CacheEntry>;
  private loaded: boolean = false;
  private index: Map<string, string> = new Map(); // simple hash→key index for O(1) lookup

  constructor(config: SemanticCacheConfig) {
    this.config = {
      ...config,
      similarityThreshold: config.similarityThreshold ?? 0.85,
      maxEntries: config.maxEntries ?? 1000,
    };
    this.cache = new Map();
  }

  /**
   * Load cache from disk
   */
  async load(): Promise<void> {
    const cacheFile = path.join(this.config.cacheDir, 'cache.json');
    try {
      const content = await fs.readFile(cacheFile, 'utf-8');
      const entries = JSON.parse(content) as CacheEntry[];
      this.cache = new Map(entries.map(e => [e.key, e]));
      this.loaded = true;
    } catch {
      // Cache doesn't exist yet
      this.cache = new Map();
      this.loaded = true;
    }
  }

  /**
   * Save cache to disk
   */
  async save(): Promise<void> {
    await fs.mkdir(this.config.cacheDir, { recursive: true });
    const cacheFile = path.join(this.config.cacheDir, 'cache.json');
    await fs.writeFile(cacheFile, JSON.stringify(Array.from(this.cache.values()), null, 2));
  }

  /**
   * Get cached value for a key
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL (default 1 hour)
    const ttl = this.config.maxEntries ? 3600000 : 3600000; // 1 hour
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Get similar entries for a key
   * Uses hash index for quick candidate selection, then computes similarity
   */
  async getSimilar(key: string, limit: number = 5): Promise<Array<{ key: string; value: string; similarity: number }>> {
    const keyEmbedding = await this.getEmbedding(key);
    if (!keyEmbedding) return [];

    const keyHash = this.simpleHash(key);
    const candidates = new Set<string>();

    // Use index for O(1) candidate selection
    candidates.add(keyHash);
    for (const idxKey of this.index.keys()) {
      if (idxKey.startsWith(keyHash.slice(0, 4))) {
        candidates.add(this.index.get(idxKey)!);
      }
    }

    const results: Array<{ key: string; value: string; similarity: number }> = [];

    for (const candidateKey of candidates) {
      const entry = this.cache.get(candidateKey);
      if (!entry || entry.embedding.length === 0) continue;
      const similarity = this.cosineSimilarity(keyEmbedding, entry.embedding);
      if (similarity >= this.config.similarityThreshold) {
        results.push({ key: candidateKey, value: entry.value, similarity });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Set a cache entry
   */
  async set(key: string, value: string): Promise<void> {
    const hash = this.simpleHash(key);
    const embedding = await this.getEmbedding(key);

    if (!embedding) {
      // Fallback: store without embedding
      this.cache.set(key, {
        key,
        hash,
        embedding: [],
        value,
        timestamp: Date.now(),
      });
      this.index.set(key, key);
      return;
    }

    // Evict oldest entries if over max
    if (this.cache.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(key, {
      key,
      hash,
      embedding,
      value,
      timestamp: Date.now(),
    });
    this.index.set(key, key);
  }

  /**
   * Delete a cache entry
   */
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.index.delete(key);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; entries: number; oldest: string; newest: string } {
    const entries = Array.from(this.cache.values());
    const timestamps = entries.map(e => e.timestamp);
    const oldest = new Date(Math.min(...timestamps)).toISOString();
    const newest = new Date(Math.max(...timestamps)).toISOString();

    return {
      size: entries.length,
      entries: entries.length,
      oldest,
      newest,
    };
  }

  /**
   * Get an embedding from LM Studio
   */
  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const response = await fetch(`${this.config.llmEndpoint}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.llmModel,
          input: text,
        }),
      });

      if (!response.ok) return null;

      const data = await response.json();
      return data.data?.[0]?.embedding || null;
    } catch {
      // LM Studio not available, return null
      return null;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Simple hash function
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Evict oldest entries
   */
  private evictOldest(): void {
    const entries = Array.from(this.cache.values());
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // Remove oldest 10%
    const evictCount = Math.floor(entries.length * 0.1);
    for (let i = 0; i < evictCount; i++) {
      this.cache.delete(entries[i].key);
    }
  }
}
