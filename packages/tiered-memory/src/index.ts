/**
 * TieredMemory — Core-LLM-Wiki-inspired tiered memory model
 * 
 * Manages knowledge across configurable tiers:
 *   Fact (raw) → Memory (synthesized) → Wisdom (curated)
 * 
 * Each tier has different TTL, auto-promotion, and sync behavior.
 * Mirrors the tiered memory model from Core-LLM-Wiki.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface TierConfig {
  name: string;
  description: string;
  ttl?: number; // milliseconds, 0 = no expiry
  autoPromote?: boolean;
  path: string;
}

export interface MemoryEntry {
  id: string;
  tier: string;
  content: string;
  type: string;
  source?: {
    path: string;
    type: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  concepts?: Array<{ name: string; type: string; confidence: number }>;
  provenance?: {
    originalSource: string;
    extractedAt: string;
    chain: Array<{ step: string; source: string }>;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  status: 'active' | 'promoted' | 'archived' | 'deleted';
}

export interface TieredMemoryConfig {
  tiers?: string[];
  memoryPath: string;
  syncToObsidian?: boolean;
}

/**
 * Tiered memory store using markdown files
 */
export class TieredMemory {
  private tiers: TierConfig[];
  private memoryPath: string;
  private syncToObsidian: boolean;

  constructor(config: TieredMemoryConfig) {
    this.syncToObsidian = config.syncToObsidian ?? true;
    this.memoryPath = config.memoryPath;

    // Default tier configuration
    const defaultTiers: TierConfig[] = [
      {
        name: 'fact',
        description: 'Raw, unprocessed knowledge from sources',
        ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
        autoPromote: true,
        path: 'fact',
      },
      {
        name: 'memory',
        description: 'Synthesized knowledge with context',
        ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
        autoPromote: true,
        path: 'memory',
      },
      {
        name: 'wisdom',
        description: 'Curated, verified knowledge',
        ttl: 0, // no expiry
        autoPromote: false,
        path: 'wisdom',
      },
    ];

    if (config.tiers && config.tiers.length > 0) {
      // Allow custom tier configs
      this.tiers = config.tiers.map(name => {
        const defaultTier = defaultTiers.find(t => t.name === name);
        return defaultTier || {
          name,
          description: `Custom tier: ${name}`,
          ttl: 0,
          autoPromote: false,
          path: name,
        };
      });
    } else {
      this.tiers = defaultTiers;
    }
  }

  /**
   * Store a new entry in the specified tier
   */
  async store(entry: {
    content: string;
    type: string;
    source?: {
      path: string;
      type: string;
      title?: string;
      metadata?: Record<string, unknown>;
    };
    concepts?: Array<{ name: string; type: string; confidence: number }>;
    tier?: string;
  }): Promise<{ tier: string; entryId: string; timestamp: string }> {
    const {
      content,
      type,
      source,
      concepts,
      tier = 'memory', // default to memory tier
    } = entry;

    // Validate tier exists
    const tierConfig = this.tiers.find(t => t.name === tier);
    if (!tierConfig) {
      throw new Error(`Tier "${tier}" does not exist. Available: ${this.tiers.map(t => t.name).join(', ')}`);
    }

    // Generate entry ID
    const hash = createHash('sha256')
      .update(`${content.slice(0, 100)}:${type}:${tier}:${Date.now()}`)
      .digest('hex')
      .slice(0, 12);
    const entryId = `${tier}-${Date.now().toString(36)}-${hash}`;

    const now = new Date().toISOString();
    const expiresAt = tierConfig.ttl ? new Date(Date.now() + tierConfig.ttl).toISOString() : undefined;

    const memoryEntry: MemoryEntry = {
      id: entryId,
      tier,
      content,
      type,
      source,
      concepts,
      provenance: source ? {
        originalSource: source.path,
        extractedAt: now,
        chain: [{ step: 'ingest', source: source.path }],
      } : undefined,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      status: 'active',
    };

    // Write to tier directory
    const tierDir = path.join(this.memoryPath, tierConfig.path);
    await fs.mkdir(tierDir, { recursive: true });

    // Write as markdown file with frontmatter
    const frontmatter = this.formatFrontmatter({
      id: entryId,
      tier,
      type,
      source: source?.path,
      sourceType: source?.type,
      sourceTitle: source?.title,
      concepts: concepts?.map(c => `${c.name}(${c.type},${c.confidence.toFixed(2)})`),
      createdAt: memoryEntry.createdAt,
      expiresAt: memoryEntry.expiresAt,
      status: memoryEntry.status,
    });

    const filePath = path.join(tierDir, `${entryId}.md`);
    await fs.writeFile(filePath, `${frontmatter}\n---\n\n${content}`);

    // Sync to Obsidian if enabled
    if (this.syncToObsidian) {
      await this.syncToObsidianVault(memoryEntry);
    }

    return { tier, entryId, timestamp: now };
  }

