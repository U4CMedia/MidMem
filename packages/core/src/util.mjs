/** Small shared helpers (Node built-ins only). */
import { createHash, randomUUID } from 'node:crypto';

export const nowISO = () => new Date().toISOString();

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const sha12 = (s) => sha(s).slice(0, 12);

/** Stable, readable id: `<prefix>-<base36 time>-<hash>`. */
export function genId(prefix, seed = randomUUID()) {
  return `${prefix}-${Date.now().toString(36)}-${sha12(String(seed))}`;
}

/** Cosine similarity of two equal-length numeric vectors. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m === 0 ? 0 : dot / m;
}

/** Tokenize to lowercase words ≥3 chars (shared by fallbacks + sanitizers). */
export const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);

/**
 * Build a safe FTS5 MATCH expression from free text (prevents the scaffold's
 * regex-injection / FTS-syntax-injection). Returns null if no usable tokens.
 */
export function ftsMatchExpr(query) {
  const toks = [...new Set(tokenize(query))].slice(0, 24);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"`).join(' OR ');
}

/** Serialize an object to YAML frontmatter (Obsidian-friendly; nested → JSON). */
export function frontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    else if (typeof v === 'object') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export const json = (v, d = null) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };
