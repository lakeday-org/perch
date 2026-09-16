/** Token usage and cost per model, for the summary at the end of every scan and fix. */

/** Published prices, dollars per million tokens. Output is free on System One; cached input is a tenth on OpenAI. */
export const PRICES = {
  'jev-latest': { input: 0.042, cached: 0.042, output: 0 },
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5.6-terra': { input: 2.00, cached: 0.20, output: 12.00 },
  'gpt-5.6-sol': { input: 4.00, cached: 0.40, output: 20.00 },
};

const priceOf = model => PRICES[model] ?? PRICES[Object.keys(PRICES).find(name => model.startsWith(name.split('-')[0]))] ?? null;

export function createMeter() {
  const models = new Map();
  const meter = {
    /** Record one call's usage under a model. `usage` may carry input_tokens, output_tokens, and OpenAI's *_details. */
    add(model, usage, { turns = 0, requests = 1 } = {}) {
      if (!usage) return;
      const entry = models.get(model) ?? { requests: 0, turns: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
      entry.requests += requests; entry.turns += turns;
      entry.input += usage.input_tokens ?? 0;
      entry.cached += usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
      entry.output += usage.output_tokens ?? 0;
      entry.reasoning += usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0;
      models.set(model, entry);
    },
    /** Dollars for one model's entry, or null when the model's price is unknown. */
    cost(model) {
      const entry = models.get(model), price = priceOf(model);
      if (!entry || !price) return null;
      return ((entry.input - entry.cached) * price.input + entry.cached * price.cached + entry.output * price.output) / 1e6;
    },
    total() { return [...models.keys()].reduce((sum, model) => sum + (meter.cost(model) ?? 0), 0); },
    /** Snapshot for records. */
    toJSON() { return Object.fromEntries([...models].map(([model, entry]) => [model, { ...entry, cost: meter.cost(model) }])); },
    /** Aligned lines: one per model, then the total. */
    lines() {
      const k = value => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
      const rows = [...models].map(([model, entry]) => [model, `${entry.turns ? `${entry.turns} ${entry.turns === 1 ? 'turn' : 'turns'}` : `${entry.requests} ${entry.requests === 1 ? 'request' : 'requests'}`}`,
        `${k(entry.input)} in${entry.cached ? ` (${k(entry.cached)} cached)` : ''}${entry.output ? ` / ${k(entry.output)} out` : ''}${entry.reasoning ? `, ${k(entry.reasoning)} reasoning` : ''}`, money(meter.cost(model))]);
      if (rows.length > 1) rows.push(['total', '', '', money(meter.total())]);
      const widths = [0, 1, 2].map(column => Math.max(...rows.map(row => row[column].length)));
      return rows.map(row => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}`);
    },
    models,
  };
  return meter;
}

/** "$0.0031", "$0.42", "$3.10"; "price unknown" when the model is not in the table. */
export const money = dollars => (dollars === null ? 'price unknown' : dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`);

/** A System One client whose every call is metered. */
export const metered = (systemOne, meter) => ({ ...systemOne, async ask(state, questions) { const response = await systemOne.ask(state, questions); meter.add(response.model ?? systemOne.id, response.usage); return response; } });
