// Answer bank: exact match first, then similarity over word sets. No network needed.
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'for', 'on', 'at', 'and', 'or', 'is', 'are', 'do', 'you', 'your', 'have', 'has', 'be', 'will', 'would', 'please', 'this', 'that', 'with', 'by', 'as'])

export function normalize(question) {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function stem(w) {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w
}
function words(question) {
  return new Set(normalize(question).split(' ').filter(w => w && !STOP.has(w)).map(stem))
}

export function similarity(a, b) {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let overlap = 0
  for (const w of x) if (y.has(w)) overlap++
  return overlap / (x.size + y.size - overlap)
}

// entries: [{question, answer}]. Returns {answer, question, score} when confident enough.
export function findAnswer(question, entries, threshold = 0.7) {
  const n = normalize(question)
  let best
  for (const entry of entries) {
    const score = normalize(entry.question) === n ? 1 : similarity(question, entry.question)
    if (!best || score > best.score) best = { answer: entry.answer, question: entry.question, score }
  }
  return best && best.score >= threshold ? best : null
}
