/**
 * Instruction that keeps answers inside the document.
 *
 * The refusal clause is the important part: without an explicit permission to
 * say "not in the document", a model asked a question it cannot answer will
 * reach for general knowledge and produce something plausible and wrong.
 */
export const SYSTEM_PROMPT = [
  'You answer questions about a single document, using only the numbered context passages provided.',
  '',
  'Rules:',
  '- Use only the context. Never use outside knowledge, even if you are confident it is correct.',
  '- If the context does not answer the question, say so plainly and stop. Do not guess.',
  '- Cite the passages you used inline, like [1] or [2, 3].',
  '- Quote exact figures, names and units from the context rather than paraphrasing them.',
  '- Answer in the language of the question.',
  '- Be concise: a few sentences unless the question needs more.',
].join('\n');

/**
 * Builds the user turn.
 *
 * Passages are numbered so the model can cite them, and labelled with their
 * page so a citation resolves to somewhere a reader can look. The question
 * comes last: instructions that appear after a long context block are followed
 * more reliably than ones buried before it.
 *
 * @param {{ question: string, passages: Array<{ index: number, text: string, pageStart?: number, pageEnd?: number }>, history?: Array<{ role: string, content: string }> }} params
 */
export function buildPrompt({ question, passages, history = [] }) {
  const context = passages
    .map((passage, i) => `[${String(i + 1)}] (${formatPages(passage)})\n${passage.text}`)
    .join('\n\n');

  const priorTurns =
    history.length > 0
      ? `Earlier in this conversation:\n${history
          .map((turn) => `${turn.role === 'user' ? 'Q' : 'A'}: ${turn.content}`)
          .join('\n')}\n\n`
      : '';

  return `${priorTurns}Context:\n${context}\n\nQuestion: ${question}`;
}

function formatPages(passage) {
  if (!passage.pageStart) {
    return 'page unknown';
  }

  return passage.pageEnd && passage.pageEnd !== passage.pageStart
    ? `pages ${String(passage.pageStart)}–${String(passage.pageEnd)}`
    : `page ${String(passage.pageStart)}`;
}

/** The answer returned when nothing clears the similarity floor. */
export const REFUSAL_MESSAGE =
  'I could not find anything in this document that answers that question.';

/**
 * Turns retrieval hits into the citation records stored with an answer.
 *
 * The snippet is truncated: it exists so a user can see why a passage was
 * cited without re-fetching the chunk.
 */
export function toCitations(passages) {
  return passages.map((passage) => ({
    chunkIndex: passage.index,
    pageStart: passage.pageStart,
    pageEnd: passage.pageEnd,
    score: Number(passage.score.toFixed(4)),
    snippet: passage.text.slice(0, 300),
  }));
}
