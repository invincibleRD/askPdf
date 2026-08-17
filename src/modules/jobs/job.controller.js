import { NotFoundError } from '../../core/errors.js';
import { findJobForOwner, listJobsForOwner } from './job.repository.js';

export async function getById(req, res) {
  const job = await findJobForOwner(req.params.id, req.user.id);

  if (!job) {
    throw new NotFoundError('Job');
  }

  res.status(200).json({ job });
}

export async function list(req, res) {
  const jobs = await listJobsForOwner(req.user.id, req.query);

  res.status(200).json({ items: jobs });
}
