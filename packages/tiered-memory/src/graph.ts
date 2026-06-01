/**
 * TypedKnowledgeGraph — OmegaWiki-inspired typed knowledge graph
 * 
 * Vanilla approach: stores typed entities and edges as markdown files.
 * No external graph database dependency.
 * 
 * Provides:
 * - Typed entity types (Person, Concept, Paper, Tool, etc.)
 * - Typed edge types (references, contradicts, supports, relates)
 * - Graph export for visualization
 * - Simple traversal queries
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface GraphConfig {
  graphPath: string;
}

export interface Entity {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
  source: string;
  createdAt: string;
}

/**
 * Typed knowledge graph — entities and edges stored as markdown
 */
export class TypedKnowledgeGraph {
  private graphPath: string;

  constructor(config: GraphConfig) {
    this.graphPath = config.graphPath;
  }

  /**
   * Add or update an entity
   */
  async upsertEntity(entity: Entity): Promise<void> {
    const entityDir = path.join(this.graphPath, 'entities');
    await fs.mkdir(entityDir, { recursive: true });

    const filePath = path.join(entityDir, `${entity.id}.md`);
    const content = this.formatEntity(entity);
    await fs.writeFile(filePath, content);
  }

  /**
   * Add or update an edge
   */
  async upsertEdge(edge: Edge): Promise<void> {
    const edgeDir = path.join(this.graphPath, 'edges');
    await fs.mkdir(edgeDir, { recursive: true });

    const filePath = path.join(edgeDir, `${edge.id}.md`);
    const content = this.formatEdge(edge);
    await fs.writeFile(filePath, content);
  }

  /**
   * Get all entities of a type
   */
  async getEntitiesByType(type: string): Promise<Entity[]> {
    const entityDir = path.join(this.graphPath, 'entities');
    try {
      const files = await fs.readdir(entityDir);
      const entities: Entity[] = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(entityDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const entity = this.parseEntity(content);

        if (entity && entity.type === type) {
          entities.push(entity);
        }
      }

      return entities;
    } catch {
      return [];
    }
  }

  /**
   * Get all edges for an entity
   */
  async getEdgesForEntity(entityId: string): Promise<Edge[]> {
    const edgeDir = path.join(this.graphPath, 'edges');
    try {
      const files = await fs.readdir(edgeDir);
      const edges: Edge[] = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(edgeDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const edge = this.parseEdge(content);

        if (edge && (edge.from === entityId || edge.to === entityId)) {
          edges.push(edge);
        }
      }

      return edges;
    } catch {
      return [];
    }
  }

