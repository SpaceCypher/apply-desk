// Answer-bank matching by meaning (Vertex embeddings), with word overlap as the fallback when embeddings are
// unavailable (no credentials, tests, the bench's scripted planner). Bank embeddings are cached in answer_bank.
import { findAnswer } from './answers.mjs'
import { hasRealModel, embed } from './gemini.mjs'

const MODEL = () => process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001'
export const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export function createMatcher(db, bank, { threshold = 0.82, enabled = hasRealModel() } = {}) {
  const labelCache = new Map()
  let ready = null
  const ensureBank = async () => {
    if (!enabled) return false
    ready ??= (async () => {
      const missing = bank.filter(b => !b.embedding || b.embedding_model !== MODEL())
      if (missing.length) {
        const vecs = await embed(missing.map(b => b.question), MODEL())
        for (let i = 0; i < missing.length; i++) {
          missing[i].embedding = vecs[i]; missing[i].embedding_model = MODEL()
          await db?.query('UPDATE answer_bank SET embedding=$2, embedding_model=$3 WHERE question=$1', [missing[i].question, vecs[i], MODEL()]).catch(() => {})
        }
      }
      return true
    })().catch(() => false)
    return ready
  }
  return {
    // labels -> { label: { question, answer, score } } for the ones that match.
    async hits(labels) {
      const out = {}
      const useEmbeddings = await ensureBank()
      const todo = useEmbeddings ? labels.filter(l => !labelCache.has(l)) : []
      if (todo.length) {
        try { const vecs = await embed(todo, MODEL()); todo.forEach((l, i) => labelCache.set(l, vecs[i])) } catch { /* fall back below */ }
      }
      for (const label of labels) {
        const v = labelCache.get(label)
        let best = null
        if (v) for (const b of bank) { if (!b.embedding) continue; const s = cosine(v, b.embedding); if (!best || s > best.score) best = { question: b.question, answer: b.answer, score: s } }
        if (best && best.score >= threshold) out[label] = best
        else { const w = findAnswer(label, bank, 0.5); if (w) out[label] = w }
      }
      return out
    },
  }
}
