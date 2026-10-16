/** A query string, URL or path template that cannot be read. */
export class QueryError extends Error {
  readonly input: string;

  constructor(message: string, input: string) {
    super(`${message}: ${JSON.stringify(input)}`);
    this.name = 'QueryError';
    this.input = input;
  }
}
