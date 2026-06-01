/**
 * ObsidianBridge — Synto-inspired layer for Obsidian vault sync
 * 
 * Handles:
 * - Bidirectional sync between wiki and Obsidian vault
 * - Semantic cache to avoid redundant LLM calls
 * - Concept extraction from sources
 * - Wiki index (index.md) management
 * - Event log (log.md) management
 * - Orphan detection
 * - Missing reference detection
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { SemanticCache } from './semantic-cache.js';

export interface ObsidianConfig {
  vaultPath: string;
  wikiPath: string;
  semanticCache?: boolean;
  cacheTTL?: number;
  llmEndpoint?: string; // LM Studio endpoint for semantic cache
  llmModel?: string;    // LM Studio model for embeddings
}

export interface ConceptExtraction {
  concepts: Array<{ name: string; type: string; confidence: number }>;
  summary: string;
  keyPoints: string[];
  relatedPages: string[];
}

export interface LogEntry {
  timestamp: string;
  operation: string;
  source?: { path: string; type: string; title?: string };
  [key: string]: unknown;
}

/**
 * Semantic cache to avoid redundant LLM calls
 * Mirrors Synto's semantic cache for dedup
 */
class SemanticCache {
  private cache: Map<string, { value: string; timestamp: number }>;
  private ttl: number;

