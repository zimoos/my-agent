export interface User {
  id: number;
  name: string;
  age: number;
}

// Error 1: number assigned to string-typed variable.
export function formatUserLabel(user: User): string {
  const label: string = user.age;
  return `${user.name} (${label})`;
}

// Error 2: function declares a return type but has a branch that returns nothing.
export function findUser(users: User[], id: number): User {
  for (const user of users) {
    if (user.id === id) {
      return user;
    }
  }
}

// Error 3: parameter type mismatch — expects number, but used as string.
export function buildGreeting(name: string, age: number): string {
  return `Hello ${name}, you are ${age.toUpperCase()} years old`;
}
