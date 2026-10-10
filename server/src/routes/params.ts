import type { Request } from 'express';

/**
 * A named route parameter as a string. Express 5 types every parameter as
 * `string | string[]` because a named wildcard (`*name`) yields segments; a
 * plain `:name` is always a string, so anything else is a routing mistake.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new Error(`Route parameter "${name}" is not a single path segment`);
  }
  return value;
}