  /**
   * Search entries across tiers with provenance
   */
  async search(
    query: string,
    options?: {
      tiers?: string[];
      limit?: number;
      includeProvenance?: boolean;
    }
  ): Promise<Array<{
    content: string;
    source: string;
    relevance: number;
    tier?: string;
    provenance?: MemoryEntry['provenance'];
  }>> {
    const {
      tiers = this.tiers.map(t => t.name),
      limit = 20,
      includeProvenance = true,
    } = options ?? {};

    const results: Array<{
      content: string;
      source: string;
      relevance: number;
      tier?: string;
      provenance?: MemoryEntry['provenance'];
    }> = [];

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    for (const tierName of tiers) {
      const tierConfig = this.tiers.find(t => t.name === tierName);
      if (!tierConfig) continue;

      const tierDir = path.join(this.memoryPath, tierConfig.path);
      try {
        const files = await fs.readdir(tierDir);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(tierDir, file);
          const content = await fs.readFile(filePath, 'utf-8');

          // Extract frontmatter
          const frontmatter = this.extractFrontmatter(content);
          if (!frontmatter) continue;

          // Extract body (after ---)
          const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1] : content;

          // Calculate relevance
          const relevance = this.calculateRelevance(body, queryWords, frontmatter);

          if (relevance > 0) {
            results.push({
              content: body.slice(0, 500) + (body.length > 500 ? '...' : ''),
              source: file,
              relevance,
              tier: tierName,
              provenance: includeProvenance ? (frontmatter.provenance as MemoryEntry['provenance'] | undefined) : undefined,
            });
          }
        }
      } catch {
        // Tier directory may not exist yet
      }
    }

    // Sort by relevance and limit
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  /**
   * Get tier statistics
   */
  async getStats(): Promise<Record<string, { count: number; lastUpdated: string }>> {
    const stats: Record<string, { count: number; lastUpdated: string }> = {};

    for (const tier of this.tiers) {
      const tierDir = path.join(this.memoryPath, tier.path);
      try {
        const files = await fs.readdir(tierDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        let lastUpdated = '';
        for (const file of mdFiles) {
          const filePath = path.join(tierDir, file);
          const stats = await fs.stat(filePath);
          if (!lastUpdated || stats.mtime.toISOString() > lastUpdated) {
            lastUpdated = stats.mtime.toISOString();
          }
        }

        stats[tier.name] = {
          count: mdFiles.length,
          lastUpdated: lastUpdated || 'never',
        };
      } catch {
        stats[tier.name] = { count: 0, lastUpdated: 'never' };
      }
    }

    return stats;
  }

  /**
   * Forget/remove a memory entry
   */
  async forget(
    entryId: string,
    options?: { softDelete?: boolean; cascade?: boolean }
  ): Promise<{ success: boolean; message: string }> {
    const { softDelete = true, cascade = false } = options ?? {};

    // Find the entry
    for (const tier of this.tiers) {
      const tierDir = path.join(this.memoryPath, tier.path);
      try {
        const files = await fs.readdir(tierDir);
        const matchingFile = files.find(f => f.startsWith(entryId));

        if (matchingFile) {
          const filePath = path.join(tierDir, matchingFile);

          if (softDelete) {
            // Soft delete: update status in frontmatter
            const content = await fs.readFile(filePath, 'utf-8');
            const updated = content.replace(/status: active/g, 'status: deleted');
            await fs.writeFile(filePath, updated);
            return {
              success: true,
              message: `Entry ${entryId} soft-deleted in tier ${tier.name}`,
            };
          } else {
            // Hard delete
            await fs.unlink(filePath);

            if (cascade) {
              // Remove related entries in other tiers
              for (const otherTier of this.tiers) {
                if (otherTier.name === tier.name) continue;
                const otherDir = path.join(this.memoryPath, otherTier.path);
                try {
                  const otherFiles = await fs.readdir(otherDir);
                  for (const otherFile of otherFiles) {
                    if (otherFile.startsWith(entryId)) {
                      await fs.unlink(path.join(otherDir, otherFile));
                    }
                  }
                } catch {
                  // Tier may not exist
                }
              }
            }

            return {
              success: true,
              message: `Entry ${entryId} permanently deleted from tier ${tier.name}`,
            };
          }
        }
      } catch {
        // Tier directory may not exist
      }
    }

    return { success: false, message: `Entry ${entryId} not found` };
  }

  /**
   * Archive old memories
   */
  async archive(options?: {
    olderThan?: number;
    tiers?: string[];
  }): Promise<{ archived: number; message: string }> {
    const { olderThan = 30 * 24 * 60 * 60 * 1000, tiers = this.tiers.map(t => t.name) } = options ?? {};
    let archived = 0;

    const archiveDir = path.join(this.memoryPath, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    for (const tierName of tiers) {
      const tierConfig = this.tiers.find(t => t.name === tierName);
      if (!tierConfig) continue;

      const tierDir = path.join(this.memoryPath, tierConfig.path);
      try {
        const files = await fs.readdir(tierDir);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(tierDir, file);
          const stats = await fs.stat(filePath);
          const age = Date.now() - stats.mtime.getTime();

          if (age > olderThan) {
            // Move to archive
            const archivePath = path.join(archiveDir, file);
            await fs.rename(filePath, archivePath);
            archived++;
          }
        }
      } catch {
        // Tier directory may not exist
      }
    }

    return {
      archived,
      message: archived > 0
        ? `Archived ${archived} entries older than ${olderThan / (24 * 60 * 60 * 1000)} days`
        : 'No entries to archive',
    };
  }

  /**
   * Promote an entry to the next tier
   */
  async promote(entryId: string, fromTier: string, toTier: string): Promise<{ success: boolean; message: string }> {
    const fromConfig = this.tiers.find(t => t.name === fromTier);
    const toConfig = this.tiers.find(t => t.name === toTier);

    if (!fromConfig || !toConfig) {
      return { success: false, message: `Invalid tier: ${fromTier} → ${toTier}` };
    }

    const fromDir = path.join(this.memoryPath, fromConfig.path);
    const toDir = path.join(this.memoryPath, toConfig.path);

    try {
      const files = await fs.readdir(fromDir);
      const matchingFile = files.find(f => f.startsWith(entryId));

      if (!matchingFile) {
        return { success: false, message: `Entry ${entryId} not found in tier ${fromTier}` };
      }

      // Read and update content
      const filePath = path.join(fromDir, matchingFile);
      const content = await fs.readFile(filePath, 'utf-8');
      const updated = content
        .replace(/tier: \w+/g, `tier: ${toTier}`)
        .replace(/status: \w+/g, 'status: promoted');

      // Write to target tier
      await fs.mkdir(toDir, { recursive: true });
      await fs.writeFile(path.join(toDir, matchingFile), updated);

      // Remove from source tier
      await fs.unlink(filePath);

      return {
        success: true,
        message: `Entry ${entryId} promoted from ${fromTier} to ${toTier}`,
      };
    } catch (err) {
      return { success: false, message: `Promotion failed: ${err}` };
    }
  }

  /**
   * Sync entry to Obsidian vault
   */
  private async syncToObsidianVault(entry: MemoryEntry): Promise<void> {
    // This would sync to the Obsidian vault in a full implementation
    // For now, we just ensure the tier directory exists
    // The actual sync is handled by the Obsidian bridge
  }

  /**
   * Format frontmatter for a memory entry
   */
  private formatFrontmatter(data: Record<string, unknown>): string {
    const lines: string[] = ['---'];

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'string') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'boolean') {
        lines.push(`${key}: ${value}`);
      } else if (Array.isArray(value)) {
        lines.push(`${key}: [${value.join(', ')}]`);
      } else if (typeof value === 'object') {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * Extract frontmatter from markdown content
   */
  private extractFrontmatter(content: string): Record<string, unknown> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const result: Record<string, unknown> = {};

    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (key && value) {
        if (value === 'true') result[key] = true;
        else if (value === 'false') result[key] = false;
        else if (/^\d+$/.test(value)) result[key] = parseInt(value, 10);
        else if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
        } else {
          result[key] = value.replace(/['"]/g, '');
        }
      }
    }

    return result;
  }

  /**
   * Calculate relevance score for a search query
   */
  private calculateRelevance(
    content: string,
    queryWords: string[],
    frontmatter: Record<string, unknown>
  ): number {
    let score = 0;
    const lower = content.toLowerCase();

    for (const word of queryWords) {
      const count = (lower.match(new RegExp(word, 'g')) || []).length;
      score += count;
    }

    // Boost for matches in frontmatter
    for (const [key, value] of Object.entries(frontmatter)) {
      if (typeof value === 'string') {
        for (const word of queryWords) {
          if (value.toLowerCase().includes(word)) score += 2;
        }
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            for (const word of queryWords) {
              if (item.toLowerCase().includes(word)) score += 3;
            }
          }
        }
      }
    }

    return score;
  }
}
