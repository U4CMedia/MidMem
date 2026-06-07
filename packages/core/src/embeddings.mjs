/**
 * Embedder — vectors for hybrid RAG.
 *
 * Primary: LM Studio OpenAI-compatible /embeddings (plumbing proven in the
 * scaffold's semantic-cache). Fallback: a deterministic hashed term vector so
 * the pipeline is fully testable offline and when the local model saturates.
 * Same interface either way; callers never branch on availability.
 */
import { tokenize } from './util.mjs';

export class Embedder {
  /** @param {ReturnType<import('./config.mjs').loadConfig>} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.lastMode = 'unknown';
  }

  /** @returns {Promise<{vector:number[], model:string, mode:'lmstudio'|'fallback'}>} */
  async embed(text) {
    if (this.cfg.llmEnabled) {
      const v = await this.#remote(text);
      if (v) { this.lastMode = 'lmstudio'; return { vector: v, model: this.cfg.embedModel, mode: 'lmstudio' }; }
    }
    this.lastMode = 'fallback';
    return { vector: this.#fallback(text), model: `fallback-hash-${this.cfg.fallbackDim}`, mode: 'fallback' };
  }

  async #remote(text) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.llmTimeoutMs);
    try {
      const res = await fetch(`${this.cfg.llmEndpoint}/embeddings`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.cfg.embedModel, input: text.slice(0, 8000) }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const v = data?.data?.[0]?.embedding;
      return Array.isArray(v) && v.length ? v : null;
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  /** Deterministic hashed bag-of-words vector, L2-normalized. */
  #fallback(text) {
    const dim = this.cfg.fallbackDim;
    const v = new Array(dim).fill(0);
    for (const tok of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
      v[((h % dim) + dim) % dim] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
