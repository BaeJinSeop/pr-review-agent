// Pure (no Tauri imports) so it can be checked with plain node.

/** USD per 1M input / output tokens by model id prefix. First match wins, so longer prefixes come first.
 *  shortcut: list prices as of 2026-10 without cache/batch discounts (this app uses neither);
 *  add a row when a new model is picked, or its cost shows as unknown. */
const PRICES: [prefix: string, input: number, output: number][] = [
  ["claude-fable-5", 10, 50],
  ["claude-mythos-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4-6", 3, 15],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-4-5", 1, 5],
];

/** Estimated USD for one call, or null when the model's price is unknown. */
export function estimateUsd(model: string, input: number, output: number): number | null {
  const p = PRICES.find(([prefix]) => model.startsWith(prefix));
  if (!p) return null;
  // Haiku 5.5 charges 5x for prompts over 100K tokens.
  const k = p[0] === "claude-haiku-5-5" && input > 100_000 ? 5 : 1;
  return ((input * p[1] + output * p[2]) * k) / 1e6;
}
