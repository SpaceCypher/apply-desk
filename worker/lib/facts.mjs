// Fact checker. A rewritten line passes only when everything checkable in it is supported by the profile.
// Checkable = numbers, and capitalised or technical tokens (names, tools, titles).
const COMMON = new Set(['built', 'led', 'developed', 'designed', 'implemented', 'created', 'improved', 'reduced', 'increased',
  'using', 'with', 'and', 'the', 'for', 'to', 'in', 'of', 'a', 'an', 'on', 'by', 'as', 'at', 'that', 'which', 'across',
  'worked', 'delivered', 'managed', 'wrote', 'shipped', 'deployed', 'automated', 'optimised', 'optimized', 'engineered',
  'collaborated', 'contributed', 'maintained', 'tested', 'analysed', 'analyzed', 'integrated', 'owned', 'launched'])

export function checkableTokens(text) {
  const tokens = new Set()
  for (const m of text.matchAll(/\d[\d,.]*\s*(%|k|m|x|\+)?/gi)) tokens.add(m[0].replace(/[\s,]/g, '').toLowerCase())
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+#.\-/]*/g)) {
    const w = m[0].replace(/[.\-/]+$/, '')
    // A plain capitalised word that opens a sentence is just grammar, not a claim.
    const opensSentence = /^[A-Z][a-z]+$/.test(w) && /(^|[.!?:\n]\s*)$/.test(text.slice(0, m.index))
    const technical = !opensSentence && /[A-Z].*[A-Z]|[a-z][A-Z]|[0-9+#]|^[A-Z]/.test(w)
    if (technical && w.length > 1 && !COMMON.has(w.toLowerCase())) tokens.add(w.toLowerCase())
  }
  return tokens
}

function corpusTokens(corpus) {
  const set = new Set()
  for (const t of checkableTokens(corpus)) set.add(t)
  for (const m of corpus.toLowerCase().matchAll(/[a-z0-9+#.\-/]+/g)) set.add(m[0].replace(/[.\-/]+$/, ''))
  return set
}

// Returns {ok, unsupported[]}. Sentence-initial capitalised verbs are ignored via COMMON and lowercase fallback.
export function verifySupported(candidate, corpus) {
  const supported = corpusTokens(corpus)
  const unsupported = []
  for (const token of checkableTokens(candidate)) {
    if (!supported.has(token) && !supported.has(token.replace(/s$/, ''))) unsupported.push(token)
  }
  return { ok: unsupported.length === 0, unsupported }
}

export function profileCorpus(profile) {
  const parts = []
  const walk = value => {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  const { sensitive, writing_samples, resume_tex, ...rest } = profile
  walk(rest)
  return parts.join('\n')
}
