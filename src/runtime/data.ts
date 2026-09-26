/** Accept JSON data without invoking accessors, toJSON methods or inherited values. */
export function cloneRuntimeJson<T>(value: T): T {
  const visiting = new Set<object>();
  const clone = (input: unknown): unknown => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null || visiting.has(input)) throw new Error('MA_INVALID_JSON');
    visiting.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype
          || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('MA_INVALID_JSON');
        const result: unknown[] = [];
        for (let i = 0; i < input.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
            throw new Error('MA_INVALID_JSON');
          }
          result.push(clone(descriptor.value));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== null && prototype !== Object.prototype) throw new Error('MA_INVALID_JSON');
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
          || !descriptor.enumerable) throw new Error('MA_INVALID_JSON');
        Object.defineProperty(result, key, {
          value: clone(descriptor.value), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    } finally { visiting.delete(input); }
  };
  return clone(value) as T;
}

export function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function requireOwnData(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MA_INVALID_DATA');
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('MA_INVALID_DATA');
  }
  return value as Record<string, unknown>;
}
