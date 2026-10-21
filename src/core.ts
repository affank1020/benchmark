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

// Recognise XML tags without treating a '>' inside quoted attributes as an
// element boundary. JUnit files are bounded by the CLI before parsing.
function* xmlTags(text: string): Generator<string> {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) break;
    if (text.startsWith("<!--", start) || text.startsWith("<![CDATA[", start)) {
      const comment = text.startsWith("<!--", start);
      const terminator = comment ? "-->" : "]]>";
      const end = text.indexOf(terminator, start + (comment ? 4 : 9));
      if (end < 0) throw new Error("Unterminated XML comment or CDATA");
      cursor = end + terminator.length;
      continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      if (end < 0) throw new Error("Unterminated XML processing instruction");
      cursor = end + 2;
      continue;
    }
    // External entities/DTDs are unnecessary for JUnit metrics and must never
    // be expanded or interpreted by this parser.
    if (text.startsWith("<!", start)) throw new Error("Unsupported XML declaration");
    let quote: string | null = null;
    let end = start + 1;
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    if (end === text.length) throw new Error("Unterminated XML tag");
    yield text.slice(start + 1, end).trim();
    cursor = end + 1;
  }
}

function xmlAttributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let remaining = text;
  while (remaining.trim()) {
    const match = /^\s+([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining);
    if (!match) throw new Error("Invalid JUnit XML attribute");
    if (Object.hasOwn(result, match[1])) throw new Error("Duplicate JUnit XML attribute");
    result[match[1]] = match[2] ?? match[3];
    remaining = remaining.slice(match[0].length);
  }
  return result;
}

export function parseJunit(text: string): TestSummary {
  const stack: string[] = [];
  let rootSeen = false;
  let suiteCount = 0;
  let total = 0, failed = 0, skipped = 0;

  for (const tag of xmlTags(text)) {
    if (tag.startsWith("/")) {
      const closing = /^\/\s*([A-Za-z_][\w.:-]*)\s*$/.exec(tag);
      if (!closing || stack.pop() !== closing[1]) throw new Error("Malformed JUnit XML nesting");
      continue;
    }
    const opening = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(tag);
    if (!opening) throw new Error("Malformed JUnit XML tag");
    const name = opening[1];
    const selfClosing = /\/\s*$/.test(opening[2]);
    const attributeText = selfClosing
      ? opening[2].replace(/\/\s*$/, "")
      : opening[2];
    const attributes = xmlAttributes(attributeText);

    if (!stack.length) {
      if (rootSeen || (name !== "testsuite" && name !== "testsuites")) {
        throw new Error("Invalid JUnit XML root");
      }
      rootSeen = true;
    }
    // Suite totals normally include their nested descendants. Count a suite
    // only if there is no ancestor suite; sibling suites are independent.
    if (name === "testsuite" && !stack.includes("testsuite")) {
      suiteCount++;
      if (attributes.tests === undefined) throw new Error("JUnit suite missing tests");
      const count = nonnegative(attributes.tests);
      const f = nonnegative(attributes.failures ?? "0") + nonnegative(attributes.errors ?? "0");
      const s = nonnegative(attributes.skipped ?? "0");
      if (f + s > count) throw new Error("JUnit counts inconsistent");
      total = nonnegative(total + count);
      failed = nonnegative(failed + f);
      skipped = nonnegative(skipped + s);
    }
    if (!selfClosing) stack.push(name);
  }
  if (!rootSeen || stack.length) throw new Error("Malformed JUnit XML document");
  if (suiteCount === 0) throw new Error("No JUnit testsuite");
  return { total, failed, skipped, passed: total - failed - skipped };
}

export function parseJest(text: string): TestSummary {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object") throw new Error("Invalid Jest report");
  const obj = data as Record<string, unknown>;
  const total = nonnegative(obj.numTotalTests);
  const failed = nonnegative(obj.numFailedTests ?? 0);
  // Jest counts TODOs in numTotalTests, but they are not passing tests.
  const skipped = nonnegative(obj.numPendingTests ?? 0) + nonnegative(obj.numTodoTests ?? 0);
  if (failed + skipped > total) throw new Error("Jest counts inconsistent");
  const passed = obj.numPassedTests === undefined
    ? total - failed - skipped
    : nonnegative(obj.numPassedTests);
  if (passed + failed + skipped !== total) throw new Error("Jest counts inconsistent");
  return { total, failed, skipped, passed };
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
