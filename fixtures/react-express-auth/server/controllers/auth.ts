import { UserService } from '../services/user';

export const authController = {
  register: async (input: { email: string; password: string }) => {
    const user = await UserService.create(input);
    return user;
  },
};
