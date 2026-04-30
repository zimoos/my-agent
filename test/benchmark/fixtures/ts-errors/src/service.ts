import { User, findUser, buildGreeting } from './utils';

// Error 4: calling findUser with wrong argument types (string instead of number).
export function describeUser(users: User[], rawId: string): string {
  const user = findUser(users, rawId);
  return buildGreeting(user.name, user.age);
}
