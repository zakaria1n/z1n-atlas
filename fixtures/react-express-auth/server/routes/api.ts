import { Router } from 'express';
import { authRoutes } from './auth';

export const apiRouter = Router();
apiRouter.use('/auth', authRoutes);
apiRouter.get('/status', (request, response) => {
  response.json({ status: 'ok' });
});
