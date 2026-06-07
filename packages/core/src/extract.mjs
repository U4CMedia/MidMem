/**
 * Extractor — turns raw source text into {summary, concepts, claims}.
 *
 * Primary: LM Studio chat completion (JSON-instructed). Fallback: deterministic
 * heuristics so ingest works offline / under model saturation. The scaffold did
 * extraction with regex only and never called an LLM at all.
 */
import { tokenize } from './util.mjs';

const SYS = `You extract structured knowledge. Return ONLY minified JSON:
{"summary":"1-3 sentences","concepts":[{"name":"","type":"concept|entity|tool|person|org","confidence":0..1}],"claims":[{"content":"one factual claim","confidence":0..1}]}`;

export class Extractor {
  constructor(cfg) { this.cfg = cfg; this.lastMode = 'unknown'; }

  /** @returns {Promise<{summary:string, concepts:Array, claims:Array, mode:string}>} */
  async extract(text, type = 'note') {
    if (this.cfg.llmEnabled) {
      const r = await this.#remote(text, type);
      if (r) { this.lastMode = 'lmstudio'; return { ...r, mode: 'lmstudio' }; }
    }
    this.lastMode = 'fallback';
    return { ...this.#fallback(text), mode: 'fallback' };
  }

  async #remote(text, type) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.llmTimeoutMs);
    try {
      const res = await fetch(`${this.cfg.llmEndpoint}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.extractModel, temperature: 0,
          messages: [{ role: 'system', content: SYS },
            { role: 'user', content: `type=${type}\n\n${text.slice(0, 12000)}` }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) return null;
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]);
      return {
        summary: String(obj.summary || '').slice(0, 2000),
        concepts: Array.isArray(obj.concepts) ? obj.concepts.slice(0, 50) : [],
        claims: Array.isArray(obj.claims) ? obj.claims.slice(0, 50) : [],
      };
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  /** Deterministic heuristic extraction (no LLM). */
  #fallback(text) {
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 15);
    const summary = sentences.slice(0, 2).join(' ').slice(0, 600) || text.slice(0, 300);
    // frequent tokens → concepts; Capitalized words → entity candidates
    const freq = new Map();
    for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1);
    const concepts = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, n]) => ({ name, type: 'concept', confidence: Math.min(0.5 + n / 50, 0.9) }));
    const caps = [...new Set((text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []))].slice(0, 8)
      .map((name) => ({ name, type: 'entity', confidence: 0.5 }));
    const claims = sentences.slice(0, 5).map((content) => ({ content: content.trim(), confidence: 0.5 }));
    return { summary, concepts: [...concepts, ...caps].slice(0, 16), claims };
  }
}
