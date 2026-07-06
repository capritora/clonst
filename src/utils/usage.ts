/**
 * Token usage formatting, shared by the review tool (final report instruction)
 * and the report file generator. Kept out of review.ts to avoid a circular
 * import with core/report.ts.
 */

/** Human-readable token count: 950 -> "950", 1234 -> "1.2k", 260000 -> "260k", 3530000 -> "3.5M". */
export function formatTokenCount(n: number): string {
  const compact = (value: number, unit: string): string =>
    `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 1_000) return compact(n / 1_000, "k");
  return String(n);
}

/**
 * Ready-to-quote summary of a review's token cost, computed server-side
 * so the calling model never does arithmetic: a literal formula in the
 * instruction could produce negative or misleading numbers on partial usage
 * reports. Fresh input = input minus cache re-serves, clamped at 0. Values come
 * from the CLI's JSONL usage events, already filtered to numbers by the provider.
 * reasoning_output_tokens is NOT added to output_tokens (the OpenAI convention
 * is that output_tokens already includes it).
 */
export function usageSummary(totalUsage: Record<string, number> | null): string {
  if (totalUsage === null) return "token usage not reported by the reviewer CLI";
  const input = totalUsage.input_tokens ?? 0;
  const cached = totalUsage.cached_input_tokens ?? 0;
  const output = totalUsage.output_tokens ?? 0;
  if (cached > 0) {
    const freshInput = Math.max(0, input - cached);
    return (
      `~${formatTokenCount(freshInput)} fresh input + ${formatTokenCount(output)} output tokens ` +
      `(cumulative input ${formatTokenCount(input)}, of which ${formatTokenCount(cached)} were cache re-serves)`
    );
  }
  return `${formatTokenCount(input)} input + ${formatTokenCount(output)} output tokens`;
}

/** Human-readable duration: 42 -> "42 s", 330 -> "5 min 30 s". */
export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
