import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { useTestDatabase } from '../../helpers/db.js';
import { credentials, registerVia, signedInUser, withAuth } from '../../helpers/auth.js';
import { getRedis } from '../../../src/infra/redis/connection.js';
import { ErrorCode } from '../../../src/config/constants.js';
import { signAccessToken } from '../../../src/modules/auth/token.service.js';

useTestDatabase();

const app = createApp();

beforeEach(async () => {
  await getRedis().flushdb();
});

describe('POST /auth/register', () => {
  it('creates an account and returns a token pair', async () => {
    const { response, input } = await registerVia(app);

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: input.email, name: input.name });
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();
  });

  it('never returns the password hash', async () => {
    const { response } = await registerVia(app);

    expect(response.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('$2b$');
  });

  it('rejects a duplicate email with 409', async () => {
    const { input } = await registerVia(app);

    const second = await request(app).post('/api/v1/auth/register').send(input);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ErrorCode.CONFLICT);
  });

  it('rejects a weak password with field-level detail', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send(credentials({ password: 'short' }));

    expect(response.status).toBe(400);
    expect(response.body.error.details.fields.password).toBeDefined();
  });

  it('strips unknown keys so role cannot be smuggled in', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...credentials(), role: 'admin' });

    expect(response.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('signs in with the right password', async () => {
    const { input } = await registerVia(app);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: input.email, password: input.password });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
  });

  it('is case-insensitive on the email', async () => {
    const { input } = await registerVia(app);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: input.email.toUpperCase(), password: input.password });

    expect(response.status).toBe(200);
  });

  it('gives an identical response for a wrong password and an unknown account', async () => {
    const { input } = await registerVia(app);

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: input.email, password: 'not-the-password' });
    const unknownAccount = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: input.password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });
});

describe('GET /auth/me', () => {
  it('returns the profile for a valid token', async () => {
    const { user, tokens } = await signedInUser();

    const response = await withAuth(request(app).get('/api/v1/auth/me'), tokens.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc123'],
    ['garbage token', 'Bearer not-a-jwt'],
  ])('rejects %s with 401', async (_label, header) => {
    const req = request(app).get('/api/v1/auth/me');
    const response = await (header ? req.set('authorization', header) : req);

    expect(response.status).toBe(401);
  });

  it('rejects a token signed with the refresh secret', async () => {
    const { tokens } = await signedInUser();

    // Different secrets per token type is what makes this fail.
    const response = await withAuth(request(app).get('/api/v1/auth/me'), tokens.refreshToken);

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const { tokens } = await signedInUser();

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(response.status).toBe(200);
    expect(response.body.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('refuses to reuse a refresh token', async () => {
    const { tokens } = await signedInUser();

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(replay.status).toBe(401);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const { user } = await signedInUser();

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: signAccessToken(user) });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the presented refresh token', async () => {
    const { tokens } = await signedInUser();

    await withAuth(request(app).post('/api/v1/auth/logout'), tokens.accessToken).send({
      refreshToken: tokens.refreshToken,
    });

    const afterLogout = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    expect(afterLogout.status).toBe(401);
  });

  it('invalidates every session when signing out everywhere', async () => {
    const { tokens } = await signedInUser();
    const other = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });

    await withAuth(request(app).post('/api/v1/auth/logout'), tokens.accessToken).send({
      everywhere: true,
    });

    // The token version moved on, so a token minted before it is now stale.
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: other.body.refreshToken });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password and invalidates existing sessions', async () => {
    const { credentials: input, tokens } = await signedInUser();

    const response = await withAuth(
      request(app).post('/api/v1/auth/change-password'),
      tokens.accessToken,
    ).send({ currentPassword: input.password, newPassword: 'a-much-longer-secret' });

    expect(response.status).toBe(200);

    const oldRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken });
    expect(oldRefresh.status).toBe(401);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: input.email, password: 'a-much-longer-secret' });
    expect(login.status).toBe(200);
  });

  it('rejects a wrong current password', async () => {
    const { tokens } = await signedInUser();

    const response = await withAuth(
      request(app).post('/api/v1/auth/change-password'),
      tokens.accessToken,
    ).send({ currentPassword: 'wrong-password', newPassword: 'a-much-longer-secret' });

    expect(response.status).toBe(401);
  });
});
