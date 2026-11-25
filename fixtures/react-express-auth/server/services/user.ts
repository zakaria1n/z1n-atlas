import { users } from '../repositories/user';

export class UserService {
  static async create(input: { email: string; password: string }) {
    return users.create(input);
  }
}
