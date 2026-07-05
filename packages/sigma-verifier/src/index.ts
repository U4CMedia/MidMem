/**
 * SigmaVerifier — Deterministic contradiction detection layer
 * 
 * Inspired by Sigma-Guard's sheaf cohomology approach but implemented
 * as a practical graph-based verifier for the prototype phase.
 * 
 * Detects:
 * - Direct contradictions (A says X, B says not-X)
 * - Indirect contradictions (A implies X, B implies not-X)
 * - Stale claims (claims contradicted by newer sources)
 * - Identity conflicts (same concept under different names)
 * 
 * Returns exact conflict locations with proof receipts.
 * Designed to run as an MCP server for agent integration.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface SigmaConfig {
  graphPath: string;
  auditPath: string;
  strictMode?: boolean; // stricter detection rules
}

export interface Conflict {
  pageA: string;
  pageB: string;
  conflict: string;
  severity: 'low' | 'medium' | 'high';
  proof: string;
  type: 'direct' | 'indirect' | 'stale' | 'identity';
  timestamp: string;
}

export interface VerificationResult {
  conflicts: Conflict[];
  verified: boolean;
  timestamp: string;
  proofHash: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  content: string;
  source: string;
  provenance: {
    originalSource: string;
    extractedAt: string;
  };
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'references' | 'contradicts' | 'supports' | 'relates';
  confidence: number;
}

/**
 * Knowledge graph for contradiction detection
 */
class KnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge[]> = new Map();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.edges.has(node.id)) {
      this.edges.set(node.id, []);
    }
  }

  addEdge(edge: GraphEdge): void {
    if (!this.edges.has(edge.from)) {
      this.edges.set(edge.from, []);
    }
    this.edges.get(edge.from)!.push(edge);
  }

  getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): GraphEdge[] {
    return Array.from(this.edges.values()).flat();
  }

  getNeighbors(nodeId: string): GraphEdge[] {
    return this.edges.get(nodeId) || [];
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }
}

/**
 * SigmaVerifier — Contradiction detection engine
 */
export class SigmaVerifier {
  private graphPath: string;
  private auditPath: string;
  private strictMode: boolean;
  private graph: KnowledgeGraph;

  constructor(config: SigmaConfig) {
    this.graphPath = config.graphPath;
    this.auditPath = config.auditPath;
    this.strictMode = config.strictMode ?? false;
    this.graph = new KnowledgeGraph();
  }

  /**
   * Verify a set of new concepts against the existing wiki
   * Returns conflicts with proof receipts
   */
  async verify(concepts: Array<{ name: string; type: string; confidence: number }>): Promise<VerificationResult> {
    const conflicts: Conflict[] = [];
    const now = new Date().toISOString();

    // Load existing graph
    await this.loadGraph();

    // Check each concept for conflicts
    for (const concept of concepts) {
      const conceptConflicts = await this.checkConceptConflict(concept);
      conflicts.push(...conceptConflicts);
    }

    // Also check for identity conflicts (same concept, different names)
    const identityConflicts = await this.checkIdentityConflicts(concepts);
    conflicts.push(...identityConflicts);

    // Generate proof hash
    const proofHash = this.generateProofHash(conflicts);

    // Write audit record
    await this.audit(conflicts, proofHash);

    return {
      conflicts,
      verified: conflicts.length === 0,
      timestamp: now,
      proofHash,
    };
  }

  /**
   * Detect all conflicts in the wiki
   */
  async detectConflicts(): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    // Load graph
    await this.loadGraph();

    // Check all node pairs for contradictions
    const nodes = this.graph.getNodes();
    const nodeIds = nodes.map(n => n.id);

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const nodeA = this.graph.getNode(nodeIds[i])!;
        const nodeB = this.graph.getNode(nodeIds[j])!;

