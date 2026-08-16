import busboy from 'busboy';
import { MAX_UPLOAD_FIELD_BYTES, PDF_MAGIC_BYTES, PDF_MIME_TYPE } from '../../config/constants.js';
import { env } from '../../config/env.js';
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../core/errors.js';

const MAGIC = Buffer.from(PDF_MAGIC_BYTES);

/**
 * Parses a single-file multipart upload into `req.file`.
 *
 * Busboy rather than multer: this streams, so the size limit is enforced as
 * bytes arrive instead of after a 2 GB body has already been buffered into
 * memory. The file still lands in a Buffer at the end — a 20 MB cap makes
 * that safe, and the parser needs the whole document anyway.
 *
 * @param {{ field?: string, maxBytes?: number }} [options]
 */
export function uploadSingle({ field = 'file', maxBytes = env.MAX_UPLOAD_BYTES } = {}) {
  return function uploadMiddleware(req, _res, next) {
    if (!req.is('multipart/form-data')) {
      next(new UnsupportedMediaTypeError('Expected a multipart/form-data upload'));
      return;
    }

    let parser;
    try {
      parser = busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: maxBytes,
          fields: 8,
          fieldSize: MAX_UPLOAD_FIELD_BYTES,
        },
      });
    } catch (error) {
      next(new ValidationError(`Malformed multipart request: ${error.message}`));
      return;
    }

    const fields = {};
    /** @type {Buffer[]} */
    const chunks = [];
    let received = 0;
    let fileInfo = null;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      req.unpipe(parser);
      parser.removeAllListeners();
      // Drain rather than destroy: cutting the socket mid-body makes the
      // client see a connection reset instead of the 413 we are sending.
      req.resume();
      next(error);
    };

    parser.on('field', (name, value) => {
      fields[name] = value;
    });

    parser.on('file', (name, stream, info) => {
      if (name !== field) {
        stream.resume();
        return;
      }

      fileInfo = info;

      if (info.mimeType && info.mimeType !== PDF_MIME_TYPE) {
        stream.resume();
        fail(new UnsupportedMediaTypeError(`Expected ${PDF_MIME_TYPE}, got ${info.mimeType}`));
        return;
      }

      stream.on('data', (chunk) => {
        received += chunk.length;
        chunks.push(chunk);
      });

      // Busboy sets this once the declared limit is passed, having stopped
      // reading — so the oversized body is never fully buffered.
      stream.on('limit', () => {
        fail(new PayloadTooLargeError(maxBytes));
      });

      stream.on('error', (error) => {
        fail(new ValidationError(`Upload stream failed: ${error.message}`));
      });
    });

    parser.on('error', (error) => {
      fail(new ValidationError(`Malformed multipart request: ${error.message}`));
    });

    parser.on('close', () => {
      if (settled) {
        return;
      }

      if (!fileInfo) {
        fail(new ValidationError(`Expected a file in the "${field}" field`));
        return;
      }

      const buffer = Buffer.concat(chunks, received);

      if (buffer.length === 0) {
        fail(new ValidationError('Uploaded file is empty'));
        return;
      }

      // The declared content type is caller-controlled; the first five bytes
      // are what the file actually is.
      if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
        fail(new UnsupportedMediaTypeError('File is not a PDF'));
        return;
      }

      settled = true;
      req.file = {
        buffer,
        originalName: fileInfo.filename ?? 'document.pdf',
        mimeType: PDF_MIME_TYPE,
        size: buffer.length,
      };
      req.body = { ...fields, ...req.body };
      next();
    });

    req.pipe(parser);
  };
}
