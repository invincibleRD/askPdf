// Values that cross process boundaries: written to MongoDB, echoed in Redis
// hashes, returned in API responses.

export const DocumentStatus = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  DELETED: 'deleted',
});

export const JobStatus = Object.freeze({
  QUEUED: 'queued',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD: 'dead',
});

/** Execution order matters: progress is derived from the stage index. */
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

export const UserRole = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
});

export const MessageRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
});

/** Public contract — clients branch on these. Add freely, never repurpose. */
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

export const REQUEST_ID_HEADER = 'x-request-id';

/** `%PDF-` */
export const PDF_MAGIC_BYTES = Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]);

export const PDF_MIME_TYPE = 'application/pdf';
