//! Bounded-input JUnit XML summary parsing, matching Benchmark's existing
//! Node reporter rules: only outermost suite totals count, but nested testcase
//! outcomes contribute to that suite.

use std::collections::BTreeMap;

use crate::{checked_sum, invalid, parse_js_count, LcovError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TestSummary {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
}

#[derive(Default)]
struct Suite {
    tests: u64,
    attrs: BTreeMap<String, String>,
    cases: u64,
    failures: u64,
    errors: u64,
    skipped: u64,
}

#[derive(Default)]
struct TestCase {
    failure: bool,
    error: bool,
    skipped: bool,
}

fn count(value: &str) -> Result<u64, LcovError> {
    parse_js_count(value)
}

fn attribute_count(attrs: &BTreeMap<String, String>, name: &str) -> Result<Option<u64>, LcovError> {
    attrs.get(name).map(|v| count(v)).transpose()
}

fn check_summary(suite: &Suite) -> Result<(u64, u64), LcovError> {
    if suite.cases > suite.tests {
        return Err(invalid("JUnit testcase counts inconsistent"));
    }
    let complete_cases = suite.cases == suite.tests;
    let keys = [
        ("failures", suite.failures),
        ("errors", suite.errors),
        ("skipped", suite.skipped),
    ];
    if complete_cases {
        for (name, actual) in keys {
            if let Some(declared) = attribute_count(&suite.attrs, name)? {
                if declared != actual {
                    return Err(invalid(
                        "JUnit suite attributes disagree with testcase outcomes",
                    ));
                }
            }
        }
        return Ok((checked_sum(suite.failures, suite.errors)?, suite.skipped));
    }

    let declared = [
        attribute_count(&suite.attrs, "failures")?,
        attribute_count(&suite.attrs, "errors")?,
        attribute_count(&suite.attrs, "skipped")?,
    ];
    let [Some(failures), Some(errors), Some(skipped)] = declared else {
        return Err(invalid("Incomplete JUnit outcome data"));
    };
    if suite.failures > failures || suite.errors > errors || suite.skipped > skipped {
        return Err(invalid(
            "JUnit suite attributes disagree with testcase outcomes",
        ));
    }
    if checked_sum(checked_sum(failures, errors)?, skipped)? > suite.tests {
        return Err(invalid("JUnit counts inconsistent"));
    }
    Ok((checked_sum(failures, errors)?, skipped))
}

fn finish_case(case: TestCase, suite: &mut Suite) -> Result<(), LcovError> {
    if case.skipped && (case.failure || case.error) {
        return Err(invalid("Conflicting JUnit testcase outcomes"));
    }
    suite.cases = checked_sum(suite.cases, 1)?;
    if case.error {
        suite.errors = checked_sum(suite.errors, 1)?;
    } else if case.failure {
        suite.failures = checked_sum(suite.failures, 1)?;
    } else if case.skipped {
        suite.skipped = checked_sum(suite.skipped, 1)?;
    }
    Ok(())
}

/// Scan tags, respecting quoted '>' and ignoring comments and CDATA.
/// As with the existing TS parser, DTD/external entities are not supported.
fn tags(input: &str) -> Result<Vec<&str>, LcovError> {
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = input[cursor..].find('<') {
        let start = cursor + relative;
        let tail = &input[start..];
        let (prefix, suffix) = if tail.starts_with("<!--") {
            ("<!--", "-->")
        } else if tail.starts_with("<![CDATA[") {
            ("<![CDATA[", "]]>")
        } else if tail.starts_with("<?") {
            ("<?", "?>")
        } else {
            ("", "")
        };
        if !prefix.is_empty() {
            let body = start + prefix.len();
            let end = input[body..]
                .find(suffix)
                .ok_or_else(|| invalid("Unterminated XML comment, CDATA, or instruction"))?;
            cursor = body + end + suffix.len();
            continue;
        }
        if tail.starts_with("<!") {
            return Err(invalid("Unsupported XML declaration"));
        }

        let mut quote = None;
        let mut end = None;
        for (i, ch) in input[start + 1..].char_indices() {
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
            } else if ch == '"' || ch == '\'' {
                quote = Some(ch);
            } else if ch == '>' {
                end = Some(start + 1 + i);
                break;
            }
        }
        let end = end.ok_or_else(|| invalid("Unterminated XML tag"))?;
        found.push(input[start + 1..end].trim());
        cursor = end + 1;
    }
    Ok(found)
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')
}

fn tag_name(tag: &str) -> Result<(&str, &str), LcovError> {
    let split = tag.find(|c: char| !name_char(c)).unwrap_or(tag.len());
    let name = &tag[..split];
    if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return Err(invalid("Malformed JUnit XML tag"));
    }
    Ok((name, &tag[split..]))
}

