import { PathTemplate } from '../src';

type Handler = (params: Record<string, string>) => string;

const routes: Array<[PathTemplate, Handler]> = [
  [new PathTemplate('/users/{id}'), ({ id }) => `user ${id}`],
  [new PathTemplate('/files/{*path}'), ({ path }) => `file ${path}`],
];

export function route(path: string): string {
  for (const [template, handler] of routes) {
    const params = template.match(path);
    if (params) return handler(params);
  }
  return 'not found';
}

console.log(route('/users/42'));
console.log(route('/files/docs/readme.md'));
