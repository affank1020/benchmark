//! Experimental parity CLI. Does not run consumer tests or access GitHub APIs.
use std::{
    collections::{BTreeMap, HashSet},
    env,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

use benchmark_core::{compare_coverage, parse_jest, parse_junit, parse_lcov, Coverage, CoverageChange, Metric, TestSummary};
use serde_json::{json, Map, Value};

const MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024;
const USAGE: &str = "Usage: benchmark [--coverage PATH] [--baseline-coverage PATH] [--tests PATH] [--tests-format junit|jest] [--ci CONCLUSION] [--output PATH] [--json PATH]";

fn read_bounded(path: &str) -> std::io::Result<String> {
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("Not a regular file"));
    }
    if file.metadata()?.len() > MAX_INPUT_BYTES {
        return Err(std::io::Error::other("File too large"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(std::io::Error::other("File too large"));
    }
    // Node Buffer.toString("utf8") uses replacement for invalid UTF-8 bytes.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_args() -> Result<BTreeMap<String, String>, &'static str> {
    let mut result = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        if !flag.starts_with("--") {
            return Err(USAGE);
        }
        let value = args.next().ok_or(USAGE)?;
        if value.is_empty() {
            return Err(USAGE);
        }
        result.insert(flag[2..].to_owned(), value);
    }
    Ok(result)
}

fn optional<T>(
    args: &BTreeMap<String, String>,
    flag: &str,
    parser: impl FnOnce(&str) -> Result<T, benchmark_core::LcovError>,
    diagnostic: &str,
    errors: &mut Vec<String>,
) -> Option<T> {
    let path = args.get(flag)?;
    match read_bounded(path).ok().and_then(|s| parser(&s).ok()) {
        Some(result) => Some(result),
        None => {
            errors.push(diagnostic.to_owned());
            None
        }
    }
}

fn normalized_ci(value: &str) -> &str {
    match value {
        "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral"
        | "action_required" | "stale" => value,
        _ => "unknown",
    }
}

fn ci_label(ci: &str) -> &'static str {
    match ci {
        "success" => "✅ Passed",
        "failure" => "❌ Failed",
        "cancelled" => "⚪ Cancelled",
        "timed_out" => "❌ Timed out",
        "skipped" => "⚪ Skipped",
        "neutral" => "⚪ Neutral",
        "action_required" => "⚠️ Action required",
        "stale" => "⚪ Stale",
        _ => "⚪ Unknown",
    }
}

fn metric_value(m: &Metric) -> Value {
    json!({"hit": m.hit, "found": m.found, "percent": m.percent})
}

fn coverage_value(c: &Coverage) -> Value {
    json!({
        "lines": metric_value(&c.lines),
        "functions": metric_value(&c.functions),
        "branches": metric_value(&c.branches),
    })
}

fn change_value(c: &CoverageChange) -> Value {
    json!({"lines": c.lines, "functions": c.functions, "branches": c.branches})
}

fn tests_value(t: &TestSummary) -> Value {
    json!({"total": t.total, "passed": t.passed, "failed": t.failed, "skipped": t.skipped})
}

fn pct(m: Option<&Metric>) -> String {
    m.and_then(|m| m.percent)
        .map_or_else(|| "Not reported".to_owned(), |x| format!("{x:.2}%"))
}

fn delta(value: Option<f64>) -> String {
    value.map_or_else(
        || "Not reported".to_owned(),
        |x| format!("{x:+.2} pp"),
    )
}

