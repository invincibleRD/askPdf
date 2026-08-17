import { createLogger } from '../../core/logger.js';
import * as chatService from './chat.service.js';

const log = createLogger('chat:http');

export async function ask(req, res) {
  const result = await chatService.ask({
    ownerId: req.user.id,
    documentId: req.body.documentId,
    question: req.body.question,
    conversationId: req.body.conversationId,
  });

  res.status(200).json(result);
}

/**
 * Streams an answer over Server-Sent Events.
 *
 * Hand-written because the failure mode matters: once headers are flushed the
 * status can't change, so a mid-stream error has to arrive as an event.
 */
export async function askStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which would hold the whole
    // answer back and defeat streaming entirely.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // No point finishing a generation nobody is reading.
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  try {
    for await (const event of chatService.askStream({
      ownerId: req.user.id,
      documentId: req.body.documentId,
      question: req.body.question,
      conversationId: req.body.conversationId,
    })) {
      if (aborted) {
        log.info('client disconnected, abandoning stream');
        return;
      }

      send(event.type, event);
    }
  } catch (error) {
    log.error({ err: error }, 'chat stream failed');

    send('error', {
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.isOperational ? error.message : 'The answer could not be generated',
      ...(error.details ? { details: error.details } : {}),
    });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

export async function listConversations(req, res) {
  const conversations = await chatService.listConversations({
    ownerId: req.user.id,
    documentId: req.query.documentId,
    limit: req.query.limit,
  });

  res.status(200).json({ items: conversations });
}

export async function getConversation(req, res) {
  const conversation = await chatService.getConversation({
    conversationId: req.params.id,
    ownerId: req.user.id,
  });

  res.status(200).json({ conversation });
}
