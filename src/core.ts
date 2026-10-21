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

type JunitSuite = {
  tests: number;
  attributes: Record<string, string>;
  cases: number;
  failures: number;
  errors: number;
  skipped: number;
};
type JunitCase = { failure: boolean; error: boolean; skipped: boolean };

// A suite's outcome attributes are optional in JUnit XML. Derive them from
// testcase elements only when every declared test case is represented;
// otherwise fail closed rather than turn an unknown failure into a pass.
function suiteOutcomes(suite: JunitSuite): { failed: number; skipped: number } {
  const { attributes, tests, cases, failures, errors, skipped } = suite;
  if (cases > tests) throw new Error("JUnit testcase counts inconsistent");

  const keys = ["failures", "errors", "skipped"] as const;
  const completeSummary = keys.every(key => attributes[key] !== undefined);
  const completeCases = cases === tests;

  // When testcase detail is complete, verify every supplied suite counter
  // against it. If attributes are absent, the testcase detail is authoritative.
  if (completeCases) {
    const observed = { failures, errors, skipped };
    for (const key of keys) {
      if (attributes[key] !== undefined && nonnegative(attributes[key]) !== observed[key]) {
        throw new Error("JUnit suite attributes disagree with testcase outcomes");
      }
    }
    return { failed: failures + errors, skipped };
  }

  if (!completeSummary) {
    throw new Error("Incomplete JUnit outcome data: missing counters and testcases");
  }

  const declaredFailures = nonnegative(attributes.failures);
  const declaredErrors = nonnegative(attributes.errors);
  const declaredSkipped = nonnegative(attributes.skipped);
  if (failures > declaredFailures || errors > declaredErrors || skipped > declaredSkipped) {
    throw new Error("JUnit suite attributes disagree with testcase outcomes");
  }
  if (declaredFailures + declaredErrors + declaredSkipped > tests) {
    throw new Error("JUnit counts inconsistent");
  }
  return { failed: declaredFailures + declaredErrors, skipped: declaredSkipped };
}

export function parseJunit(text: string): TestSummary {
  const stack: string[] = [];
  let rootSeen = false;
  let suiteCount = 0;
  let total = 0, failed = 0, skipped = 0;
  let activeSuite: JunitSuite | null = null;
  let activeCase: JunitCase | null = null;
  // Node.js 22's built-in JUnit reporter emits direct testcase children of
  // <testsuites>, with no <testsuite> element or aggregate test counters.
  // Keep these distinct from wrapped suites so their totals are counted once.
  const rootCases: JunitSuite = {
    tests: 0, attributes: Object.create(null),
    cases: 0, failures: 0, errors: 0, skipped: 0
  };
  let rootAttributes: Record<string, string> | null = null;

  const finishCase = () => {
    if (!activeCase) throw new Error("Unexpected JUnit testcase closing tag");
    if (activeCase.skipped && (activeCase.failure || activeCase.error)) {
      throw new Error("Conflicting JUnit testcase outcomes");
    }
    const target = activeSuite ?? rootCases;
    target.cases++;
    if (activeCase.error) target.errors++;
    else if (activeCase.failure) target.failures++;
    else if (activeCase.skipped) target.skipped++;
    activeCase = null;
  };

  const finishSuite = () => {
    if (!activeSuite) throw new Error("Unexpected JUnit suite closing tag");
    const outcomes = suiteOutcomes(activeSuite);
    total = nonnegative(total + activeSuite.tests);
    failed = nonnegative(failed + outcomes.failed);
    skipped = nonnegative(skipped + outcomes.skipped);
    if (failed + skipped > total) throw new Error("JUnit counts inconsistent");
    activeSuite = null;
  };

  for (const tag of xmlTags(text)) {
    if (tag.startsWith("/")) {
      const closing = /^\/\s*([A-Za-z_][\w.:-]*)\s*$/.exec(tag);
      if (!closing || stack.at(-1) !== closing[1]) throw new Error("Malformed JUnit XML nesting");
      if (closing[1] === "testcase") finishCase();
      if (closing[1] === "testsuite" && stack.filter(name => name === "testsuite").length === 1) {
        finishSuite();
      }
      stack.pop();
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
      if (name === "testsuites") rootAttributes = attributes;
    }

    // Parents summarise nested suites, so only outermost suite totals are
    // counted; testcase detail from any nested suite contributes to its parent.
    const outermostSuite = name === "testsuite" && !stack.includes("testsuite");
    if (outermostSuite) {
      if (attributes.tests === undefined) throw new Error("JUnit suite missing tests");
      suiteCount++;
      activeSuite = {
        tests: nonnegative(attributes.tests), attributes,
        cases: 0, failures: 0, errors: 0, skipped: 0
      };
    }
    if (name === "testcase") {
      const directRootCase = !activeSuite &&
        stack.length === 1 && stack[0] === "testsuites";
      if (activeCase || (!activeSuite && !directRootCase)) {
        throw new Error("Invalid JUnit testcase nesting");
      }
      activeCase = { failure: false, error: false, skipped: false };
    } else if (activeCase && (name === "failure" || name === "error" || name === "skipped")) {
      activeCase[name === "failure" ? "failure" : name] = true;
    } else if (!activeCase && (name === "failure" || name === "error" || name === "skipped") && activeSuite) {
      throw new Error("JUnit outcome outside testcase");
    }

    if (selfClosing) {
      if (name === "testcase") finishCase();
      if (outermostSuite) finishSuite();
    } else {
      stack.push(name);
    }
  }

  if (!rootSeen || stack.length || activeSuite || activeCase) {
    throw new Error("Malformed JUnit XML document");
  }
  if (suiteCount === 0 && rootCases.cases === 0) {
    throw new Error("No JUnit testsuite or testcase");
  }

  total = nonnegative(total + rootCases.cases);
  failed = nonnegative(failed + rootCases.failures + rootCases.errors);
  skipped = nonnegative(skipped + rootCases.skipped);
  if (failed + skipped > total) throw new Error("JUnit counts inconsistent");

  // Some JUnit producers also include root-level aggregate counters. When
  // present they must not contradict the individual suites/testcases.
  if (rootAttributes) {
    if (rootAttributes.tests !== undefined && nonnegative(rootAttributes.tests) !== total) {
      throw new Error("JUnit root test counts disagree");
    }
    if (rootAttributes.skipped !== undefined && nonnegative(rootAttributes.skipped) !== skipped) {
      throw new Error("JUnit root skipped counts disagree");
    }
    if (rootAttributes.failures !== undefined && rootAttributes.errors !== undefined &&
        nonnegative(rootAttributes.failures) + nonnegative(rootAttributes.errors) !== failed) {
      throw new Error("JUnit root failure counts disagree");
    }
  }
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
