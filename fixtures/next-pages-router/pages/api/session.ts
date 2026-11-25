import type { NextApiRequest, NextApiResponse } from 'next';
import { loadSession } from '../../lib/session';

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
) {
  const session = await loadSession(String(request.query.token));
  response.status(200).json({ session });
}
