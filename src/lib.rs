//! Experimental, dependency-free Rust port of Benchmark's LCOV coverage logic.
//! The deployed reporter still uses src/core.ts until CLI parity and integration
//! are independently reviewed. Do not silently substitute this for production.

pub mod junit;
pub use junit::{parse_junit, TestSummary};

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub struct Metric {
    pub hit: u64,
    pub found: u64,
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Coverage {
    pub lines: Metric,
    pub functions: Metric,
    pub branches: Metric,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CoverageChange {
    pub lines: Option<f64>,
    pub functions: Option<f64>,
    pub branches: Option<f64>,
}

#[derive(Debug, PartialEq)]
pub struct LcovError(String);

impl std::fmt::Display for LcovError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LcovError {}

fn invalid(message: &str) -> LcovError {
    LcovError(message.to_owned())
}

fn parse_count(text: &str) -> Result<u64, LcovError> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("Invalid non-negative integer"));
    }
    let value = text
        .parse::<u64>()
        .map_err(|_| invalid("Invalid non-negative integer"))?;
    if value > JS_MAX_SAFE_INTEGER {
        return Err(invalid("Invalid non-negative integer"));
    }
    Ok(value)
}

fn checked_sum(left: u64, right: u64) -> Result<u64, LcovError> {
    let total = left
        .checked_add(right)
        .ok_or_else(|| invalid("Invalid non-negative integer"))?;
    if total > JS_MAX_SAFE_INTEGER {
        return Err(invalid("Invalid non-negative integer"));
    }
    Ok(total)
}

// JavaScript Math.round rounds ties towards positive infinity. Adding 0.5
// before floor loses precision just below a half at very large counters.
fn js_round(value: f64) -> f64 {
    let lower = value.floor();
    if value - lower >= 0.5 {
        lower + 1.0
    } else {
        lower
    }
}

fn metric(hit: u64, found: u64) -> Metric {
    Metric {
        hit,
        found,
        percent: (found != 0).then(|| js_round(hit as f64 * 10000.0 / found as f64) / 100.0),
    }
}

const FIELDS: [&str; 6] = ["LH", "LF", "FNH", "FNF", "BRH", "BRF"];

fn field_index(line: &str) -> Option<(usize, &str)> {
    let (name, value) = line.split_once(':')?;
    // Mirror the legacy [A-Z][A-Z0-9_]* summary field syntax.
    if !name.starts_with(|c: char| c.is_ascii_uppercase())
        || !name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return None;
    }
    FIELDS
        .iter()
        .position(|field| *field == name)
        .map(|i| (i, value))
}

