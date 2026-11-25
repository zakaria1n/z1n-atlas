import type { NextApiRequest, NextApiResponse } from 'next';

export default async (request: NextApiRequest, response: NextApiResponse) => {
  const users = [{ id: '1', name: 'Ada' }];
  response.status(200).json({ users, method: request.method });
};
