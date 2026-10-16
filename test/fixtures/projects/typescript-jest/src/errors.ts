/** Every error tally throws on purpose. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(readonly left: string, readonly right: string) {
    super(`cannot combine ${left} with ${right}`);
  }
}

export class UnknownCurrencyError extends MoneyError {
  constructor(readonly code: string) {
    super(`unknown currency ${JSON.stringify(code)}`);
  }
}

export class InvalidAmountError extends MoneyError {
  constructor(readonly input: string, reason: string) {
    super(`invalid amount ${JSON.stringify(input)}: ${reason}`);
  }
}
