/**
 * Shared vocabulary.
 *
 * These values cross process boundaries — they are written to MongoDB, echoed
 * in Redis hashes and returned in API responses — so they are frozen and
 * defined in one place rather than repeated as string literals.
 */

/** Lifecycle of an uploaded document. */
export const DocumentStatus = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  DELETED: 'deleted',
});

/** Lifecycle of an ingestion job. */
export const JobStatus = Object.freeze({
  QUEUED: 'queued',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD: 'dead',
});

/**
 * The five stages of the ingestion pipeline, in execution order.
 *
 * Progress is reported as the index of the current stage, so the order of
 * this array is part of the API contract.
 */
export const PipelineStage = Object.freeze({
  PARSE: 'parse',
  CHUNK: 'chunk',
  EMBED: 'embed',
  INDEX: 'index',
  FINALIZE: 'finalize',
});

export const PIPELINE_STAGES = Object.freeze([
  PipelineStage.PARSE,
  PipelineStage.CHUNK,
  PipelineStage.EMBED,
  PipelineStage.INDEX,
  PipelineStage.FINALIZE,
]);

/** Roles carried in the JWT payload. */
export const UserRole = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
});

/** Author of a message in a conversation. */
export const MessageRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
});

/**
 * Machine-readable error codes returned in the `error.code` field.
 *
 * Clients branch on these, so treat them as a public contract: add freely,
 * never repurpose an existing code.
 */
export const ErrorCode = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  DOCUMENT_NOT_READY: 'DOCUMENT_NOT_READY',
  NO_RELEVANT_CONTEXT: 'NO_RELEVANT_CONTEXT',
  UPSTREAM_FAILURE: 'UPSTREAM_FAILURE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
});

/** Header carrying the correlation id through HTTP and into worker jobs. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Magic bytes every PDF file begins with (`%PDF-`). */
export const PDF_MAGIC_BYTES = Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]);

export const PDF_MIME_TYPE = 'application/pdf';
