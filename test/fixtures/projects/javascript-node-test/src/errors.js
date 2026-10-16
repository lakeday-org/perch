/** A configuration that could not be read: a file that is missing or malformed, or a variable that is not set. */
export class ConfigError extends Error {
  constructor(message, { file, key, line, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConfigError';
    this.file = file;
    this.key = key;
    this.line = line;
  }
}

/** A configuration the schema does not allow, with every problem found rather than the first. */
export class ValidationError extends ConfigError {
  constructor(problems) {
    super(formatProblems(problems));
    this.name = 'ValidationError';
    this.problems = problems;
  }

  /** The problems with one key. */
  about(key) {
    return this.problems.filter(problem => problem.key === key);
  }
}

export function formatProblems(problems) {
  const lines = problems.map(problem => `  ${problem.key}: ${problem.message}`);
  return `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} in the configuration:\n${lines.join('\n')}`;
}
