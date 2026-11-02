/** A shallow copy of a value without the named keys: the same own properties, in the same order, that a rest destructuring leaves. */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const rest: Partial<T> = { ...value };
  for (const key of keys) delete rest[key];
  return rest as Omit<T, K>;
}
