import { API_PREFIX } from '../http/routes.js';
import { DocumentStatus, ErrorCode, JobStatus, PIPELINE_STAGES } from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * The API contract, written as a plain object.
 *
 * Hand-authored rather than generated from decorators: generation ties the
 * contract to the framework, and the point of a spec is that it outlives the
 * implementation. A test asserts every registered route appears here, so it
 * cannot silently drift.
 */

const errorResponse = (description, code) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      ...(code ? { example: { error: { code, message: 'string' }, requestId: 'string' } } : {}),
    },
  },
});

const jsonBody = (schema) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const ok = (description, schema) => ({
  description,
  content: { 'application/json': { schema } },
});

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
};

export function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AskPDF API',
      version: '0.7.0',
      description:
        'Upload PDFs, ask questions about them, and get answers grounded in the document ' +
        'with page citations. Answers below the configured similarity floor are refused ' +
        'rather than guessed.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'This server' }],

    tags: [
      { name: 'Health', description: 'Liveness, readiness and metrics' },
      { name: 'Auth', description: 'Registration, sign-in and token rotation' },
      { name: 'Documents', description: 'Upload and manage PDFs' },
      { name: 'Jobs', description: 'Ingestion progress' },
      { name: 'Chat', description: 'Grounded question answering' },
    ],

    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },

      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: Object.values(ErrorCode) },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
              },
            },
            requestId: { type: 'string', description: 'Echoed from X-Request-Id' },
          },
        },

        User: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
            role: { type: 'string', enum: ['user', 'admin'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },

        TokenPair: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: {
              type: 'string',
              description: 'Single use — revoked when exchanged',
            },
            tokenType: { type: 'string', enum: ['Bearer'] },
            expiresIn: { type: 'string', example: '15m' },
          },
        },

        AuthResult: {
          allOf: [
            { $ref: '#/components/schemas/TokenPair' },
            { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } },
          ],
        },

        Document: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            filename: { type: 'string' },
            storageKey: { type: 'string', example: 'pdf/20260817-094546-9f77a71b-report.pdf' },
            contentHash: { type: 'string', description: 'SHA-256 of the file bytes' },
            byteSize: { type: 'integer' },
            pageCount: { type: 'integer' },
            chunkCount: { type: 'integer' },
            status: { type: 'string', enum: Object.values(DocumentStatus) },
            stage: { type: ['string', 'null'], enum: [...PIPELINE_STAGES, null] },
            title: { type: 'string' },
            failure: {
              type: ['object', 'null'],
              properties: {
                stage: { type: 'string' },
                message: { type: 'string' },
                at: { type: 'string', format: 'date-time' },
              },
            },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },

        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            documentId: { type: 'string' },
            status: { type: 'string', enum: Object.values(JobStatus) },
            stage: { type: ['string', 'null'], enum: [...PIPELINE_STAGES, null] },
            progress: { type: 'integer', minimum: 0, maximum: 100 },
            attempts: { type: 'integer' },
            maxAttempts: { type: 'integer' },
            requestId: {
              type: 'string',
              description: 'Correlation id of the upload, shared with the worker logs',
            },
          },
        },

        UploadAccepted: {
          type: 'object',
          properties: {
            document: { $ref: '#/components/schemas/Document' },
            job: { $ref: '#/components/schemas/Job' },
            duplicate: {
              type: 'boolean',
              description: 'True when identical bytes were already uploaded by this user',
            },
            statusUrl: { type: 'string' },
          },
        },

        Citation: {
          type: 'object',
          properties: {
            chunkIndex: { type: 'integer' },
            pageStart: { type: 'integer' },
            pageEnd: { type: 'integer' },
            score: { type: 'number', minimum: 0, maximum: 1 },
            snippet: { type: 'string' },
          },
        },

        ChatAnswer: {
          type: 'object',
          properties: {
            conversationId: { type: 'string' },
            answer: { type: 'string' },
            bestScore: { type: 'number' },
            citations: { type: 'array', items: { $ref: '#/components/schemas/Citation' } },
          },
        },

        Conversation: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            documentId: { type: 'string' },
            title: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string' },
                  refused: { type: 'boolean' },
                  citations: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Citation' },
                  },
                },
              },
            },
          },
        },
      },
    },

    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Liveness',
          description:
            'Deliberately shallow — never consults dependencies, so a database blip cannot ' +
            'restart every pod at once.',
          responses: { 200: ok('Process is alive', { type: 'object' }) },
        },
      },

      '/readyz': {
        get: {
          tags: ['Health'],
          summary: 'Readiness',
          description: 'Fails while draining on SIGTERM, or when a critical dependency is down.',
          responses: {
            200: ok('Ready for traffic', { type: 'object' }),
            503: ok('Draining or degraded', { type: 'object' }),
          },
        },
      },

      [env.METRICS_PATH]: {
        get: {
          tags: ['Health'],
          summary: 'Prometheus metrics',
          responses: { 200: { description: 'Metrics in the exposition format' } },
        },
      },

      [API_PREFIX]: {
        get: {
          tags: ['Health'],
          summary: 'API root',
          description: 'Identifies the service and points at these docs.',
          responses: {
            200: ok('Service descriptor', {
              type: 'object',
              properties: {
                service: { type: 'string' },
                version: { type: 'string' },
                docs: { type: 'string' },
              },
            }),
          },
        },
      },

      [`${API_PREFIX}/auth/register`]: {
        post: {
          tags: ['Auth'],
          summary: 'Create an account',
          requestBody: jsonBody({
            type: 'object',
            required: ['email', 'password', 'name'],
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 10, maxLength: 72 },
              name: { type: 'string', maxLength: 120 },
            },
          }),
          responses: {
            201: ok('Account created', { $ref: '#/components/schemas/AuthResult' }),
            400: errorResponse('Validation failed', ErrorCode.VALIDATION_FAILED),
            409: errorResponse('Email already registered', ErrorCode.CONFLICT),
            429: errorResponse('Too many attempts', ErrorCode.RATE_LIMITED),
          },
        },
      },

      [`${API_PREFIX}/auth/login`]: {
        post: {
          tags: ['Auth'],
          summary: 'Sign in',
          description:
            'Unknown email and wrong password return the same error after comparable work, ' +
            'so response timing cannot be used to enumerate accounts.',
          requestBody: jsonBody({
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string' },
            },
          }),
          responses: {
            200: ok('Signed in', { $ref: '#/components/schemas/AuthResult' }),
            401: errorResponse('Invalid credentials', ErrorCode.UNAUTHORIZED),
          },
        },
      },

      [`${API_PREFIX}/auth/refresh`]: {
        post: {
          tags: ['Auth'],
          summary: 'Exchange a refresh token',
          description:
            'Refresh tokens are single use: the presented token is revoked as part of the ' +
            'exchange, so a stolen token stops working once the real user refreshes.',
          requestBody: jsonBody({
            type: 'object',
            required: ['refreshToken'],
            properties: { refreshToken: { type: 'string' } },
          }),
          responses: {
            200: ok('New token pair', { $ref: '#/components/schemas/AuthResult' }),
            401: errorResponse('Token invalid, expired or already used', ErrorCode.UNAUTHORIZED),
          },
        },
      },

      [`${API_PREFIX}/auth/logout`]: {
        post: {
          tags: ['Auth'],
          summary: 'Sign out',
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              refreshToken: { type: 'string' },
              everywhere: {
                type: 'boolean',
                default: false,
                description: 'Invalidate every session for this user',
              },
            },
          }),
          responses: {
            200: ok('Signed out', { type: 'object' }),
            401: errorResponse('Not authenticated', ErrorCode.UNAUTHORIZED),
          },
        },
      },

      [`${API_PREFIX}/auth/change-password`]: {
        post: {
          tags: ['Auth'],
          summary: 'Change password',
          description: 'Invalidates every existing session and returns a fresh token pair.',
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody({
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            properties: {
              currentPassword: { type: 'string' },
              newPassword: { type: 'string', minLength: 10, maxLength: 72 },
            },
          }),
          responses: {
            200: ok('Password changed', { $ref: '#/components/schemas/AuthResult' }),
            401: errorResponse('Current password incorrect', ErrorCode.UNAUTHORIZED),
          },
        },
      },

      [`${API_PREFIX}/auth/me`]: {
        get: {
          tags: ['Auth'],
          summary: 'Current profile',
          security: [{ bearerAuth: [] }],
          responses: {
            200: ok('Profile', {
              type: 'object',
              properties: { user: { $ref: '#/components/schemas/User' } },
            }),
            401: errorResponse('Not authenticated', ErrorCode.UNAUTHORIZED),
          },
        },
      },

      [`${API_PREFIX}/documents`]: {
        post: {
          tags: ['Documents'],
          summary: 'Upload a PDF',
          description:
            'Returns 202, not 201: the row exists but is not answerable until the worker ' +
            'finishes. Poll the job for progress. The file is validated on its magic bytes, ' +
            'not on the filename or declared content type.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: {
            202: ok('Accepted for processing', { $ref: '#/components/schemas/UploadAccepted' }),
            400: errorResponse('No file, or an empty one', ErrorCode.VALIDATION_FAILED),
            401: errorResponse('Not authenticated', ErrorCode.UNAUTHORIZED),
            413: errorResponse('Larger than MAX_UPLOAD_BYTES', ErrorCode.PAYLOAD_TOO_LARGE),
            415: errorResponse('Not a PDF', ErrorCode.UNSUPPORTED_MEDIA_TYPE),
            429: errorResponse('Upload limit reached', ErrorCode.RATE_LIMITED),
          },
        },
        get: {
          tags: ['Documents'],
          summary: 'List documents',
          description: 'Keyset paginated — pass the returned nextCursor to continue.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: Object.values(DocumentStatus) },
            },
          ],
          responses: {
            200: ok('A page of documents', {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Document' } },
                nextCursor: { type: ['string', 'null'] },
              },
            }),
            400: errorResponse('Invalid query', ErrorCode.VALIDATION_FAILED),
          },
        },
      },

      [`${API_PREFIX}/documents/{id}`]: {
        get: {
          tags: ['Documents'],
          summary: 'Fetch a document',
          description:
            "Returns 404 for another user's document rather than 403, so ids reveal nothing.",
          security: [{ bearerAuth: [] }],
          parameters: [idParam],
          responses: {
            200: ok('The document', {
              type: 'object',
              properties: { document: { $ref: '#/components/schemas/Document' } },
            }),
            404: errorResponse('Not found', ErrorCode.NOT_FOUND),
          },
        },
        delete: {
          tags: ['Documents'],
          summary: 'Delete a document',
          description: 'Removes the chunks and the stored object as well.',
          security: [{ bearerAuth: [] }],
          parameters: [idParam],
          responses: {
            200: ok('Deleted', { type: 'object' }),
            404: errorResponse('Not found', ErrorCode.NOT_FOUND),
          },
        },
      },

      [`${API_PREFIX}/documents/{id}/download`]: {
        get: {
          tags: ['Documents'],
          summary: 'Time-limited download URL',
          security: [{ bearerAuth: [] }],
          parameters: [idParam],
          responses: {
            200: ok('Signed URL', {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri' } },
            }),
            404: errorResponse('Not found', ErrorCode.NOT_FOUND),
          },
        },
      },

      [`${API_PREFIX}/jobs`]: {
        get: {
          tags: ['Jobs'],
          summary: 'List jobs',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          ],
          responses: {
            200: ok('Jobs', {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Job' } },
              },
            }),
          },
        },
      },

      [`${API_PREFIX}/jobs/{id}`]: {
        get: {
          tags: ['Jobs'],
          summary: 'Ingestion progress',
          security: [{ bearerAuth: [] }],
          parameters: [idParam],
          responses: {
            200: ok('The job', {
              type: 'object',
              properties: { job: { $ref: '#/components/schemas/Job' } },
            }),
            404: errorResponse('Not found', ErrorCode.NOT_FOUND),
          },
        },
      },

      [`${API_PREFIX}/chat`]: {
        post: {
          tags: ['Chat'],
          summary: 'Ask a question',
          description:
            'Retrieved passages must clear RETRIEVAL_MIN_SCORE before reaching the model. ' +
            'When nothing does, the service answers 422 NO_RELEVANT_CONTEXT rather than ' +
            'letting the model improvise.',
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody({
            type: 'object',
            required: ['documentId', 'question'],
            properties: {
              documentId: { type: 'string' },
              question: { type: 'string', maxLength: 2000 },
              conversationId: { type: 'string' },
            },
          }),
          responses: {
            200: ok('A grounded answer', { $ref: '#/components/schemas/ChatAnswer' }),
            404: errorResponse('Document not found', ErrorCode.NOT_FOUND),
            409: errorResponse('Still processing', ErrorCode.DOCUMENT_NOT_READY),
            422: errorResponse('Nothing relevant enough', ErrorCode.NO_RELEVANT_CONTEXT),
            429: errorResponse('Chat limit reached', ErrorCode.RATE_LIMITED),
          },
        },
      },

      [`${API_PREFIX}/chat/stream`]: {
        post: {
          tags: ['Chat'],
          summary: 'Ask a question, streamed',
          description:
            'Server-Sent Events. A `citations` event arrives first so sources can be rendered ' +
            'while the answer is still generating, then `delta` events carry the text, then ' +
            '`done`. A refusal arrives as a `refusal` event, and a mid-stream failure as ' +
            '`error` — the HTTP status is already 200 by then.',
          security: [{ bearerAuth: [] }],
          requestBody: jsonBody({
            type: 'object',
            required: ['documentId', 'question'],
            properties: {
              documentId: { type: 'string' },
              question: { type: 'string', maxLength: 2000 },
              conversationId: { type: 'string' },
            },
          }),
          responses: {
            200: {
              description: 'An SSE stream',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                  example:
                    'event: citations\ndata: {"citations":[...]}\n\n' +
                    'event: delta\ndata: {"text":"The Nordic region "}\n\n' +
                    'event: done\ndata: {"conversationId":"..."}\n\n',
                },
              },
            },
          },
        },
      },

      [`${API_PREFIX}/chat/conversations`]: {
        get: {
          tags: ['Chat'],
          summary: 'List conversations',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'documentId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: { 200: ok('Conversations', { type: 'object' }) },
        },
      },

      [`${API_PREFIX}/chat/conversations/{id}`]: {
        get: {
          tags: ['Chat'],
          summary: 'Full message history',
          security: [{ bearerAuth: [] }],
          parameters: [idParam],
          responses: {
            200: ok('The conversation', {
              type: 'object',
              properties: { conversation: { $ref: '#/components/schemas/Conversation' } },
            }),
            404: errorResponse('Not found', ErrorCode.NOT_FOUND),
          },
        },
      },
    },
  };
}
