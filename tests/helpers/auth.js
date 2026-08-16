import request from 'supertest';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createUser } from '../../src/modules/users/user.repository.js';
import { issueTokenPair } from '../../src/modules/auth/token.service.js';

let counter = 0;

export function credentials(overrides = {}) {
  counter += 1;
  return {
    email: `person${String(counter)}@example.com`,
    password: 'correct-horse-battery',
    name: `Person ${String(counter)}`,
    ...overrides,
  };
}

/** Creates a user directly and returns a usable token pair. */
export async function signedInUser(overrides = {}) {
  const input = credentials(overrides);
  const user = await createUser({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
  });

  return { user, credentials: input, tokens: issueTokenPair({ ...user, tokenVersion: 0 }) };
}

export function withAuth(req, accessToken) {
  return req.set('authorization', `Bearer ${accessToken}`);
}

export async function registerVia(app, overrides = {}) {
  const input = credentials(overrides);
  const response = await request(app).post('/api/v1/auth/register').send(input);
  return { response, input };
}
