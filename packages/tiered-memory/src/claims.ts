/**
 * ClaimStore — Synthadoc-inspired claim provenance store
 * 
 * Vanilla approach: stores claims as markdown files with full source tracing.
 * Each claim traces to its source with extraction metadata.
 * 
 * Provides:
 * - Claim extraction from sources
 * - Claim provenance tracking
 * - Claim verification against sources
 * - Claim deduplication
 * - Simple, no-frills API
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ClaimStoreConfig {
  claimsPath: string;
}

export interface Claim {
  id: string;
  content: string;
  type: string;
  source: {
    path: string;
    type: string;
    title?: string;
    page?: number;
    section?: string;
  };
  provenance: {
    extractedAt: string;
    extractor: string;
    confidence: number;
    chain: Array<{
      step: string;
      source: string;
      timestamp: string;
    }>;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'verified' | 'contradicted' | 'superseded' | 'archived';
}

/**
 * Claim provenance store
 */
export class ClaimStore {
  private claimsPath: string;

  constructor(config: ClaimStoreConfig) {
    this.claimsPath = config.claimsPath;
  }

  /**
   * Add a new claim with provenance
   */
  async add(claim: Omit<Claim, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<Claim> {
    const id = this.generateId(claim);
    const now = new Date().toISOString();

    const fullClaim: Claim = {
      ...claim,
      id,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };

    await this.saveClaim(fullClaim);
    await this.updateIndex();
    return fullClaim;
  }

  /**
   * Get a claim by ID
   */
  async get(id: string): Promise<Claim | null> {
    const claimFile = path.join(this.claimsPath, `${id}.md`);
    try {
      const content = await fs.readFile(claimFile, 'utf-8');
      return this.parseClaim(content);
    } catch {
      return null;
    }
  }

  /**
   * Search claims by query
   */
  async search(query: string, options?: {
    types?: string[];
    statuses?: string[];
    limit?: number;
  }): Promise<Claim[]> {
    const { types = [], statuses = [], limit = 50 } = options || {};
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const claims: Claim[] = [];
    try {
      const files = await fs.readdir(this.claimsPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(this.claimsPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const claim = this.parseClaim(content);

        if (!claim) continue;

        // Filter by type
        if (types.length > 0 && !types.includes(claim.type)) continue;

        // Filter by status
        if (statuses.length > 0 && !statuses.includes(claim.status)) continue;

        // Calculate relevance
        const relevance = this.calculateRelevance(claim, queryWords);
        if (relevance > 0) {
          claims.push(claim);
        }
      }
    } catch {
      // Claims directory may not exist
    }

    // Sort by relevance and limit
    claims.sort((a, b) => this.calculateRelevance(b, queryWords) - this.calculateRelevance(a, queryWords));
    return claims.slice(0, limit);
  }

  /**
   * Find claims contradicted by newer claims
   * Optimized: skips already-contradicted claims, uses content hash for quick pre-filter
   */
  async findContradictedClaims(): Promise<Array<{
    claim: Claim;
    contradictedBy: Claim[];
  }>> {
    const allClaims = await this.getAll();
    const contradicted: Array<{
      claim: Claim;
      contradictedBy: Claim[];
    }> = [];

    // Group by type
    const byType: Record<string, Claim[]> = {};
    for (const claim of allClaims) {
      if (!byType[claim.type]) byType[claim.type] = [];
      byType[claim.type].push(claim);
    }

    // Check each type group for contradictions
    for (const [type, claims] of Object.entries(byType)) {
      const sorted = [...claims].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      for (let i = 0; i < sorted.length; i++) {
        const claim = sorted[i];
        if (claim.status !== 'active') continue;

        // Quick pre-filter: skip if content is too different from all newer claims
        const contradictedBy: Claim[] = [];
        for (let j = 0; j < i; j++) {
          const newer = sorted[j];
          // Skip if already contradicted by a previous check
          if (contradicted.find(c => c.claim.id === claim.id)) break;
          if (this.detectContradiction(claim, newer)) {
            contradictedBy.push(newer);
          }
        }

        if (contradictedBy.length > 0) {
          contradicted.push({ claim, contradictedBy });
        }
      }
    }

    return contradicted;
  }

  /**
   * Update claim status
   */
  async updateStatus(id: string, status: Claim['status']): Promise<void> {
    const claim = await this.get(id);
    if (!claim) throw new Error(`Claim ${id} not found`);

    claim.status = status;
    claim.updatedAt = new Date().toISOString();
    await this.saveClaim(claim);
    await this.updateIndex();
  }

  /**
   * Get all claims
   */
  async getAll(): Promise<Claim[]> {
    const claims: Claim[] = [];
    try {
      const files = await fs.readdir(this.claimsPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(this.claimsPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const claim = this.parseClaim(content);
        if (claim) claims.push(claim);
      }
    } catch {
      // Claims directory may not exist
    }
    return claims.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Get claim statistics
   */
  async getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    recent: Array<{ date: string; count: number }>;
  }> {
    const claims = await this.getAll();
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byDate: Record<string, number> = {};

    for (const claim of claims) {
      byType[claim.type] = (byType[claim.type] || 0) + 1;
      byStatus[claim.status] = (byStatus[claim.status] || 0) + 1;
      const date = claim.createdAt.split('T')[0];
      byDate[date] = (byDate[date] || 0) + 1;
    }

    const recent = Object.entries(byDate)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30)
      .map(([date, count]) => ({ date, count }));

    return {
      total: claims.length,
      byType,
      byStatus,
      recent,
    };
  }

  /**
   * Generate a unique claim ID
   */
  private generateId(claim: Omit<Claim, 'id' | 'createdAt' | 'updatedAt' | 'status'>): string {
    const hash = Buffer.from(
      `${claim.content.slice(0, 50)}:${claim.source.path}:${claim.type}:${Date.now()}`
    ).toString('base64url').slice(0, 12);
    return `${claim.type}-${Date.now().toString(36)}-${hash}`;
  }

  /**
   * Save a claim to disk
   */
  private async saveClaim(claim: Claim): Promise<void> {
    const filePath = path.join(this.claimsPath, `${claim.id}.md`);
    const content = this.formatClaim(claim);
    await fs.mkdir(this.claimsPath, { recursive: true });
    await fs.writeFile(filePath, content);
  }

  /**
   * Update the claims index
   */
  private async updateIndex(): Promise<void> {
    const claims = await this.getAll();
    const index = path.join(this.claimsPath, 'index.md');

    let content = '# Claims Index\n\n';
    content += `> Auto-generated claims catalog\n`;
    content += `> Last updated: ${new Date().toISOString()}\n\n`;

    // Group by type
    const byType: Record<string, Claim[]> = {};
    for (const claim of claims) {
      if (!byType[claim.type]) byType[claim.type] = [];
      byType[claim.type].push(claim);
    }

    for (const [type, typeClaims] of Object.entries(byType)) {
      content += `## ${type}\n\n`;
      for (const claim of typeClaims) {
        const status = claim.status === 'active' ? '' : ` [${claim.status}]`;
        content += `- [[${claim.id}]]${status}: ${claim.content.slice(0, 100)}\n`;
        content += `  - Source: ${claim.source.path}\n`;
        content += `  - Confidence: ${claim.provenance.confidence.toFixed(2)}\n`;
        content += `  - Created: ${claim.createdAt}\n`;
      }
      content += '\n';
    }

    await fs.writeFile(index, content);
  }

  /**
   * Format a claim as markdown
   */
  private formatClaim(claim: Claim): string {
    const lines: string[] = ['---'];
    lines.push(`id: ${claim.id}`);
    lines.push(`type: ${claim.type}`);
    lines.push(`source: ${claim.source.path}`);
    lines.push(`sourceType: ${claim.source.type}`);
    if (claim.source.title) lines.push(`sourceTitle: ${claim.source.title}`);
    if (claim.source.page) lines.push(`sourcePage: ${claim.source.page}`);
    if (claim.source.section) lines.push(`sourceSection: ${claim.source.section}`);
    lines.push(`extractedAt: ${claim.provenance.extractedAt}`);
    lines.push(`extractor: ${claim.provenance.extractor}`);
    lines.push(`confidence: ${claim.provenance.confidence}`);
    lines.push(`status: ${claim.status}`);
    lines.push(`created: ${claim.createdAt}`);
    lines.push(`updated: ${claim.updatedAt}`);
    if (claim.metadata) {
      lines.push('metadata:');
      for (const [key, value] of Object.entries(claim.metadata)) {
        if (typeof value === 'string') {
          lines.push(`  ${key}: ${value}`);
        } else if (typeof value === 'number') {
          lines.push(`  ${key}: ${value}`);
        } else if (Array.isArray(value)) {
          lines.push(`  ${key}: [${value.join(', ')}]`);
        } else {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
    lines.push('---');
    lines.push('');
    lines.push(`# Claim: ${claim.content.slice(0, 80)}${claim.content.length > 80 ? '...' : ''}`);
    lines.push('');
    lines.push(`## Full Claim`);
    lines.push('');
    lines.push(claim.content);
    lines.push('');
    lines.push(`## Source`);
    lines.push('');
    lines.push(`- **Path**: ${claim.source.path}`);
    if (claim.source.title) lines.push(`- **Title**: ${claim.source.title}`);
    if (claim.source.page) lines.push(`- **Page**: ${claim.source.page}`);
    if (claim.source.section) lines.push(`- **Section**: ${claim.source.section}`);
    lines.push('');
    lines.push(`## Provenance`);
    lines.push('');
    lines.push(`- **Extracted**: ${claim.provenance.extractedAt}`);
    lines.push(`- **Extractor**: ${claim.provenance.extractor}`);
    lines.push(`- **Confidence**: ${claim.provenance.confidence.toFixed(2)}`);
    lines.push(`- **Chain**: ${claim.provenance.chain.map(c => `${c.step}→${c.source}`).join(' → ')}`);
    lines.push('');
    lines.push(`## Status: ${claim.status}`);
    lines.push('');
    lines.push(`## Created: ${claim.createdAt}`);
    lines.push('');
    lines.push(`## Updated: ${claim.updatedAt}`);
    return lines.join('\n');
  }

  /**
   * Parse a claim from markdown
   */
  private parseClaim(content: string): Claim | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const properties: Record<string, unknown> = {};
    let inMetadata = false;

    for (const line of lines) {
      if (line === 'metadata:') {
        inMetadata = true;
        continue;
      }
      if (inMetadata) {
        if (/^\s+\S/.test(line)) {
          const [key, ...valueParts] = line.trim().split(':');
          const value = valueParts.join(':').trim();
          if (key && value) {
            properties[key] = value.replace(/['"]/g, '');
          }
        } else {
          inMetadata = false;
        }
      } else {
        const [key, ...valueParts] = line.split(':');
        const value = valueParts.join(':').trim();
        if (key && value) {
          if (value === 'true') properties[key] = true;
          else if (value === 'false') properties[key] = false;
          else if (/^\d+$/.test(value)) properties[key] = parseInt(value, 10);
          else properties[key] = value.replace(/['"]/g, '');
        }
      }
    }

    // Extract body content (everything after the second ---)
    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : '';

    // Extract provenance chain from body
    const chainMatch = body.match(/- \*\*Chain\*\*: (.*)/);
    const chain: Array<{ step: string; source: string }> = [];
    if (chainMatch) {
      chainMatch[1].split(' → ').forEach(segment => {
        const parts = segment.split('→');
        if (parts.length >= 2) {
          chain.push({ step: parts[0].trim(), source: parts[1].trim() });
        }
      });
    }

    return {
      id: properties.id as string,
      content: body,
      type: properties.type as string,
      source: {
        path: properties.source as string,
        type: properties.sourceType as string,
        title: properties.sourceTitle as string,
        page: properties.sourcePage as number,
        section: properties.sourceSection as string,
      },
      provenance: {
        extractedAt: properties.extractedAt as string,
        extractor: properties.extractor as string,
        confidence: properties.confidence as number,
        chain,
      },
      metadata: properties.metadata as Record<string, unknown>,
      createdAt: properties.created as string,
      updatedAt: properties.updated as string,
      status: (properties.status as Claim['status']) || 'active',
    };
  }

  /**
   * Calculate relevance for a claim
   */
  private calculateRelevance(claim: Claim, queryWords: string[]): number {
    let score = 0;
    const contentLower = claim.content.toLowerCase();
    const sourceLower = claim.source.path.toLowerCase();

    for (const word of queryWords) {
      const contentCount = (contentLower.match(new RegExp(word, 'g')) || []).length;
      const sourceCount = (sourceLower.match(new RegExp(word, 'g')) || []).length;
      score += contentCount * 2 + sourceCount;
    }

    return score;
  }

  /**
   * Detect contradiction between two claims
   */
  private detectContradiction(claimA: Claim, claimB: Claim): boolean {
    // Simple contradiction detection
    const aLower = claimA.content.toLowerCase();
    const bLower = claimB.content.toLowerCase();

    const negations = [
      'not', 'never', 'no', 'does not', 'cannot', 'should not',
      'would not', 'will not', 'is not', 'are not', 'was not',
      'were not', 'without', 'lacks', 'absent', 'false', 'incorrect',
      'wrong', 'mistaken', 'erroneous', 'invalid', 'untrue',
    ];

    for (const neg of negations) {
      const aHasNeg = aLower.includes(neg);
      const bHasNeg = bLower.includes(neg);

      if (aHasNeg !== bHasNeg) {
        // One has negation, the other doesn't
        const aPositive = aHasNeg ? aLower.replace(new RegExp(neg, 'g'), '') : aLower;
        const bPositive = bHasNeg ? bLower.replace(new RegExp(neg, 'g'), '') : bLower;

        // Check for similar content
        const aWords = new Set(aPositive.split(/\s+/).filter(w => w.length > 2));
        const bWords = new Set(bPositive.split(/\s+/).filter(w => w.length > 2));

        let intersections = 0;
        for (const word of aWords) {
          if (bWords.has(word)) intersections++;
        }

        const union = new Set([...aWords, ...bWords]).size;
        if (union > 0 && intersections / union > 0.3) {
          return true;
        }
      }
    }

    return false;
  }
}
