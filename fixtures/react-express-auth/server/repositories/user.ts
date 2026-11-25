import { db } from '../db';

export const users = {
  create: (data: { email: string; password: string }) => {
    return db.user.create({ data });
  },
};
