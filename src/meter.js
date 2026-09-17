/** Token usage and cost per model, for the summary at the end of every scan. */

/**
 * Published prices, dollars per million tokens, by family. Output is free on System One, which is the only model perch talks to.
 * A price is published for a family and a request comes back naming a version of it, so `jev-1.13.0` is priced as `jev`.
 */
export const PRICES = {
  jev: { input: 0.042, output: 0 },
};

/** A family nobody published a price for costs an unknown amount, which the summary says rather than guessing. */
const priceOf = model => PRICES[model] ?? PRICES[String(model).split('-')[0]] ?? null;

export function createMeter() {
  const models = new Map();
  const meter = {
    /** Kept per model, since a run that spanned a version change has spent at two prices and only the record can say so. */
    add(model, usage, { requests = 1 } = {}) {
      if (!usage) return;
      const entry = models.get(model) ?? { requests: 0, input: 0, output: 0 };
      entry.requests += requests;
      entry.input += usage.input_tokens ?? 0;
      entry.output += usage.output_tokens ?? 0;
      models.set(model, entry);
    },
    /** Dollars for one model's entry, or null when the model's price is unknown. */
    cost(model) {
      const entry = models.get(model), price = priceOf(model);
      if (!entry || !price) return null;
      return (entry.input * price.input + entry.output * price.output) / 1e6;
    },
    total() { return [...models.keys()].reduce((sum, model) => sum + (meter.cost(model) ?? 0), 0); },
    /** Snapshot for records. */
    toJSON() { return Object.fromEntries([...models].map(([model, entry]) => [model, { ...entry, cost: meter.cost(model) }])); },
/**
     * What the run spent, as one line. Which model answered is a detail of the day the run happened, so the per-model breakdown
     * stays in `toJSON`, which is what the records keep and `--json` prints.
     */
    lines() {
      const entries = [...models.values()];
      if (!entries.length) return [];
      const sum = key => entries.reduce((total, entry) => total + entry[key], 0);
      const k = value => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
      const count = (value, noun) => `${value} ${value === 1 ? noun : `${noun}s`}`;
      const unpriced = [...models.keys()].some(model => meter.cost(model) === null);
      return [[count(sum('requests'), 'request'),
        `${k(sum('input'))} tokens in${sum('output') ? ` / ${k(sum('output'))} out` : ''}`,
        `${money(meter.total())}${unpriced ? ' (some prices unknown)' : ''}`].join('  ')];
    },
    models,
  };
  return meter;
}

/** "$0.0031", "$0.42", "$3.10"; "price unknown" when the model is not in the table. */
export const money = dollars => (dollars === null ? 'price unknown' : dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`);

/** A System One client whose every call is metered. */
export const metered = (systemOne, meter) => ({ ...systemOne, async ask(state, questions) { const response = await systemOne.ask(state, questions); meter.add(response.model ?? systemOne.id, response.usage); return response; } });
