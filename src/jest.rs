//! Jest JSON counters. No executable code is evaluated; the caller reads only
//! bounded artifact bytes and parses one JSON object.

use serde_json::Value;

use crate::{checked_sum, invalid, parse_js_count, LcovError, TestSummary};

fn numeric(value: &Value) -> Result<u64, LcovError> {
    match value {
        Value::Null => Ok(0),
        Value::Bool(v) => Ok(u64::from(*v)),
        Value::Number(n) => parse_js_count(&n.to_string()),
        Value::String(s) => parse_js_count(s),
        Value::Array(items) if items.is_empty() => Ok(0),
        Value::Array(items) if items.len() == 1 => {
            if items[0].is_null() {
                Ok(0)
            } else {
                numeric(&items[0])
            }
        }
        _ => Err(invalid("Invalid non-negative integer")),
    }
}

fn required(object: &serde_json::Map<String, Value>, key: &str) -> Result<u64, LcovError> {
    object
        .get(key)
        .ok_or_else(|| invalid("Invalid non-negative integer"))
        .and_then(numeric)
}

fn optional(object: &serde_json::Map<String, Value>, key: &str) -> Result<Option<u64>, LcovError> {
    object
        .get(key)
        .filter(|v| !v.is_null())
        .map(numeric)
        .transpose()
}

pub fn parse_jest(input: &str) -> Result<TestSummary, LcovError> {
    let value: Value = serde_json::from_str(input).map_err(|_| invalid("Invalid Jest report"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| invalid("Invalid Jest report"))?;
    let total = required(obj, "numTotalTests")?;
    let failed = optional(obj, "numFailedTests")?.unwrap_or(0);
    let skipped = checked_sum(
        optional(obj, "numPendingTests")?.unwrap_or(0),
        optional(obj, "numTodoTests")?.unwrap_or(0),
    )?;
    let accounted = checked_sum(failed, skipped)?;
    if accounted > total {
        return Err(invalid("Jest counts inconsistent"));
    }
    let passed = optional(obj, "numPassedTests")?.unwrap_or(total - accounted);
    if checked_sum(passed, accounted)? != total {
        return Err(invalid("Jest counts inconsistent"));
    }
    Ok(TestSummary {
        total,
        passed,
        failed,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_standard_jest_counts_and_todos() {
        assert_eq!(
            parse_jest(r#"{"numTotalTests":8,"numFailedTests":1,"numPendingTests":2}"#).unwrap(),
            TestSummary {
                total: 8,
                passed: 5,
                failed: 1,
                skipped: 2
            }
        );
        assert_eq!(
            parse_jest(r#"{"numTotalTests":2,"numPassedTests":1,"numTodoTests":1}"#).unwrap(),
            TestSummary {
                total: 2,
                passed: 1,
                failed: 0,
                skipped: 1
            }
        );
    }

    #[test]
    fn preserves_node_number_conversion_for_json_counters() {
        assert_eq!(
            parse_jest(r#"{"numTotalTests":"+2","numPassedTests":"1","numTodoTests":"1"}"#)
                .unwrap(),
            TestSummary {
                total: 2,
                passed: 1,
                failed: 0,
                skipped: 1
            }
        );
        assert_eq!(
            parse_jest(r#"{"numTotalTests":true,"numPassedTests":true}"#)
                .unwrap()
                .total,
            1
        );
    }

    #[test]
    fn rejects_inconsistent_or_invalid_summaries() {
        for sample in [
            "null",
            "[]",
            "42",
            "{}",
            r#"{"numTotalTests":2,"numPassedTests":2,"numTodoTests":1}"#,
            r#"{"numTotalTests":-1}"#,
            r#"{"numTotalTests":1.2}"#,
            r#"{"numTotalTests":3,"numPendingTests":4}"#,
            r#"{"numTotalTests":9007199254740992}"#,
            r#"{"numTotalTests":3,"numFailedTests":"nope"}"#,
        ] {
            assert!(parse_jest(sample).is_err(), "accepted {sample}");
        }
    }
}