fn attributes(input: &str) -> Result<BTreeMap<String, String>, LcovError> {
    let mut attrs = BTreeMap::new();
    let mut rest = input;
    while !rest.trim().is_empty() {
        if !rest.starts_with(char::is_whitespace) {
            return Err(invalid("Invalid JUnit XML attribute"));
        }
        rest = rest.trim_start();
        let (key, after_name) = tag_name(rest)?;
        rest = after_name.trim_start();
        if !rest.starts_with('=') {
            return Err(invalid("Invalid JUnit XML attribute"));
        }
        rest = rest[1..].trim_start();
        let quote = rest
            .chars()
            .next()
            .ok_or_else(|| invalid("Invalid JUnit XML attribute"))?;
        if quote != '"' && quote != '\'' {
            return Err(invalid("Invalid JUnit XML attribute"));
        }
        rest = &rest[1..];
        let pos = rest
            .find(quote)
            .ok_or_else(|| invalid("Invalid JUnit XML attribute"))?;
        let value = &rest[..pos];
        if attrs.insert(key.to_string(), value.to_string()).is_some() {
            return Err(invalid("Duplicate JUnit XML attribute"));
        }
        rest = &rest[pos + 1..];
    }
    Ok(attrs)
}

/// Parse a JUnit XML report into counters without executing or resolving XML
/// entities. The caller must enforce the same 10 MiB file limit as Node.
pub fn parse_junit(input: &str) -> Result<TestSummary, LcovError> {
    let mut stack: Vec<&str> = Vec::new();
    let mut root_seen = false;
    let mut suite_count = 0_u64;
    let mut total = 0_u64;
    let mut failed = 0_u64;
    let mut skipped = 0_u64;
    let mut suite: Option<Suite> = None;
    let mut case: Option<TestCase> = None;
    let mut root_cases = Suite::default();
    let mut root_attributes = None;

    for tag in tags(input)? {
        if let Some(closing) = tag.strip_prefix('/') {
            let closing = closing.trim();
            if closing.is_empty()
                || !closing.chars().all(name_char)
                || stack.last().copied() != Some(closing)
            {
                return Err(invalid("Malformed JUnit XML nesting"));
            }
            if closing == "testcase" {
                let completed = case
                    .take()
                    .ok_or_else(|| invalid("Unexpected JUnit testcase closing tag"))?;
                finish_case(completed, suite.as_mut().unwrap_or(&mut root_cases))?;
            }
            if closing == "testsuite"
                && stack.iter().filter(|name| **name == "testsuite").count() == 1
            {
                let completed = suite
                    .take()
                    .ok_or_else(|| invalid("Unexpected JUnit suite closing tag"))?;
                let (suite_failed, suite_skipped) = check_summary(&completed)?;
                total = checked_sum(total, completed.tests)?;
                failed = checked_sum(failed, suite_failed)?;
                skipped = checked_sum(skipped, suite_skipped)?;
                if checked_sum(failed, skipped)? > total {
                    return Err(invalid("JUnit counts inconsistent"));
                }
            }
            stack.pop();
            continue;
        }

        let self_closing = tag.ends_with('/');
        let open = if self_closing {
            tag[..tag.len() - 1].trim_end()
        } else {
            tag
        };
        let (name, remainder) = tag_name(open)?;
        let attrs = attributes(remainder)?;
        if stack.is_empty() {
            if root_seen || (name != "testsuite" && name != "testsuites") {
                return Err(invalid("Invalid JUnit XML root"));
            }
            root_seen = true;
            if name == "testsuites" {
                root_attributes = Some(attrs.clone());
            }
        }

        let outermost = name == "testsuite" && !stack.contains(&"testsuite");
        if outermost {
            let tests = attribute_count(&attrs, "tests")?
                .ok_or_else(|| invalid("JUnit suite missing tests"))?;
            suite_count = checked_sum(suite_count, 1)?;
            suite = Some(Suite {
                tests,
                attrs,
                ..Suite::default()
            });
        }
        if name == "testcase" {
            let direct = suite.is_none() && stack.len() == 1 && stack[0] == "testsuites";
            if case.is_some() || (suite.is_none() && !direct) {
                return Err(invalid("Invalid JUnit testcase nesting"));
            }
            case = Some(TestCase::default());
        } else if let Some(active) = case.as_mut() {
            match name {
                "failure" => active.failure = true,
                "error" => active.error = true,
                "skipped" => active.skipped = true,
                _ => {}
            }
        } else if suite.is_some() && matches!(name, "failure" | "error" | "skipped") {
            return Err(invalid("JUnit outcome outside testcase"));
        }

        if self_closing {
            if name == "testcase" {
                let completed = case
                    .take()
                    .ok_or_else(|| invalid("Unexpected JUnit testcase closing tag"))?;
                finish_case(completed, suite.as_mut().unwrap_or(&mut root_cases))?;
            }
            if outermost {
                let completed = suite
                    .take()
                    .ok_or_else(|| invalid("Unexpected JUnit suite closing tag"))?;
                let (suite_failed, suite_skipped) = check_summary(&completed)?;
                total = checked_sum(total, completed.tests)?;
                failed = checked_sum(failed, suite_failed)?;
                skipped = checked_sum(skipped, suite_skipped)?;
                if checked_sum(failed, skipped)? > total {
                    return Err(invalid("JUnit counts inconsistent"));
                }
            }
        } else {
            stack.push(name);
        }
    }
    if !root_seen || !stack.is_empty() || suite.is_some() || case.is_some() {
        return Err(invalid("Malformed JUnit XML document"));
    }
    if suite_count == 0 && root_cases.cases == 0 {
        return Err(invalid("No JUnit testsuite or testcase"));
    }

    total = checked_sum(total, root_cases.cases)?;
    failed = checked_sum(failed, checked_sum(root_cases.failures, root_cases.errors)?)?;
    skipped = checked_sum(skipped, root_cases.skipped)?;
    let resolved = checked_sum(failed, skipped)?;
    if resolved > total {
        return Err(invalid("JUnit counts inconsistent"));
    }
    if let Some(attrs) = root_attributes {
        if attribute_count(&attrs, "tests")?.is_some_and(|v| v != total)
            || attribute_count(&attrs, "skipped")?.is_some_and(|v| v != skipped)
        {
            return Err(invalid("JUnit root test counts disagree"));
        }
        if let (Some(failures), Some(errors)) = (
            attribute_count(&attrs, "failures")?,
            attribute_count(&attrs, "errors")?,
        ) {
            if checked_sum(failures, errors)? != failed {
                return Err(invalid("JUnit root failure counts disagree"));
            }
        }
    }
    Ok(TestSummary {
        total,
        failed,
        skipped,
        passed: total - resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(input: &str, expected: (u64, u64, u64, u64)) {
        let actual = parse_junit(input).expect("valid JUnit");
        assert_eq!(
            (actual.total, actual.passed, actual.failed, actual.skipped),
            expected
        );
    }

    #[test]
    fn accepts_node_compatible_junit_numeric_attributes() {
        summary("<testsuite tests=\"+1\" failures=\"+0\"><testcase/></testsuite>", (1, 1, 0, 0));
        summary("<testsuite tests=\"1e2\" failures=\"0\" errors=\"0\" skipped=\"100\"/>", (100, 0, 0, 100));
        summary("<testsuite tests=\"0x2\" failures=\"0\" errors=\"0\" skipped=\"2\"/>", (2, 0, 0, 2));
    }

    #[test]
    fn sibling_suites_with_summary_counters() {
        summary("<testsuites><testsuite tests=\"4\" failures=\"1\" errors=\"1\" skipped=\"1\"/><testsuite tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/></testsuites>", (6, 3, 2, 1));
    }

    #[test]
    fn nested_suites_are_not_double_counted() {
        summary("<?xml version=\"1.0\"?><testsuites tests=\"2\" failures=\"1\"><testsuite tests=\"2\" failures=\"1\"><testsuite tests=\"2\" failures=\"1\"><testcase/><testcase><failure/></testcase></testsuite></testsuite></testsuites>", (2, 1, 1, 0));
    }

    #[test]
    fn flat_node_reporter_cases_and_todos() {
        summary(
            include_str!("../test/fixtures/node22-junit.xml"),
            (3, 1, 1, 1),
        );
    }

    #[test]
    fn comments_cdata_and_quoted_gt() {
        summary("<testsuites><!-- <testsuite tests=\"999\"/> --><testsuite name=\"value > 0\" tests=\"2\" failures=\"1\"><testcase><![CDATA[<failure/>]]></testcase><testcase name='x > y'><failure/></testcase></testsuite></testsuites>", (2, 1, 1, 0));
    }

    #[test]
    fn derive_missing_counters_from_complete_cases() {
        summary("<testsuite tests=\"3\"><testcase/><testcase><error/></testcase><testcase><skipped/></testcase></testsuite>", (3, 1, 1, 1));
        summary("<testsuite tests=\"0\"/>", (0, 0, 0, 0));
    }

    #[test]
    fn mixes_direct_cases_and_suites() {
        summary("<testsuites tests=\"3\" failures=\"1\" errors=\"0\" skipped=\"0\"><testcase><failure/></testcase><testsuite tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\"/></testsuites>", (3, 2, 1, 0));
    }

    #[test]
    fn rejects_malformed_xml_or_conflicts() {
        for bad in [
            "<testsuites><testsuite tests=\"2\"></testsuites>",
            "<!DOCTYPE testsuites><testsuites/>",
            "<testsuite tests=\"2\"/>",
            "<testsuite tests=\"1\" failures=\"0\"><testcase><failure/></testcase></testsuite>",
            "<testsuite tests=\"1\"><testcase><failure/><skipped/></testcase></testsuite>",
            "<testsuites tests=\"2\"><testcase/></testsuites>",
            "<testsuites><wrapper><testcase/></wrapper></testsuites>",
            "<testsuite tests=\"2\"><testcase><failure/></testcase></testsuite>",
            "<testsuites><testsuite tests=\"1\" failures=\"0\" errors=\"0\" skipped=\"0\"><testcase><error/></testcase></testsuite></testsuites>",
        ] {
            assert!(parse_junit(bad).is_err(), "accepted {bad}");
        }
    }
}
