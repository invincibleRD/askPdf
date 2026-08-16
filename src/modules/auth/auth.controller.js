import * as authService from './auth.service.js';

// Express 5 forwards rejected promises to the error handler, so no try/catch.

export async function register(req, res) {
  const { user, tokens } = await authService.register(req.body);
  res.status(201).json({ user, ...tokens });
}

export async function login(req, res) {
  const { user, tokens } = await authService.login(req.body);
  res.status(200).json({ user, ...tokens });
}

export async function refresh(req, res) {
  const { user, tokens } = await authService.refresh(req.body.refreshToken);
  res.status(200).json({ user, ...tokens });
}

export async function logout(req, res) {
  const result = await authService.logout({
    userId: req.user.id,
    refreshToken: req.body.refreshToken,
    everywhere: req.body.everywhere,
  });

  res.status(200).json({ signedOut: true, ...result });
}

export async function changePassword(req, res) {
  const { user, tokens } = await authService.changePassword({
    userId: req.user.id,
    ...req.body,
  });

  res.status(200).json({ user, ...tokens });
}

export function me(req, res) {
  res.status(200).json({ user: req.user });
}
