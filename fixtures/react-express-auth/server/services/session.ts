import { db } from '../db';

export async function loadSession(token: string | undefined) {
  if (!token) return null;
  return db.session.findUnique({ where: { token } });
}
