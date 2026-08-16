import { z } from 'zod';

// bcrypt truncates at 72 bytes, so cap there rather than silently cutting.
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Must be a valid email address')
  .max(254, 'Email address is too long');

// .strict() everywhere: unknown keys are rejected, so a caller can't smuggle
// `role: "admin"` into a registration payload.

export const registerSchema = z
  .object({
    email,
    password,
    name: z.string().trim().min(1, 'Name is required').max(120),
  })
  .strict();

export const loginSchema = z
  .object({
    email,
    // No policy check here — it would tell an attacker their guess failed the
    // rules rather than the comparison.
    password: z.string().min(1, 'Password is required').max(72),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  })
  .strict();

export const logoutSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    everywhere: z.boolean().default(false),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
  })
  .strict()
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'New password must differ from the current one',
  });
