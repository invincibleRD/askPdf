import { env } from '../config/env.js';
import { redisKey } from '../infra/redis/connection.js';

export const queueKeys = {
  /** Ready to be picked up now. */
  ready: () => redisKey('queue', env.QUEUE_NAME),

  /** Sorted set of retries, scored by the time they become due. */
  delayed: () => redisKey('queue', env.QUEUE_NAME, 'delayed'),

  /** Jobs that exhausted their attempts. Drained by hand, never automatically. */
  dead: () => redisKey('queue', env.QUEUE_NAME, 'dead'),

  /** Hash mirroring job state, so polling never touches MongoDB. */
  status: (jobId) => redisKey('job', jobId),
};
