#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { readBoundedText } from "./read-input.mjs";
import { parseJest, parseJunit, parseLcov, renderMarkdown, normalizeCi, compareCoverage } from "./core.ts";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1]) {
    console.error("Usage: cli.mjs [--coverage PATH] [--baseline-coverage PATH] [--tests PATH] [--tests-format junit|jest] [--ci CONCLUSION] [--output PATH] [--json PATH]");
    process.exit(2);
  }
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const diagnostics = [];
const report = { ci: normalizeCi(args.get("ci") ?? "unknown") };
async function optionalReport(flag, parser, failureMessage) {
  const path = args.get(flag);
  if (!path) return undefined;
  try {
    const content = await readBoundedText(path);
    return parser(content);
  } catch {
    diagnostics.push(failureMessage);
    return undefined;
  }
}
report.coverage = await optionalReport("coverage", parseLcov, "Coverage artifact missing or invalid");
report.baselineCoverage = await optionalReport("baseline-coverage", parseLcov, "Baseline coverage artifact missing or invalid");
report.coverageChange = compareCoverage(report.coverage, report.baselineCoverage);
report.tests = await optionalReport("tests", args.get("tests-format") === "jest" ? parseJest : parseJunit, "Test artifact missing or invalid");
report.diagnostics = diagnostics;
const markdown = renderMarkdown(report);
if (args.has("output")) await writeFile(args.get("output"), markdown, "utf8");
else process.stdout.write(markdown);
if (args.has("json")) await writeFile(args.get("json"), JSON.stringify(report, null, 2) + "\n", "utf8");
