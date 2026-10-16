const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * Splits `total` minor units by `ratios` with nothing lost: each share is rounded toward zero, and what is left over goes one
 * unit at a time to the shares with the largest remainders, the earlier share first on a tie.
 */
export function allocateMinor(total: bigint, ratios: number[]): bigint[] {
  if (!ratios.length) throw new RangeError('allocate needs at least one ratio');
  if (ratios.some(ratio => ratio < 0 || !Number.isFinite(ratio))) throw new RangeError('ratios must be finite and not negative');
  const weights = ratios.map(ratio => BigInt(Math.round(ratio * 1_000_000)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) throw new RangeError('ratios must not all be zero');
  const shares = weights.map(weight => (total * weight) / weightSum);
  const order = weights
    .map((weight, index) => ({ index, rest: abs((total * weight) % weightSum) }))
    .sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  let left = total - shares.reduce((sum, share) => sum + share, 0n);
  const unit = left < 0n ? -1n : 1n;
  for (let at = 0; left !== 0n; at++) {
    shares[order[at % order.length].index] += unit;
    left -= unit;
  }
  return shares;
}