fn markdown(
    ci: &str,
    coverage: Option<&Coverage>,
    baseline: Option<&Coverage>,
    tests: Option<&TestSummary>,
    diagnostics: &[String],
) -> String {
    let mut lines = vec![
        "<!-- benchmark-pr-quality-report -->".to_owned(),
        "## Benchmark · PR Quality Report".to_owned(),
        "".to_owned(),
        format!("**CI:** {} ({ci})", ci_label(ci)),
        "".to_owned(),
    ];
    let has_baseline = baseline.is_some();
    lines.push(if has_baseline {
        "| Metric | Result | Baseline | Change |"
    } else {
        "| Metric | Result |"
    }.to_owned());
    lines.push(if has_baseline {
        "| --- | --- | --- | --- |"
    } else {
        "| --- | --- |"
    }.to_owned());

    let test_summary = tests.map_or_else(
        || "Not reported".to_owned(),
        |t| format!("{} passed · {} failed · {} skipped / {} total", t.passed, t.failed, t.skipped, t.total),
    );
    lines.push(if has_baseline {
        format!("| Tests | {test_summary} | — | — |")
    } else {
        format!("| Tests | {test_summary} |")
    });

    let diff = compare_coverage(coverage, baseline);
    for (label, current, before, delta_metric) in [
        ("Line coverage", coverage.map(|c| &c.lines), baseline.map(|b| &b.lines), diff.as_ref().and_then(|d| d.lines)),
        ("Function coverage", coverage.map(|c| &c.functions), baseline.map(|b| &b.functions), diff.as_ref().and_then(|d| d.functions)),
        ("Branch coverage", coverage.map(|c| &c.branches), baseline.map(|b| &b.branches), diff.as_ref().and_then(|d| d.branches)),
    ] {
        lines.push(if has_baseline {
            format!("| {label} | {} | {} | {} |", pct(current), pct(before), delta(delta_metric))
        } else {
            format!("| {label} | {} |", pct(current))
        });
    }

    if has_baseline {
        lines.push("".into());
        lines.push("_Coverage change is in percentage points (pp); file scopes must be comparable._".into());
    }
    if !diagnostics.is_empty() {
        let mut seen = HashSet::new();
        let unique: Vec<_> = diagnostics.iter().filter(|x| seen.insert(x.as_str())).collect();
        lines.push("".into());
        lines.push("**Missing or invalid inputs**".into());
        for diag in unique {
            lines.push(format!("- {diag}"));
        }
    }
    lines.push("".into());
    lines.push("_Informational only. Unavailable metrics are not treated as 0% or passing._".into());
    lines.push("".into());
    lines.join("\n")
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args().map_err(|_| USAGE)?;
    let mut diagnostics = Vec::new();
    let coverage = optional(&args, "coverage", parse_lcov, "Coverage artifact missing or invalid", &mut diagnostics);
    let baseline = optional(&args, "baseline-coverage", parse_lcov, "Baseline coverage artifact missing or invalid", &mut diagnostics);
    let coverage_change = compare_coverage(coverage.as_ref(), baseline.as_ref());
    let tests = optional(
        &args,
        "tests",
        if args.get("tests-format").is_some_and(|s| s == "jest") { parse_jest } else { parse_junit },
        "Test artifact missing or invalid",
        &mut diagnostics,
    );
    let ci = normalized_ci(args.get("ci").map_or("unknown", String::as_str));
    let report = markdown(ci, coverage.as_ref(), baseline.as_ref(), tests.as_ref(), &diagnostics);
    if let Some(path) = args.get("output") {
        fs::write(Path::new(path), &report)?;
    } else {
        std::io::stdout().write_all(report.as_bytes())?;
    }

    if let Some(path) = args.get("json") {
        let mut map = Map::new();
        map.insert("ci".into(), json!(ci));
        if let Some(c) = &coverage {
            map.insert("coverage".into(), coverage_value(c));
        }
        if let Some(c) = &baseline {
            map.insert("baselineCoverage".into(), coverage_value(c));
        }
        if let Some(c) = &coverage_change {
            map.insert("coverageChange".into(), change_value(c));
        }
        if let Some(t) = &tests {
            map.insert("tests".into(), tests_value(t));
        }
        map.insert("diagnostics".into(), json!(diagnostics));
        let serialized = serde_json::to_string_pretty(&Value::Object(map))? + "\n";
        fs::write(Path::new(path), serialized)?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(if error.to_string() == USAGE { 2 } else { 1 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_single_comment_marker_and_unavailable_metrics() {
        let text = markdown("unknown", None, None, None, &[]);
        assert!(text.starts_with("<!-- benchmark-pr-quality-report -->"));
        assert!(text.contains("**CI:** ⚪ Unknown (unknown)"));
        assert!(text.contains("| Line coverage | Not reported |"));
        assert!(text.ends_with("\n"));
    }

    #[test]
    fn baseline_without_current_remains_unavailable() {
        let baseline = parse_lcov("LH:1\nLF:2\nend_of_record").unwrap();
        let text = markdown("failure", None, Some(&baseline), None, &["Coverage artifact missing or invalid".into()]);
        assert!(text.contains("| Line coverage | Not reported | 50.00% | Not reported |"));
        assert!(text.contains("❌ Failed"));
    }
}
