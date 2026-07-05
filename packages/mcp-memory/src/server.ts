/**
 * MCP Memory Server — Link-inspired MCP server for agent memory
 * 
 * Provides tools for:
 * - query: Search memory with provenance
 * - remember: Store new memories
 * - recall: Retrieve specific memories
 * - brief: Get current knowledge state
 * - audit: Run wiki health check
 * - forget: Remove memories
 * - archive: Archive old memories
 * - profile: Get agent profile
 * 
 * Follows the Link pattern: smart query packets with budgets,
 * provenance, graph context, and follow-up actions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

// Import from other packages
import { Orchestrator } from '@openclaw-middleware/orchestrator';
import { TieredMemory } from '@openclaw-middleware/tiered-memory';
import { SigmaVerifier } from '@openclaw-middleware/sigma-verifier';
import { ObsidianBridge } from '@openclaw-middleware/obsidian-bridge';

// Configuration
const CONFIG = {
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || '/home/duck/Obsidian',
  wikiPath: process.env.WIKI_PATH || 'openclaw-wiki',
  memoryPath: process.env.MEMORY_PATH || '/home/duck/.openclaw/workspace/openclaw-middleware/memory',
  graphPath: process.env.GRAPH_PATH || '/home/duck/.openclaw/workspace/openclaw-middleware/graph',
  auditPath: process.env.AUDIT_PATH || '/home/duck/.openclaw/workspace/openclaw-middleware/audit',
  tiers: ['fact', 'memory', 'wisdom'],
  semanticCache: true,
  semanticCacheTTL: 3600000,
  syncToObsidian: true,
  verifyOnIngest: true,
  sigmaStrictMode: false,
};

/**
 * Initialize the orchestrator
 */
function createOrchestrator(): Orchestrator {
  return new Orchestrator(CONFIG);
}

/**
 * MCP Memory Server
 */
class MemoryServer {
  private server: McpServer;
  private orchestrator: Orchestrator;

  constructor() {
    this.orchestrator = createOrchestrator();
    this.server = new McpServer({
      name: 'openclaw-mcp-memory',
      version: '0.1.0',
    });

    this.registerTools();
  }

  /**
   * Register all MCP tools
   */
  private registerTools(): void {
    // query tool — search memory with provenance
    this.server.tool(
      'query',
      'Search knowledge memory for information with provenance. Returns ranked results from fact/memory/wisdom tiers.',
      {
        query: z.string().describe('The search query'),
        tiers: z.array(z.string()).optional().describe('Which tiers to search (fact, memory, wisdom)'),
        limit: z.number().optional().describe('Maximum number of results (default: 20)'),
        includeProvenance: z.boolean().optional().describe('Include provenance chain (default: true)'),
        includeGraphContext: z.boolean().optional().describe('Include knowledge graph context (default: false)'),
      },
      async ({ query, tiers, limit, includeProvenance, includeGraphContext }) => {
        try {
          const result = await this.orchestrator.query(query, {
            tiers,
            limit,
            includeProvenance,
            includeGraphContext,
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error querying memory: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // remember tool — store new memory
    this.server.tool(
      'remember',
      'Store a new memory entry with provenance. The entry is stored in the specified tier (default: memory).',
      {
        content: z.string().describe('The memory content to store'),
        type: z.string().optional().describe('Type of memory (ingest, decision, procedure, insight)'),
        source: z.object({
          path: z.string(),
          type: z.string(),
          title: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        }).optional().describe('Source information for provenance'),
        concepts: z.array(z.object({
          name: z.string(),
          type: z.string(),
          confidence: z.number(),
        })).optional().describe('Extracted concepts'),
        tier: z.string().optional().describe('Target tier (fact, memory, wisdom)'),
      },
      async ({ content, type, source, concepts, tier }) => {
        try {
          const result = await this.orchestrator.storeMemory({
            content,
            type: type || 'insight',
            source,
            concepts,
            tier: tier || 'memory',
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error storing memory: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // recall tool — retrieve specific memory
    this.server.tool(
      'recall',
      'Retrieve a specific memory entry by ID.',
      {
        entryId: z.string().describe('The memory entry ID to retrieve'),
      },
      async ({ entryId }) => {
        try {
          // Find the entry across all tiers
          for (const tier of CONFIG.tiers) {
            const tierDir = path.join(CONFIG.memoryPath, tier);
            try {
              const files = await fs.readdir(tierDir);
              const matchingFile = files.find(f => f.startsWith(entryId));
              if (matchingFile) {
                const filePath = path.join(tierDir, matchingFile);
                const content = await fs.readFile(filePath, 'utf-8');
                return {
                  content: [{
                    type: 'text',
                    text: content,
                  }],
                };
              }
            } catch {
              // Tier directory may not exist
            }
          }

          return {
            content: [{
              type: 'text',
              text: `Memory entry ${entryId} not found`,
            }],
            isError: true,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error recalling memory: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // brief tool — get current knowledge state
    this.server.tool(
      'brief',
      'Get a brief summary of the current knowledge state across all tiers.',
      {},
      async () => {
        try {
          const brief = await this.orchestrator.brief();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(brief, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error getting brief: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // audit tool — run wiki health check
    this.server.tool(
      'audit',
      'Run a health check on the wiki: detect orphans, contradictions, stale claims, and missing references.',
      {},
      async () => {
        try {
          const result = await this.orchestrator.lint();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error running audit: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // forget tool — remove a memory entry
    this.server.tool(
      'forget',
      'Remove a memory entry. Supports soft delete (marks as deleted) or hard delete (permanent removal).',
      {
        entryId: z.string().describe('The memory entry ID to remove'),
        softDelete: z.boolean().optional().describe('Use soft delete (default: true)'),
        cascade: z.boolean().optional().describe('Remove related entries in other tiers'),
      },
      async ({ entryId, softDelete, cascade }) => {
        try {
          const result = await this.orchestrator.forget(entryId, { softDelete, cascade });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error forgetting memory: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // archive tool — archive old memories
    this.server.tool(
      'archive',
      'Archive memories older than a specified time threshold.',
      {
        olderThanDays: z.number().optional().describe('Archive memories older than this many days (default: 30)'),
        tiers: z.array(z.string()).optional().describe('Which tiers to archive from'),
      },
      async ({ olderThanDays, tiers }) => {
        try {
          const olderThan = olderThanDays ? olderThanDays * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
          const result = await this.orchestrator.archive({ olderThan, tiers });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error archiving memories: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );

    // profile tool — get agent profile
    this.server.tool(
      'profile',
      'Get the current agent profile and context.',
      {},
      async () => {
        try {
          const profilePath = path.join(CONFIG.obsidianVaultPath, CONFIG.wikiPath, '_profile.md');
          try {
            const content = await fs.readFile(profilePath, 'utf-8');
            return {
              content: [{
                type: 'text',
                text: content,
              }],
            };
          } catch {
            return {
              content: [{
                type: 'text',
                text: '# Agent Profile\n\nNo profile found. Create one in the wiki directory.',
              }],
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Error getting profile: ${error}`,
            }],
            isError: true,
          };
        }
      }
    );
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('OpenClaw MCP Memory Server started');
  }
}

// Start the server
const server = new MemoryServer();
server.start().catch(console.error);