  constructor(ttlMs: number = 3600000) {
    this.cache = new Map();
    this.ttl = ttlMs;
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string): void {
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Wiki page metadata for index.md
 */
interface WikiPageMeta {
  path: string;
  title: string;
  summary: string;
  type: string;
  tags: string[];
  lastModified: string;
  sourceCount: number;
  inboundLinks: number;
}

/**
 * Obsidian bridge implementation
 */
export class ObsidianBridge {
  private vaultPath: string;
  private wikiPath: string;
  private semanticCache: SemanticCache | null;
  private _stats: { totalPages: number; totalLinks: number } = { totalPages: 0, totalLinks: 0 };

  constructor(config: ObsidianConfig) {
    this.vaultPath = config.vaultPath;
    this.wikiPath = config.wikiPath;
    if (config.semanticCache && config.llmEndpoint) {
      this.semanticCache = new SemanticCache({
        llmEndpoint: config.llmEndpoint,
        llmModel: config.llmModel || 'nomic-embed-text',
        cacheDir: path.join(this.vaultPath, '.obsidian-cache'),
      });
      this.semanticCache.load().catch(() => {}); // Load cache, ignore errors
    } else {
      this.semanticCache = null;
    }
  }

  /**
   * Extract concepts from a source document
   * Mirrors Synto's concept extraction pipeline
   */
  async extractConcepts(filePath: string, type: string): Promise<ConceptExtraction> {
    const cacheKey = `extract:${filePath}:${type}`;
    
    // Check semantic cache first
    if (this.semanticCache) {
      const cached = this.semanticCache.get(cacheKey);
      if (cached) return JSON.parse(cached);
      
      // Also check for similar concepts (dedup)
      const similar = await this.semanticCache.getSimilar(cacheKey, 3);
      if (similar.length > 0) {
        // Return cached result for the most similar entry
        return JSON.parse(similar[0].value);
      }
    }

    // Read source file
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Extract concepts (simplified — in production, this would call an LLM)
    const concepts = this.extractConceptsFromContent(content, type);
    const summary = this.generateSummary(content, type);
    const keyPoints = this.extractKeyPoints(content);
    
    // Find related pages in wiki
    const relatedPages = await this.findRelatedPages(concepts);

    const result: ConceptExtraction = {
      concepts,
      summary,
      keyPoints,
      relatedPages,
    };

    // Store in semantic cache
    if (this.semanticCache) {
      await this.semanticCache.set(cacheKey, JSON.stringify(result));
      await this.semanticCache.save(); // Persist to disk
    }
    
    return result;
  }

  /**
   * Extract concepts from text content (simplified extraction)
   * In production, this calls an LLM for semantic extraction
   */
  private extractConceptsFromContent(content: string, type: string): ConceptExtraction['concepts'] {
    // Simplified: extract capitalized phrases and technical terms
    const concepts: ConceptExtraction['concepts'] = [];
    
    // Match capitalized phrases (potential entity names)
    const capitalizedPhrases = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    const seen = new Set<string>();
    
    for (const phrase of capitalizedPhrases) {
      if (phrase.length > 3 && !seen.has(phrase)) {
        seen.add(phrase);
        concepts.push({
          name: phrase,
          type: this.categorizeConcept(phrase, type),
          confidence: this.estimateConfidence(phrase, content),
        });
      }
    }
    
    return concepts.slice(0, 50); // Limit to top 50 concepts
  }

  /**
   * Categorize a concept based on its name and source type
   */
  private categorizeConcept(name: string, sourceType: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('person') || lower.includes('people')) return 'person';
    if (lower.includes('organization') || lower.includes('company') || lower.includes('org')) return 'organization';
    if (lower.includes('tool') || lower.includes('framework') || lower.includes('library')) return 'tool';
    if (lower.includes('concept') || lower.includes('theory') || lower.includes('model')) return 'concept';
    if (lower.includes('method') || lower.includes('approach') || lower.includes('pattern')) return 'method';
    if (lower.includes('date') || lower.includes('year') || lower.includes('time')) return 'temporal';
    if (lower.includes('location') || lower.includes('place') || lower.includes('city')) return 'location';
    return 'general';
  }

  /**
   * Estimate confidence of a concept extraction
   */
  private estimateConfidence(name: string, content: string): number {
    const lower = name.toLowerCase();
    const count = (content.toLowerCase().match(new RegExp(lower, 'g')) || []).length;
    // More occurrences = higher confidence
    return Math.min(0.95, 0.3 + count * 0.1);
  }

  /**
   * Generate a summary from content
   */
  private generateSummary(content: string, type: string): string {
    // Take first 2-3 meaningful sentences
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    return sentences.slice(0, 3).map(s => s.trim()).join('. ') + '.';
  }

  /**
   * Extract key points from content
   */
  private extractKeyPoints(content: string): string[] {
    // Look for bullet points, numbered lists, or bold headers
    const bullets = content.match(/[-*]\s+(.+?)(?=\n[-*]|\n\n|$)/g) || [];
    const numbered = content.match(/^\d+\.\s+(.+?)(?=\n\d+\.|\n\n|$)/gm) || [];
    const bold = content.match(/\*\*(.+?)\*\*/g) || [];
    
    return [
      ...bullets.map(b => b.replace(/^[-*]\s+/, '')),
      ...numbered.map(n => n.replace(/^\d+\.\s+/, '')),
      ...bold.map(b => b.replace(/\*\*/g, '')),
    ].filter(p => p.trim().length > 10).slice(0, 10);
  }

  /**
   * Find related pages in the wiki for a set of concepts
   */
  private async findRelatedPages(concepts: ConceptExtraction['concepts']): Promise<string[]> {
    const related = new Set<string>();
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    
    try {
      const files = await fs.readdir(wikiDir, { recursive: true });
      for (const concept of concepts) {
        for (const file of files) {
          if (file.endsWith('.md') && file.includes(concept.name.toLowerCase().slice(0, 5))) {
            related.add(file);
          }
        }
      }
    } catch {
      // Wiki dir may not exist yet
    }
    
    return Array.from(related).slice(0, 10);
  }

  /**
   * Append an entry to the wiki log
   * Uses Karpathy's parseable prefix format: ## [YYYY-MM-DD] operation | summary
   */
  async appendLog(entry: LogEntry): Promise<void> {
    const logPath = path.join(this.vaultPath, this.wikiPath, 'log.md');
    const date = new Date(entry.timestamp).toISOString().split('T')[0];
    
    // Format: ## [YYYY-MM-DD] operation | summary
    const header = `## [${date}] ${entry.operation} | ${entry.source?.title || entry.source?.path || 'untitled'}`;
    const body = this.formatLogBody(entry);
    
    const logLine = `\n${header}\n${body}\n`;
    
    try {
      await fs.appendFile(logPath, logLine);
    } catch {
      // Create log if it doesn't exist
      await fs.writeFile(logPath, `# Wiki Log\n\n${logLine}`);
    }
  }

  /**
   * Format log entry body
   */
  private formatLogBody(entry: LogEntry): string {
    const lines: string[] = [];
    
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'timestamp' || key === 'operation') continue;
      if (typeof value === 'object' && value !== null) {
        lines.push(`- **${key}**: ${JSON.stringify(value)}`);
      } else {
        lines.push(`- **${key}**: ${String(value)}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Update the wiki index (index.md)
   * Content-oriented catalog: page link + one-line summary + metadata
   */
  async updateIndex(): Promise<void> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    const indexPath = path.join(wikiDir, 'index.md');
    
    // Read all wiki pages
    const files = await fs.readdir(wikiDir, { recursive: true });
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');
    
    // Build index entries by category
    const categories: Record<string, Array<{ link: string; summary: string; metadata?: Record<string, unknown> }>> = {};
    
    for (const file of mdFiles) {
      const filePath = path.join(wikiDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Extract frontmatter if present
      const frontmatter = this.extractFrontmatter(content);
      const type = frontmatter?.type || 'general';
      
      if (!categories[type]) categories[type] = [];
      
      // Get first meaningful sentence as summary
      const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 15);
      const summary = sentences[0]?.trim() || 'No summary available.';
      
      categories[type].push({
        link: `[[${file}]]`,
        summary,
        metadata: frontmatter,
      });
    }
    
    // Build index content
    let indexContent = '# Wiki Index\n\n';
    indexContent += `> Auto-generated catalog of wiki pages\n`;
    indexContent += `> Last updated: ${new Date().toISOString()}\n\n`;
    
    for (const [category, pages] of Object.entries(categories)) {
      indexContent += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
      for (const page of pages) {
        indexContent += `- ${page.link}: ${page.summary}\n`;
        if (page.metadata?.tags) {
          indexContent += `  - Tags: ${page.metadata.tags.join(', ')}\n`;
        }
      }
      indexContent += '\n';
    }
    
    await fs.writeFile(indexPath, indexContent);
    this._stats.totalPages = mdFiles.length;
    this._stats.totalLinks = categories[Object.keys(categories)[0]]?.length ?? 0;
  }

  /**
   * Extract YAML frontmatter from markdown content
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
        // Parse common types
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
   * Search wiki pages for content matching a query
   * At small scale, index.md is sufficient; at larger scale, FTS would be needed
   */
  async searchWiki(query: string, options?: { limit?: number }): Promise<Array<{
    content: string;
    source: string;
    relevance: number;
  }>> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    const results: Array<{ content: string; source: string; relevance: number }> = [];
    
    try {
      const files = await fs.readdir(wikiDir, { recursive: true });
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');
      
      const queryLower = query.toLowerCase();
      
      for (const file of mdFiles) {
        const filePath = path.join(wikiDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        // Simple relevance scoring
        const lower = content.toLowerCase();
        const words = queryLower.split(/\s+/).filter(w => w.length > 2);
        let relevance = 0;
        
        for (const word of words) {
          const count = (lower.match(new RegExp(word, 'g')) || []).length;
          relevance += count;
        }
        
        // Boost for matches in frontmatter
        const frontmatter = this.extractFrontmatter(content);
        if (frontmatter) {
          if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
            for (const tag of frontmatter.tags as string[]) {
              if (tag.toLowerCase().includes(queryLower)) relevance += 2;
            }
          }
        }
        
        if (relevance > 0) {
          results.push({
            content: content.slice(0, 500) + (content.length > 500 ? '...' : ''),
            source: file,
            relevance,
          });
        }
      }
    } catch {
      // Wiki dir may not exist yet
    }
    
    // Sort by relevance and limit
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, options?.limit ?? 20);
  }

  /**
   * Check for orphan pages (pages with no inbound links)
   * Uses Obsidian's graph view logic: a page is orphaned if no other page links to it
   */
  async checkOrphans(): Promise<[string[], { totalPages: number; totalLinks: number }]> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    const files = await fs.readdir(wikiDir, { recursive: true });
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');
    
    // Read all files and collect wikilinks
    const inboundLinks: Set<string> = new Set();
    
    for (const file of mdFiles) {
      const filePath = path.join(wikiDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Find [[link]] patterns
      const links = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of links) {
        const target = link.slice(2, -2);
        inboundLinks.add(target);
      }
    }
    
    // Find orphans: pages not referenced by any other page
    const orphans: string[] = [];
    for (const file of mdFiles) {
      const baseName = path.basename(file, '.md');
      if (!inboundLinks.has(baseName) && !inboundLinks.has(file)) {
        orphans.push(file);
      }
    }
    
    return [orphans, this._stats];
  }

  /**
   * Find missing references (links to pages that don't exist)
   */
  async findMissingReferences(): Promise<Array<{ page: string; missing: string }>> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    const files = await fs.readdir(wikiDir, { recursive: true });
    const existingFiles = new Set(files);
    const missing: Array<{ page: string; missing: string }> = [];
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(wikiDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      
      const links = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of links) {
        const target = link.slice(2, -2);
        // Check if target exists (as file or without extension)
        const targetWithExt = target + '.md';
        if (!existingFiles.has(target) && !existingFiles.has(targetWithExt)) {
          missing.push({ page: file, missing: target });
        }
      }
    }
    
    return missing;
  }

  /**
   * Get wiki statistics
   */
  async getStats(): Promise<{ totalPages: number; totalLinks: number }> {
    return this._stats;
  }

  /**
   * Get recent activity from the log
   */
  async getRecentActivity(count: number = 10): Promise<Array<{ timestamp: string; operation: string; summary: string }>> {
    const logPath = path.join(this.vaultPath, this.wikiPath, 'log.md');
    
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      // Parse log entries (format: ## [YYYY-MM-DD] operation | summary)
      const entries = content.match(/## \[([^\]]+)\] ([^|]+) \| (.+?)(?=\n## |\n\n|$)/g) || [];
      
      return entries.slice(-count).map(entry => {
        const match = entry.match(/## \[([^\]]+)\] ([^|]+) \| (.+)/);
        if (!match) return null;
        return {
          timestamp: match[1],
          operation: match[2].trim(),
          summary: match[3].trim(),
        };
      }).filter(Boolean) as Array<{ timestamp: string; operation: string; summary: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Write a wiki page
   */
  async writePage(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, this.wikiPath, filePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  /**
   * Read a wiki page
   */
  async readPage(filePath: string): Promise<string> {
    const fullPath = path.join(this.vaultPath, this.wikiPath, filePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  /**
   * Delete a wiki page
   */
  async deletePage(filePath: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, this.wikiPath, filePath);
    await fs.unlink(fullPath);
  }

  /**
   * Check if a page exists
   */
  async pageExists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.vaultPath, this.wikiPath, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sync wiki changes to Obsidian vault
   * Writes all wiki pages to their corresponding locations in the vault
   */
  async syncToVault(): Promise<{ synced: number; errors: string[] }> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    let synced = 0;
    const errors: string[] = [];

    try {
      const files = await fs.readdir(wikiDir, { recursive: true });
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        
        const srcPath = path.join(wikiDir, file);
        const destPath = path.join(this.vaultPath, file);
        
        try {
          const content = await fs.readFile(srcPath, 'utf-8');
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.writeFile(destPath, content);
          synced++;
        } catch (err) {
          errors.push(`${file}: ${err}`);
        }
      }
    } catch (err) {
      errors.push(`Failed to read wiki directory: ${err}`);
    }

    return { synced, errors };
  }

  /**
   * Sync Obsidian vault changes back to wiki
   * Reads all markdown files from the wiki directory and updates the wiki
   */
  async syncFromVault(): Promise<{ synced: number; errors: string[] }> {
    const wikiDir = path.join(this.vaultPath, this.wikiPath);
    let synced = 0;
    const errors: string[] = [];

    try {
      const files = await fs.readdir(this.vaultPath, { recursive: true });
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        
        // Skip files already in the wiki directory
        if (file.startsWith(this.wikiPath + '/')) continue;
        
        const srcPath = path.join(this.vaultPath, file);
        const destPath = path.join(wikiDir, file);
        
        try {
          const content = await fs.readFile(srcPath, 'utf-8');
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.writeFile(destPath, content);
          synced++;
        } catch (err) {
          errors.push(`${file}: ${err}`);
        }
      }
    } catch (err) {
      errors.push(`Failed to read vault directory: ${err}`);
    }

    return { synced, errors };
  }
}
