import { User } from './utils';
import { describeUser } from './service';

const users: User[] = [
  { id: 1, name: 'Alice', age: 30 },
  { id: 2, name: 'Bob', age: 25 },
];

export function main(): void {
  const greeting = describeUser(users, '1');
  console.log(greeting);
}

if (require.main === module) {
  main();
}
