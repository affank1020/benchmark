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
        // JavaScript Number(array) first converts the array to its joined
        // string. A single boolean becomes "true"/"false" (NaN), not 1/0;
        // null and an empty array stringify to "" (zero).
        Value::Array(items) if items.len() == 1 => match &items[0] {
            Value::Null => Ok(0),
            Value::Bool(_) | Value::Object(_) => Err(invalid("Invalid non-negative integer")),
            other => numeric(other),
        },
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
    // Present null must stay present: Number(null) is 0. In particular
    // numPassedTests=null must NOT trigger the absent-field pass inference.
    object.get(key).map(numeric).transpose()
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
    fn explicitly_null_passed_count_is_zero_not_missing() {
        assert!(parse_jest(r#"{"numTotalTests":2,"numPassedTests":null}"#).is_err());
        assert_eq!(
            parse_jest(r#"{"numTotalTests":2,"numPassedTests":null,"numFailedTests":2}"#).unwrap(),
            TestSummary {
                total: 2,
                passed: 0,
                failed: 2,
                skipped: 0
            }
        );
        assert_eq!(
            parse_jest(r#"{"numTotalTests":0,"numPassedTests":null}"#)
                .unwrap()
                .passed,
            0
        );
    }

    #[test]
    fn array_counts_use_node_string_coercion_not_recursive_boolean_coercion() {
        for invalid_case in [
            r#"{"numTotalTests":[true],"numPassedTests":1}"#,
            r#"{"numTotalTests":[false],"numPassedTests":0}"#,
            r#"{"numTotalTests":[1,2]}"#,
            r#"{"numTotalTests":[{}]}"#,
            r#"{"numTotalTests":[[true]]}"#,
        ] {
            assert!(parse_jest(invalid_case).is_err(), "accepted {invalid_case}");
        }
        for valid_case in [
            r#"{"numTotalTests":[null]}"#,
            r#"{"numTotalTests":[]}"#,
            r#"{"numTotalTests":[[]]}"#,
            r#"{"numTotalTests":[""]}"#,
        ] {
            assert_eq!(parse_jest(valid_case).unwrap().total, 0, "{valid_case}");
        }
        for valid_case in [
            r#"{"numTotalTests":[1],"numPassedTests":1}"#,
            r#"{"numTotalTests":["1"],"numPassedTests":[1]}"#,
            r#"{"numTotalTests":[["1"]],"numPassedTests":1}"#,
        ] {
            assert_eq!(parse_jest(valid_case).unwrap().passed, 1, "{valid_case}");
        }
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