fn malformed_summary(line: &str) -> bool {
    FIELDS.iter().any(|field| {
        line.strip_prefix(field).is_some_and(|rest| {
            !rest
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    })
}

/// Parse LCOV summary counters, accepting standard detail fields but never
/// silently treating partial, duplicate or malformed summary fields as zeros.
pub fn parse_lcov(input: &str) -> Result<Coverage, LcovError> {
    let mut totals = [0_u64; 6];
    let mut record: [Option<u64>; 6] = [None; 6];
    let mut has_record_data = false;
    let mut records = 0_u64;

    for raw_line in input.split('\n') {
        let line = raw_line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if line.is_empty() {
            continue;
        }
        if line == "end_of_record" {
            if !has_record_data || record.iter().all(Option::is_none) {
                return Err(invalid("LCOV record missing coverage summary"));
            }
            for (hit, found) in [(0, 1), (2, 3), (4, 5)] {
                match (record[hit], record[found]) {
                    (Some(hit_value), Some(found_value)) => {
                        if hit_value > found_value {
                            return Err(invalid("Invalid LCOV totals"));
                        }
                        totals[hit] = checked_sum(totals[hit], hit_value)?;
                        totals[found] = checked_sum(totals[found], found_value)?;
                    }
                    (None, None) => {}
                    _ => return Err(invalid("Incomplete LCOV summary")),
                }
            }
            records += 1;
            record = [None; 6];
            has_record_data = false;
            continue;
        }

        has_record_data = true;
        if let Some((index, value)) = field_index(line) {
            if record[index].is_some() {
                return Err(invalid("Invalid or duplicate LCOV summary"));
            }
            record[index] = Some(parse_count(value)?);
        } else if malformed_summary(line) {
            return Err(invalid("Malformed LCOV summary"));
        }
        // SF, DA, FN, FNDA, BRDA, TN, etc. are not aggregate counters.
    }

    if has_record_data {
        return Err(invalid("Unterminated LCOV record"));
    }
    if records == 0 {
        return Err(invalid("No LCOV records"));
    }

    Ok(Coverage {
        lines: metric(totals[0], totals[1]),
        functions: metric(totals[2], totals[3]),
        branches: metric(totals[4], totals[5]),
    })
}

fn delta(current: Option<&Metric>, baseline: &Metric) -> Option<f64> {
    let current = current?;
    if current.found == 0 || baseline.found == 0 {
        return None;
    }
    let value = js_round(
        (current.hit as f64 / current.found as f64 - baseline.hit as f64 / baseline.found as f64)
            * 10000.0,
    ) / 100.0;
    // Avoid displaying a negative zero in JSON/Markdown consumers.
    Some(if value == 0.0 { 0.0 } else { value })
}

/// Return percentage-point differences against an explicitly supplied baseline.
/// A missing current metric or zero denominator stays unavailable.
pub fn compare_coverage(
    current: Option<&Coverage>,
    baseline: Option<&Coverage>,
) -> Option<CoverageChange> {
    let baseline = baseline?;
    Some(CoverageChange {
        lines: delta(current.map(|c| &c.lines), &baseline.lines),
        functions: delta(current.map(|c| &c.functions), &baseline.functions),
        branches: delta(current.map(|c| &c.branches), &baseline.branches),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coverage(text: &str) -> Coverage {
        parse_lcov(text).expect("valid fixture")
    }

    #[test]
    fn aggregates_complete_records_and_preserves_missing_denominators() {
        let parsed = coverage(
            "TN:\nSF:a.ts\nDA:1,1\nLH:3\nLF:5\nFNH:1\nFNF:2\nend_of_record\n\
             SF:b.ts\nLH:2\nLF:3\nend_of_record\n",
        );
        assert_eq!(parsed.lines, metric(5, 8));
        assert_eq!(parsed.lines.percent, Some(62.5));
        assert_eq!(parsed.functions, metric(1, 2));
        assert_eq!(parsed.branches.percent, None);
    }

    #[test]
    fn accepts_zero_denominators_but_never_calls_them_zero_percent() {
        let parsed = coverage("SF:a\nLH:0\nLF:0\nBRH:0\nBRF:0\nend_of_record\n");
        assert_eq!(parsed.lines.percent, None);
        assert_eq!(parsed.branches.percent, None);
        assert_eq!(parsed.functions.percent, None);
    }

    #[test]
    fn rejects_absent_records_and_empty_summaries() {
        assert!(parse_lcov("").is_err());
        assert!(parse_lcov("SF:a\nend_of_record").is_err());
        assert!(parse_lcov("end_of_record").is_err());
    }

    #[test]
    fn rejects_partial_duplicate_or_inverted_summaries() {
        for input in [
            "LH:1\nend_of_record",
            "LF:2\nend_of_record",
            "LH:1\nLF:1\nLF:1\nend_of_record",
            "LH:2\nLF:1\nend_of_record",
            "BRH:1\nend_of_record",
            "FNF:1\nend_of_record",
        ] {
            assert!(parse_lcov(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn rejects_malformed_syntax_instead_of_ignoring_a_summary() {
        for input in [
            "LH 1\nLF:2\nend_of_record",
            "LH:+1\nLF:2\nend_of_record",
            "LH:-1\nLF:2\nend_of_record",
            "LH:1.0\nLF:2\nend_of_record",
            "LH:\nLF:2\nend_of_record",
            "LH:1x\nLF:2\nend_of_record",
            "LH;1\nLF:2\nend_of_record",
        ] {
            assert!(parse_lcov(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn does_not_confuse_other_fields_with_coverage_summaries() {
        let parsed = coverage("SF:x\nLHX:10\nFNH_OTHER:3\nDA:1,1\nLH:1\nLF:2\nend_of_record");
        assert_eq!(parsed.lines, metric(1, 2));
    }

    #[test]
    fn requires_record_terminator() {
        assert!(parse_lcov("LH:1\nLF:1").is_err());
    }

    #[test]
    fn rejects_values_and_sums_over_js_safe_integer() {
        assert!(parse_lcov("LH:9007199254740992\nLF:9007199254740992\nend_of_record").is_err());
        let input = format!(
            "LH:{0}\nLF:{0}\nend_of_record\nLH:1\nLF:1\nend_of_record",
            JS_MAX_SAFE_INTEGER
        );
        assert!(parse_lcov(&input).is_err());
    }

    #[test]
    fn computes_deltas_from_unrounded_ratios() {
        let current = coverage("LH:2\nLF:3\nend_of_record");
        let base = coverage("LH:1\nLF:3\nend_of_record");
        let diff = compare_coverage(Some(&current), Some(&base)).unwrap();
        assert_eq!(diff.lines, Some(33.33));
        assert_eq!(diff.functions, None);
        assert_eq!(compare_coverage(Some(&current), None), None);
        assert_eq!(compare_coverage(None, Some(&base)).unwrap().lines, None);
    }

    #[test]
    fn negative_half_rounding_follows_javascript() {
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(1.5), 2.0);
    }

    #[test]
    fn accepts_bom_prefixed_summary_lines() {
        let parsed = coverage("﻿LH:1\nLF:1\nend_of_record");
        assert_eq!(parsed.lines.percent, Some(100.0));
    }

    #[test]
    fn matches_js_rounding_near_half_at_safe_integer_boundary() {
        let parsed = coverage("LH:450359962737\nLF:9007199254740001\nend_of_record");
        assert_eq!(parsed.lines.percent, Some(0.0));
    }

    #[test]
    fn accepts_crlf_and_zero_padded_counters() {
        let parsed = coverage("SF:a\r\nLH:0002\r\nLF:0004\r\nend_of_record\r\n");
        assert_eq!(parsed.lines, metric(2, 4));
    }
}
