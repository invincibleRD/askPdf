import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../helpers/db.js';
import { buildUser, createTestUser } from '../../helpers/factories.js';
import {
  createUser,
  emailExists,
  findUserByEmail,
  findUserById,
  incrementTokenVersion,
  touchLastLogin,
} from '../../../src/modules/users/user.repository.js';
import { UserRole } from '../../../src/config/constants.js';
import { ConflictError } from '../../../src/core/errors.js';

useTestDatabase();

describe('createUser', () => {
  it('creates an account with the default role', async () => {
    const user = await createTestUser();

    expect(user.role).toBe(UserRole.USER);
    expect(user.tokenVersion).toBe(0);
    expect(user.id).toBeTruthy();
  });

  it('never returns the password hash', async () => {
    const user = await createTestUser();

    expect(user.passwordHash).toBeUndefined();
  });

  it('rejects a duplicate email with a conflict rather than a driver error', async () => {
    const input = buildUser({ email: 'sam@example.com' });
    await createUser(input);

    await expect(createUser(buildUser({ email: 'sam@example.com' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('treats email as case-insensitive', async () => {
    await createUser(buildUser({ email: 'Sam@Example.COM' }));

    // Folded on write, so the unique index enforces this rather than every
    // call site remembering to lowercase.
    await expect(createUser(buildUser({ email: 'sam@example.com' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('trims surrounding whitespace from the email', async () => {
    const user = await createUser(buildUser({ email: '  ada@example.com  ' }));

    expect(user.email).toBe('ada@example.com');
  });
});

describe('findUserByEmail', () => {
  it('omits the password hash by default', async () => {
    await createUser(buildUser({ email: 'grace@example.com' }));

    const user = await findUserByEmail('grace@example.com');

    expect(user.email).toBe('grace@example.com');
    expect(user.passwordHash).toBeUndefined();
  });

  it('returns the hash only when authentication asks for it', async () => {
    const input = buildUser({ email: 'grace@example.com' });
    await createUser(input);

    const user = await findUserByEmail('grace@example.com', { withPassword: true });

    expect(user.passwordHash).toBe(input.passwordHash);
  });

  it('matches regardless of the casing the caller used', async () => {
    await createUser(buildUser({ email: 'linus@example.com' }));

    await expect(findUserByEmail('LINUS@EXAMPLE.COM')).resolves.not.toBeNull();
  });

  it('returns null for an unknown address', async () => {
    await expect(findUserByEmail('nobody@example.com')).resolves.toBeNull();
  });
});

describe('findUserById', () => {
  it('finds an existing account', async () => {
    const created = await createTestUser();

    await expect(findUserById(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it('returns null for a malformed id rather than throwing', async () => {
    await expect(findUserById('not-an-id')).resolves.toBeNull();
  });
});

describe('touchLastLogin', () => {
  it('records the sign-in time', async () => {
    const user = await createTestUser();

    await touchLastLogin(user.id);

    const updated = await findUserById(user.id);
    expect(updated.lastLoginAt).toBeInstanceOf(Date);
  });

  it('ignores a malformed id so a bad write cannot fail a valid login', async () => {
    await expect(touchLastLogin('garbage')).resolves.toBeUndefined();
  });
});

describe('incrementTokenVersion', () => {
  it('bumps the version, invalidating every outstanding refresh token', async () => {
    const user = await createTestUser();

    await expect(incrementTokenVersion(user.id)).resolves.toBe(1);
    await expect(incrementTokenVersion(user.id)).resolves.toBe(2);
  });

  it('returns null for an unknown account', async () => {
    await expect(incrementTokenVersion('nope')).resolves.toBeNull();
  });
});

describe('emailExists', () => {
  it('reports whether an address is taken', async () => {
    await createUser(buildUser({ email: 'taken@example.com' }));

    await expect(emailExists('taken@example.com')).resolves.toBe(true);
    await expect(emailExists('TAKEN@example.com')).resolves.toBe(true);
    await expect(emailExists('free@example.com')).resolves.toBe(false);
  });
});
