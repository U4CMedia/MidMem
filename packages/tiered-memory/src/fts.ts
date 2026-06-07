/**
 * SQLiteFTS — SQLite Full-Text Search engine for the memory store
 * 
 * Vanilla approach: uses Node 22's built-in node:sqlite module.
 * No external dependencies. FTS5 for fast text search across tiers.
 * 
 * Provides:
 * - In-memory search across all tier entries
 * - Weighted relevance scoring
 * - Pagination support
 * - Simple, no-frills API
 */

import * as sqlite from 'node:sqlite';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface FTSConfig {
  dbPath: string;
}

export interface SearchOptions {
  query: string;
  tiers?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  entryId: string;
  tier: string;
  content: string;
  type: string;
  source: string | null;
  relevance: number;
  createdAt: string;
}

/**
 * SQLite FTS engine — vanilla, no external deps beyond node:sqlite
 */
export class SQLiteFTS {
  private db: sqlite.Database;
  private dbPath: string;

  constructor(config: FTSConfig) {
    this.dbPath = config.dbPath;
    this.db = new sqlite.Database(this.dbPath);
    this.init();
  }

  /**
   * Initialize the database schema
   */
  private init(): void {
    // Create the main entries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        content,
        type,
        tier,
        source,
        content_rowid='entry_id'
      )
    `);

    // Triggers to keep FTS in sync with entries
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, content, type, tier, source)
        VALUES (new.entry_id, new.content, new.type, new.tier, new.source);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, type, tier, source)
        VALUES ('delete', old.entry_id, old.content, old.type, old.tier, old.source);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, type, tier, source)
        VALUES ('delete', old.entry_id, old.content, old.type, old.tier, old.source);
        INSERT INTO entries_fts(rowid, content, type, tier, source)
        VALUES (new.entry_id, new.content, new.type, new.tier, new.source);
      END;
    `);
  }

  /**
   * Add or update an entry
   */
  upsert(entry: {
    entryId: string;
    tier: string;
    content: string;
    type: string;
    source: string | null;
    createdAt: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries (entry_id, tier, content, type, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.entryId,
      entry.tier,
      entry.content,
      entry.type,
      entry.source,
      entry.createdAt,
      new Date().toISOString(),
    );
  }

  /**
   * Search with FTS5
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, tiers, limit = 20, offset = 0 } = options;
    const tierFilter = tiers && tiers.length > 0
      ? `AND tier IN (${tiers.map(() => '?').join(',')})`
      : '';
    const tierParams = tiers && tiers.length > 0 ? tiers : [];

    // Use FTS5 match with BM25 relevance
    const stmt = this.db.prepare(`
      SELECT
        e.entry_id,
        e.tier,
        e.content,
        e.type,
        e.source,
        e.created_at,
        snippets(entries_fts, 0, ' | ', '...', '...', 20) as snippet
      FROM entries_fts AS f
      JOIN entries AS e ON e.entry_id = f.rowid
      WHERE entries_fts MATCH ?
      ${tierFilter}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `);

    const params = [query, ...tierParams, limit, offset];
    const rows = stmt.all(...params) as Array<{
      entry_id: string;
      tier: string;
      content: string;
      type: string;
      source: string | null;
      created_at: string;
      snippet: string;
    }>;

    return rows.map(r => ({
      entryId: r.entry_id,
      tier: r.tier,
      content: r.snippet || r.content,
      type: r.type,
      source: r.source,
      relevance: 0, // FTS5 rank is implicit
      createdAt: r.created_at,
    }));
  }

  /**
   * Get entry count by tier
   */
  getStats(): Record<string, number> {
    const rows = this.db.all(
      `SELECT tier, COUNT(*) as count FROM entries GROUP BY tier`
    ) as Array<{ tier: string; count: number }>;

    return Object.fromEntries(rows.map(r => [r.tier, r.count]));
  }

  /**
   * Delete an entry
   */
  delete(entryId: string): void {
    this.db.prepare(`DELETE FROM entries WHERE entry_id = ?`).run(entryId);
  }

  /**
   * Get a single entry
   */
  get(entryId: string): SearchResult | null {
    const row = this.db.get(
      `SELECT entry_id, tier, content, type, source, created_at FROM entries WHERE entry_id = ?`,
      entryId
    ) as SearchResult | undefined;

    return row || null;
  }

  /**
   * Get all entries (for sync to Obsidian)
   */
  getAll(): SearchResult[] {
    const rows = this.db.all(
      `SELECT entry_id, tier, content, type, source, created_at FROM entries ORDER BY created_at DESC`
    ) as SearchResult[];

    return rows.map(r => ({
      ...r,
      relevance: 0,
    }));
  }

  /**
   * Close the database (call when done to release file descriptor)
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }

  /**
   * Dispose resources (alias for close, for consistency with other packages)
   */
  dispose(): void {
    this.close();
  }
}
