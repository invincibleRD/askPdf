import { DocumentStatus, MessageRole } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { DocumentNotReadyError, NoRelevantContextError, NotFoundError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { getAiProvider } from '../../infra/ai/index.js';
import { toObjectId } from '../../infra/mongo/schema-helpers.js';
import { findDocumentForOwner } from '../documents/document.repository.js';
import { Conversation, MAX_MESSAGES } from './conversation.model.js';
import { REFUSAL_MESSAGE, SYSTEM_PROMPT, buildPrompt, toCitations } from './prompt.js';
import { applyThreshold, searchChunks } from './vector-search.js';

const log = createLogger('chat');

/** How many prior turns are replayed into the prompt. */
const HISTORY_TURNS = 4;

/**
 * Retrieves the passages that can answer a question.
 *
 * Throws rather than returning empty when nothing clears the floor, so no
 * caller can accidentally generate from weak context.
 */
export async function retrieveContext({ documentId, ownerId, question }) {
  const document = await findDocumentForOwner(documentId, ownerId);

  if (!document) {
    throw new NotFoundError('Document');
  }

  if (document.status !== DocumentStatus.READY) {
    throw new DocumentNotReadyError(document.status);
  }

  const ai = getAiProvider();
  // Queries and documents are embedded with different task types; mixing them
  // measurably degrades ranking.
  const [queryVector] = await ai.embed([question], { taskType: 'RETRIEVAL_QUERY' });

  const results = await searchChunks({ documentId, ownerId, queryVector });
  const { passed, bestScore, threshold } = applyThreshold(results);

  log.info(
    { documentId, candidates: results.length, passed: passed.length, bestScore, threshold },
    'retrieval complete',
  );

  if (passed.length === 0) {
    throw new NoRelevantContextError(threshold, Number(bestScore.toFixed(4)));
  }

  return { document, passages: passed, bestScore };
}

/**
 * Answers a question about a document.
 *
 * @param {{ documentId: string, ownerId: string, question: string, conversationId?: string }} input
 */
export async function ask({ documentId, ownerId, question, conversationId }) {
  const conversation = await loadOrCreateConversation({ conversationId, documentId, ownerId });

  let context;
  try {
    context = await retrieveContext({ documentId, ownerId, question });
  } catch (error) {
    if (error instanceof NoRelevantContextError) {
      // A refusal is a real turn in the conversation, not an error to discard:
      // the history is what a user sees, and hiding it makes the assistant look
      // like it silently ignored them.
      await appendTurn(conversation, [
        { role: MessageRole.USER, content: question },
        {
          role: MessageRole.ASSISTANT,
          content: REFUSAL_MESSAGE,
          refused: true,
          bestScore: error.details?.bestScore,
        },
      ]);
    }
    throw error;
  }

  const ai = getAiProvider();
  const prompt = buildPrompt({
    question,
    passages: context.passages,
    history: recentHistory(conversation),
  });

  const answer = await ai.generate({ system: SYSTEM_PROMPT, prompt });
  const citations = toCitations(context.passages);

  await appendTurn(conversation, [
    { role: MessageRole.USER, content: question },
    { role: MessageRole.ASSISTANT, content: answer, citations },
  ]);

  return {
    conversationId: conversation.id,
    answer,
    citations,
    bestScore: Number(context.bestScore.toFixed(4)),
  };
}

/**
 * Streams an answer token by token.
 *
 * Yields structured events rather than raw text so the controller stays a thin
 * SSE encoder, and so citations can be sent before the first token — a client
 * can render the sources while the answer is still arriving.
 */
export async function* askStream({ documentId, ownerId, question, conversationId }) {
  const conversation = await loadOrCreateConversation({ conversationId, documentId, ownerId });

  let context;
  try {
    context = await retrieveContext({ documentId, ownerId, question });
  } catch (error) {
    if (error instanceof NoRelevantContextError) {
      await appendTurn(conversation, [
        { role: MessageRole.USER, content: question },
        {
          role: MessageRole.ASSISTANT,
          content: REFUSAL_MESSAGE,
          refused: true,
          bestScore: error.details?.bestScore,
        },
      ]);

      yield { type: 'refusal', message: REFUSAL_MESSAGE, ...error.details };
      yield { type: 'done', conversationId: conversation.id };
      return;
    }
    throw error;
  }

  const citations = toCitations(context.passages);
  yield { type: 'citations', conversationId: conversation.id, citations };

  const ai = getAiProvider();
  const prompt = buildPrompt({
    question,
    passages: context.passages,
    history: recentHistory(conversation),
  });

  let answer = '';
  for await (const delta of ai.generateStream({ system: SYSTEM_PROMPT, prompt })) {
    answer += delta;
    yield { type: 'delta', text: delta };
  }

  await appendTurn(conversation, [
    { role: MessageRole.USER, content: question },
    { role: MessageRole.ASSISTANT, content: answer, citations },
  ]);

  yield { type: 'done', conversationId: conversation.id, characters: answer.length };
}

async function loadOrCreateConversation({ conversationId, documentId, ownerId }) {
  if (conversationId) {
    const existing = await Conversation.findOne({
      _id: toObjectId(conversationId),
      ownerId: toObjectId(ownerId),
      documentId: toObjectId(documentId),
    });

    if (!existing) {
      throw new NotFoundError('Conversation');
    }

    return existing;
  }

  return Conversation.create({
    documentId: toObjectId(documentId),
    ownerId: toObjectId(ownerId),
  });
}

/**
 * Appends a user/assistant pair.
 *
 * `$slice` caps the array in the same write, so a long-running conversation
 * cannot grow past the document size limit.
 */
async function appendTurn(conversation, messages) {
  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $push: { messages: { $each: messages, $slice: -MAX_MESSAGES } },
      ...(conversation.title ? {} : { $set: { title: messages[0].content.slice(0, 200) } }),
    },
  );
}

/** Last few turns, so a follow-up like "what about the second one?" resolves. */
function recentHistory(conversation) {
  return (conversation.messages ?? [])
    .slice(-HISTORY_TURNS * 2)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 1_000) }));
}

export async function listConversations({ ownerId, documentId, limit = 20 }) {
  const filter = { ownerId: toObjectId(ownerId) };
  if (documentId) {
    filter.documentId = toObjectId(documentId);
  }

  const conversations = await Conversation.find(filter, { messages: { $slice: -2 } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean()
    .exec();

  return conversations.map((conversation) => ({
    id: String(conversation._id),
    documentId: String(conversation.documentId),
    title: conversation.title,
    messageCount: conversation.messages?.length ?? 0,
    updatedAt: conversation.updatedAt,
  }));
}

export async function getConversation({ conversationId, ownerId }) {
  const conversation = await Conversation.findOne({
    _id: toObjectId(conversationId),
    ownerId: toObjectId(ownerId),
  })
    .lean()
    .exec();

  if (!conversation) {
    throw new NotFoundError('Conversation');
  }

  return {
    id: String(conversation._id),
    documentId: String(conversation.documentId),
    title: conversation.title,
    messages: conversation.messages,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export { env };
