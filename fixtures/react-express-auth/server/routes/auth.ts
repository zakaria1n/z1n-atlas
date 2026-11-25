import { Router } from 'express';
import { authController } from '../controllers/auth';
import { loadSession } from '../services/session';

export const SESSION_PATH = '/session';

export const authRoutes = Router();
authRoutes.post('/register', authController.register);
authRoutes.get(SESSION_PATH, async (request, response) => {
  const user = await loadSession(request.cookies?.session);
  response.json({ user });
});