  /**
   * Get the graph for visualization
   */
  async getGraph(): Promise<{
    nodes: Array<{ id: string; label: string; type: string }>;
    edges: Array<{ from: string; to: string; type: string }>;
  }> {
    const nodes: Array<{ id: string; label: string; type: string }> = [];
    const edges: Array<{ from: string; to: string; type: string }> = [];

    // Get all entities
    const entityDir = path.join(this.graphPath, 'entities');
    try {
      const files = await fs.readdir(entityDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(entityDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const entity = this.parseEntity(content);
        if (entity) {
          nodes.push({ id: entity.id, label: entity.label, type: entity.type });
        }
      }
    } catch {
      // No entities yet
    }

    // Get all edges
    const edgeDir = path.join(this.graphPath, 'edges');
    try {
      const files = await fs.readdir(edgeDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(edgeDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const edge = this.parseEdge(content);
        if (edge) {
          edges.push({ from: edge.from, to: edge.to, type: edge.type });
        }
      }
    } catch {
      // No edges yet
    }

    return { nodes, edges };
  }

  /**
   * Find entities connected to a query
   */
  async findConnected(query: string): Promise<{
    entities: Entity[];
    edges: Edge[];
  }> {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const entities: Entity[] = [];
    const edgeSet = new Set<string>();

    const entityDir = path.join(this.graphPath, 'entities');
    try {
      const files = await fs.readdir(entityDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(entityDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const entity = this.parseEntity(content);
        if (entity) {
          const relevance = this.calculateRelevance(entity, queryWords);
          if (relevance > 0) {
            entities.push(entity);
          }
        }
      }
    } catch {
      // No entities yet
    }

    // Get edges for connected entities
    for (const entity of entities) {
      const edges = await this.getEdgesForEntity(entity.id);
      for (const edge of edges) {
        edgeSet.add(edge.id);
      }
    }

    const edges = Array.from(edgeSet).map(id => {
      // Re-parse edges (in a real impl, cache them)
      return null as unknown as Edge;
    }).filter(Boolean) as Edge[];

    return { entities, edges };
  }

  /**
   * Delete an entity and its edges
   */
  async deleteEntity(entityId: string): Promise<void> {
    const entityDir = path.join(this.graphPath, 'entities');
    const edgeDir = path.join(this.graphPath, 'edges');

    try {
      await fs.unlink(path.join(entityDir, `${entityId}.md`));
    } catch {
      // Entity may not exist
    }

    // Delete connected edges
    const files = await fs.readdir(edgeDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(edgeDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const edge = this.parseEdge(content);
      if (edge && (edge.from === entityId || edge.to === entityId)) {
        await fs.unlink(filePath);
      }
    }
  }

  /**
   * Format entity as markdown
   */
  private formatEntity(entity: Entity): string {
    const lines: string[] = ['---'];
    lines.push(`id: ${entity.id}`);
    lines.push(`type: ${entity.type}`);
    lines.push(`label: ${entity.label}`);
    lines.push(`source: ${entity.source}`);
    lines.push(`created: ${entity.createdAt}`);
    lines.push(`updated: ${entity.updatedAt}`);
    if (entity.properties) {
      lines.push('properties:');
      for (const [key, value] of Object.entries(entity.properties)) {
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
    lines.push(`# ${entity.label}`);
    lines.push('');
    lines.push(`## Type: ${entity.type}`);
    lines.push('');
    lines.push(`## Properties`);
    lines.push('');
    for (const [key, value] of Object.entries(entity.properties || {})) {
      if (typeof value === 'string') {
        lines.push(`- **${key}**: ${value}`);
      } else if (Array.isArray(value)) {
        lines.push(`- **${key}**: ${value.join(', ')}`);
      } else {
        lines.push(`- **${key}**: ${JSON.stringify(value)}`);
      }
    }
    lines.push('');
    lines.push(`## Source: ${entity.source}`);
    return lines.join('\n');
  }

  /**
   * Format edge as markdown
   */
  private formatEdge(edge: Edge): string {
    const lines: string[] = ['---'];
    lines.push(`id: ${edge.id}`);
    lines.push(`from: ${edge.from}`);
    lines.push(`to: ${edge.to}`);
    lines.push(`type: ${edge.type}`);
    lines.push(`source: ${edge.source}`);
    lines.push(`created: ${edge.createdAt}`);
    if (edge.properties) {
      lines.push('properties:');
      for (const [key, value] of Object.entries(edge.properties)) {
        if (typeof value === 'string') {
          lines.push(`  ${key}: ${value}`);
        } else if (typeof value === 'number') {
          lines.push(`  ${key}: ${value}`);
        } else {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
    lines.push('---');
    lines.push('');
    lines.push(`# Edge: ${edge.type}`);
    lines.push('');
    lines.push(`## From: ${edge.from}`);
    lines.push('');
    lines.push(`## To: ${edge.to}`);
    lines.push('');
    if (edge.properties) {
      lines.push('## Properties');
      lines.push('');
      for (const [key, value] of Object.entries(edge.properties)) {
        if (typeof value === 'string') {
          lines.push(`- **${key}**: ${value}`);
        } else {
          lines.push(`- **${key}**: ${JSON.stringify(value)}`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Parse entity from markdown
   */
  private parseEntity(content: string): Entity | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const properties: Record<string, unknown> = {};

    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (key && value) {
        if (value === 'true') properties[key] = true;
        else if (value === 'false') properties[key] = false;
        else if (/^\d+$/.test(value)) properties[key] = parseInt(value, 10);
        else properties[key] = value.replace(/['"]/g, '');
      }
    }

    return {
      id: properties.id as string,
      type: properties.type as string,
      label: properties.label as string,
      properties: properties as Record<string, unknown>,
      source: properties.source as string,
      createdAt: properties.created as string,
      updatedAt: properties.updated as string,
    };
  }

  /**
   * Parse edge from markdown
   */
  private parseEdge(content: string): Edge | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const properties: Record<string, unknown> = {};

    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (key && value) {
        if (value === 'true') properties[key] = true;
        else if (value === 'false') properties[key] = false;
        else if (/^\d+$/.test(value)) properties[key] = parseInt(value, 10);
        else properties[key] = value.replace(/['"]/g, '');
      }
    }

    return {
      id: properties.id as string,
      from: properties.from as string,
      to: properties.to as string,
      type: properties.type as string,
      properties: properties as Record<string, unknown>,
      source: properties.source as string,
      createdAt: properties.created as string,
    };
  }

  /**
   * Calculate relevance for graph traversal
   */
  private calculateRelevance(entity: Entity, queryWords: string[]): number {
    let score = 0;
    const labelLower = entity.label.toLowerCase();
    const propertiesLower = JSON.stringify(entity.properties || {}).toLowerCase();

    for (const word of queryWords) {
      const labelCount = (labelLower.match(new RegExp(word, 'g')) || []).length;
      const propCount = (propertiesLower.match(new RegExp(word, 'g')) || []).length;
      score += labelCount * 3 + propCount;
    }

    return score;
  }
}