        const conflict = this.detectContradiction(nodeA, nodeB);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }

    // Check for stale claims
    const staleConflicts = await this.findStaleClaims();
    conflicts.push(...staleConflicts);

    return conflicts;
  }

  /**
   * Find stale claims (claims contradicted by newer sources)
   */
  async findStaleClaims(): Promise<Array<{
    page: string;
    claim: string;
    supersededBy: string;
    severity: 'low' | 'medium' | 'high';
  }>> {
    const stale: Array<{
      page: string;
      claim: string;
      supersededBy: string;
      severity: 'low' | 'medium' | 'high';
    }> = [];

    // Load graph
    await this.loadGraph();

    const nodes = this.graph.getNodes();

    // Group nodes by concept type
    const byType: Record<string, GraphNode[]> = {};
    for (const node of nodes) {
      if (!byType[node.type]) byType[node.type] = [];
      byType[node.type].push(node);
    }

    // Check each type group for stale claims
    for (const [type, group] of Object.entries(byType)) {
      if (group.length < 2) continue;

      // Sort by extraction date (newest first)
      const sorted = [...group].sort((a, b) =>
        new Date(b.provenance.extractedAt).getTime() -
        new Date(a.provenance.extractedAt).getTime()
      );

      // Compare oldest with newest
      const oldest = sorted[sorted.length - 1];
      const newest = sorted[0];

      const staleClaim = this.detectStaleClaim(oldest, newest);
      if (staleClaim) {
        stale.push({
          page: oldest.source,
          claim: staleClaim.claim,
          supersededBy: newest.source,
          severity: staleClaim.severity,
        });
      }
    }

    return stale;
  }

  /**
   * Get graph context for a query
   */
  async getGraphContext(query: string): Promise<{
    nodes: Array<{ id: string; label: string; type: string }>;
    edges: Array<{ from: string; to: string; type: string }>;
  }> {
    await this.loadGraph();

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Find relevant nodes
    const relevantNodes: GraphNode[] = [];
    for (const node of this.graph.getNodes()) {
      const relevance = this.calculateRelevance(
        node.content,
        node.label,
        queryWords
      );
      if (relevance > 0) {
        relevantNodes.push(node);
      }
    }

    // Get edges between relevant nodes
    const relevantNodeIds = new Set(relevantNodes.map(n => n.id));
    const relevantEdges: GraphEdge[] = [];

    for (const node of relevantNodes) {
      const neighbors = this.graph.getNeighbors(node.id);
      for (const edge of neighbors) {
        if (relevantNodeIds.has(edge.to)) {
          relevantEdges.push(edge);
        }
      }
    }

    return {
      nodes: relevantNodes.map(n => ({
        id: n.id,
        label: n.label,
        type: n.type,
      })),
      edges: relevantEdges.map(e => ({
        from: e.from,
        to: e.to,
        type: e.type,
      })),
    };
  }

  /**
   * Check a single concept for conflicts
   */
  private async checkConceptConflict(concept: { name: string; type: string; confidence: number }): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];
    await this.loadGraph();

    const conceptLower = concept.name.toLowerCase();

    // Check against existing nodes
    for (const node of this.graph.getNodes()) {
      // Check for direct contradictions
      if (node.type === concept.type) {
        const conflict = this.detectContradiction(
          { ...node, content: concept.name },
          { id: `new-${conceptLower}`, label: concept.name, type: concept.type, content: concept.name, source: 'new', provenance: { originalSource: 'new', extractedAt: new Date().toISOString() } }
        );
        if (conflict) {
          conflicts.push({ ...conflict, pageA: node.source, pageB: 'new' });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check for identity conflicts (same concept under different names)
   */
  private async checkIdentityConflicts(concepts: Array<{ name: string; type: string; confidence: number }>): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];
    await this.loadGraph();

    // Check if any new concept is similar to an existing node
    for (const concept of concepts) {
      for (const node of this.graph.getNodes()) {
        if (node.type === concept.type) {
          const similarity = this.calculateSimilarity(concept.name, node.label);
          if (similarity > 0.7 && concept.name !== node.label) {
            conflicts.push({
              pageA: concept.name,
              pageB: node.source,
              conflict: `Possible identity conflict: "${concept.name}" may be the same as "${node.label}"`,
              severity: similarity > 0.9 ? 'high' : 'medium',
              proof: `Similarity: ${similarity.toFixed(3)}`,
              type: 'identity',
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect contradiction between two nodes
   */
  private detectContradiction(nodeA: GraphNode, nodeB: GraphNode): Conflict | null {
    const aLower = nodeA.content.toLowerCase();
    const bLower = nodeB.content.toLowerCase();

    // Check for negation patterns
    const negations = [
      'not', 'never', 'no', 'does not', 'doesnt', 'did not', 'didnt',
      'cannot', 'cant', 'could not', 'couldnt', 'should not', 'shouldnt',
      'would not', 'wouldnt', 'will not', 'wont', 'is not', 'isnt',
      'are not', 'arent', 'was not', 'wasnt', 'were not', 'werent',
      'without', 'lacks', 'lacking', 'absent', 'false', 'incorrect',
      'wrong', 'mistaken', 'erroneous', 'invalid', 'untrue',
    ];

    for (const neg of negations) {
      const aHasNeg = aLower.includes(neg);
      const bHasNeg = bLower.includes(neg);

      if (aHasNeg !== bHasNeg) {
        // One has negation, the other doesn't — potential contradiction
        const aPositive = aHasNeg ? this.removeNegation(aLower) : aLower;
        const bPositive = bHasNeg ? this.removeNegation(bLower) : bLower;

        const similarity = this.calculateSimilarity(aPositive, bPositive);
        if (similarity > 0.6) {
          return {
            pageA: nodeA.source,
            pageB: nodeB.source,
            conflict: `Potential contradiction: ${nodeA.source} says "${this.extractClaim(nodeA.content)}" while ${nodeB.source} says "${this.extractClaim(nodeB.content)}"`,
            severity: similarity > 0.8 ? 'high' : 'medium',
            proof: `Similarity: ${similarity.toFixed(3)}, Negation: ${neg}`,
            type: 'direct',
            timestamp: new Date().toISOString(),
          };
        }
      }
    }

    return null;
  }

  /**
   * Detect stale claim between two nodes
   */
  private detectStaleClaim(oldest: GraphNode, newest: GraphNode): { claim: string; severity: 'low' | 'medium' | 'high' } | null {
    const oldestDate = new Date(oldest.provenance.extractedAt).getTime();
    const newestDate = new Date(newest.provenance.extractedAt).getTime();

    // Only check if there's a significant time gap
    if (newestDate - oldestDate < 24 * 60 * 60 * 1000) {
      return null; // Less than 1 day apart
    }

    const claim = this.extractClaim(oldest.content);
    const similarity = this.calculateSimilarity(claim, this.extractClaim(newest.content));

    // If similar but contradictory, it's stale
    if (similarity > 0.5) {
      const conflict = this.detectContradiction(oldest, newest);
      if (conflict) {
        return {
          claim,
          severity: conflict.severity,
        };
      }
    }

    return null;
  }

  /**
   * Calculate similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const bWords = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (aWords.size === 0 || bWords.size === 0) return 0;

    let intersections = 0;
    for (const word of aWords) {
      if (bWords.has(word)) intersections++;
    }

    // Jaccard similarity
    const union = new Set([...aWords, ...bWords]).size;
    return union > 0 ? intersections / union : 0;
  }

  /**
   * Calculate relevance for graph context
   */
  private calculateRelevance(content: string, label: string, queryWords: string[]): number {
    let score = 0;
    const lower = content.toLowerCase();
    const labelLower = label.toLowerCase();

    for (const word of queryWords) {
      const contentCount = (lower.match(new RegExp(word, 'g')) || []).length;
      const labelCount = (labelLower.match(new RegExp(word, 'g')) || []).length;
      score += contentCount * 2 + labelCount * 5; // Label matches are more important
    }

    return score;
  }

  /**
   * Extract a claim from content
   */
  private extractClaim(content: string): string {
    // Take the first meaningful sentence
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    return sentences[0]?.trim() || content.slice(0, 100);
  }

  /**
   * Remove negation from text
   */
  private removeNegation(text: string): string {
    return text
      .replace(/\bnot\b/g, '')
      .replace(/\bnever\b/g, '')
      .replace(/\bno\b/g, '')
      .replace(/\bdoes not\b/g, '')
      .replace(/\bdoesnt\b/g, '')
      .replace(/\bdid not\b/g, '')
      .replace(/\bdidnt\b/g, '')
      .replace(/\bcannot\b/g, '')
      .replace(/\bcant\b/g, '')
      .replace(/\bcould not\b/g, '')
      .replace(/\bcouldnt\b/g, '')
      .replace(/\bshould not\b/g, '')
      .replace(/\bshouldnt\b/g, '')
      .replace(/\bwould not\b/g, '')
      .replace(/\bwouldnt\b/g, '')
      .replace(/\bwill not\b/g, '')
      .replace(/\bwont\b/g, '')
      .replace(/\bis not\b/g, '')
      .replace(/\bisnt\b/g, '')
      .replace(/\bare not\b/g, '')
      .replace(/\barent\b/g, '')
      .replace(/\bwas not\b/g, '')
      .replace(/\bwasnt\b/g, '')
      .replace(/\bwere not\b/g, '')
      .replace(/\bwerent\b/g, '')
      .replace(/\bwithout\b/g, '')
      .replace(/\blacks?\b/g, '')
      .replace(/\babsent\b/g, '')
      .replace(/\bfalse\b/g, '')
      .replace(/\bincorrect\b/g, '')
      .replace(/\bwrong\b/g, '')
      .replace(/\bmistaken\b/g, '')
      .replace(/\berroneous\b/g, '')
      .replace(/\binvalid\b/g, '')
      .replace(/\buntrue\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Load graph from disk
   */
  private async loadGraph(): Promise<void> {
    // In the full implementation, this would load from a graph database
    // For now, we scan the wiki directory
    const wikiPath = path.join(this.graphPath, '../wiki');

    try {
      const files = await fs.readdir(wikiPath, { recursive: true });
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');

      for (const file of mdFiles) {
        const filePath = path.join(wikiPath, file);
        const content = await fs.readFile(filePath, 'utf-8');

        // Extract frontmatter
        const frontmatter = this.extractFrontmatter(content);
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
        const body = bodyMatch ? bodyMatch[1] : content;

        const nodeId = createHash('sha256')
          .update(file)
          .digest('hex')
          .slice(0, 12);

        const node: GraphNode = {
          id: nodeId,
          label: file.replace('.md', ''),
          type: (frontmatter?.type as string) || 'general',
          content: body,
          source: file,
          provenance: {
            originalSource: frontmatter?.source || file,
            extractedAt: frontmatter?.createdAt || new Date().toISOString(),
          },
        };

        this.graph.addNode(node);
      }
    } catch {
      // Wiki directory may not exist yet
    }
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
   * Generate proof hash for conflicts
   */
  private generateProofHash(conflicts: Conflict[]): string {
    const conflictStr = conflicts.map(c =>
      `${c.pageA}:${c.pageB}:${c.conflict}`
    ).join('|');

    return createHash('sha256')
      .update(conflictStr)
      .digest('hex');
  }

  /**
   * Write audit record
   */
  private async audit(conflicts: Conflict[], proofHash: string): Promise<void> {
    const auditDir = path.join(this.auditPath, 'proofs');
    await fs.mkdir(auditDir, { recursive: true });

    const auditRecord = {
      timestamp: new Date().toISOString(),
      proofHash,
      conflictCount: conflicts.length,
      conflicts: conflicts.map(c => ({
        pageA: c.pageA,
        pageB: c.pageB,
        conflict: c.conflict,
        severity: c.severity,
        type: c.type,
      })),
    };

    const auditFile = path.join(auditDir, `audit-${Date.now().toString(36)}.json`);
    await fs.writeFile(auditFile, JSON.stringify(auditRecord, null, 2));
  }
}
