import * as documentService from './document.service.js';

/**
 * POST /api/v1/documents
 *
 * 202, not 201: the document row exists but is not usable until the worker
 * finishes. The job id is how a client follows that.
 */
export async function upload(req, res) {
  const { document, job, duplicate } = await documentService.ingestUpload({
    ownerId: req.user.id,
    file: req.file,
  });

  res.status(202).json({
    document,
    job: job ? { id: job.id, status: job.status, progress: job.progress } : null,
    duplicate,
    statusUrl: `/api/v1/documents/${document.id}`,
  });
}

export async function list(req, res) {
  const { items, nextCursor } = await documentService.listDocuments(req.user.id, req.query);

  res.status(200).json({ items, nextCursor });
}

export async function getById(req, res) {
  const document = await documentService.getDocument(req.params.id, req.user.id);

  res.status(200).json({ document });
}

export async function remove(req, res) {
  const result = await documentService.deleteDocument(req.params.id, req.user.id);

  res.status(200).json({ deleted: true, ...result });
}

export async function downloadUrl(req, res) {
  const url = await documentService.getDownloadUrl(req.params.id, req.user.id);

  res.status(200).json({ url });
}
