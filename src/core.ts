export type Coverage = {
  lines: { hit: number; found: number; percent: number | null };
  functions: { hit: number; found: number; percent: number | null };
  branches: { hit: number; found: number; percent: number | null };
};
export type TestSummary = { total: number; passed: number; failed: number; skipped: number };
export type Input = {
  ci: string;
  coverage?: Coverage;
  tests?: TestSummary;
  diagnostics?: string[];
};

function rate(hit: number, found: number) {
  return { hit, found, percent: found === 0 ? null : Math.round(hit * 10000 / found) / 100 };
}
function nonnegative(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid non-negative integer");
  return n;
}

export function parseLcov(text: string): Coverage {
  let lh = 0, lf = 0, fnh = 0, fnf = 0, brh = 0, brf = 0;
  let records = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(LH|LF|FNH|FNF|BRH|BRF):(\d+)$/.exec(line.trim());
    if (match) {
      const n = nonnegative(match[2]);
      switch (match[1]) {
        case "LH": lh += n; break;
        case "LF": lf += n; break;
        case "FNH": fnh += n; break;
        case "FNF": fnf += n; break;
        case "BRH": brh += n; break;
        case "BRF": brf += n; break;
      }
    }
    if (line.trim() === "end_of_record") records++;
  }
  if (records === 0) throw new Error("No LCOV records");
  if (lh > lf || fnh > fnf || brh > brf) throw new Error("Invalid LCOV totals");
  return { lines: rate(lh, lf), functions: rate(fnh, fnf), branches: rate(brh, brf) };
}

export function parseJunit(text: string): TestSummary {
  const suites = [...text.matchAll(/<testsuite\b([^>]*)>/g)];
  if (suites.length === 0) throw new Error("No JUnit testsuite");
  let total = 0, failed = 0, skipped = 0;
  for (const [, attributes] of suites) {
    const values: Record<string, string> = {};
    for (const match of attributes.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(["'])(.*?)\2/g)) values[match[1]] = match[3];
    if (values.tests === undefined) throw new Error("JUnit suite missing tests");
    const count = nonnegative(values.tests);
    const f = nonnegative(values.failures ?? "0") + nonnegative(values.errors ?? "0");
    const s = nonnegative(values.skipped ?? "0");
    if (f + s > count) throw new Error("JUnit counts inconsistent");
    total += count; failed += f; skipped += s;
  }
  return { total, failed, skipped, passed: total - failed - skipped };
}

export function parseJest(text: string): TestSummary {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object") throw new Error("Invalid Jest report");
  const obj = data as Record<string, unknown>;
  const total = nonnegative(obj.numTotalTests);
  const failed = nonnegative(obj.numFailedTests ?? 0);
  const skipped = nonnegative(obj.numPendingTests ?? 0);
  if (failed + skipped > total) throw new Error("Jest counts inconsistent");
  return { total, failed, skipped, passed: total - failed - skipped };
}

export function normalizeCi(value: string): string {
  const known = new Set(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale"]);
  return known.has(value) ? value : "unknown";
}

export function renderMarkdown(input: Input): string {
  const ci = normalizeCi(input.ci);
  const ciLabel: Record<string, string> = {
    success: "✅ Passed", failure: "❌ Failed", cancelled: "⚪ Cancelled",
    timed_out: "❌ Timed out", skipped: "⚪ Skipped", neutral: "⚪ Neutral",
    action_required: "⚠️ Action required", stale: "⚪ Stale", unknown: "⚪ Unknown"
  };
  const pct = (v: { percent: number | null } | undefined) =>
    v?.percent == null ? "Not reported" : `${v.percent.toFixed(2)}%`;
  const tests = input.tests
    ? `${input.tests.passed} passed · ${input.tests.failed} failed · ${input.tests.skipped} skipped / ${input.tests.total} total`
    : "Not reported";
  const diagnostics = [...new Set(input.diagnostics ?? [])].map(x => `- ${x}`);
  return [
    "<!-- benchmark-pr-quality-report -->",
    "## Benchmark · PR Quality Report",
    "",
    `**CI:** ${ciLabel[ci]} (${ci})`,
    "",
    "| Metric | Result |",
    "| --- | --- |",
    `| Tests | ${tests} |`,
    `| Line coverage | ${pct(input.coverage?.lines)} |`,
    `| Function coverage | ${pct(input.coverage?.functions)} |`,
    `| Branch coverage | ${pct(input.coverage?.branches)} |`,
    ...(diagnostics.length ? ["", "**Missing or invalid inputs**", ...diagnostics] : []),
    "",
    "_Informational only. Unavailable metrics are not treated as 0% or passing._",
    ""
  ].join("\n");
}
