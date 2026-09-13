// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `parseTableCsv`.
//!
//! RFC 4180 CSV parsing shared by `table bind`/`table refresh`/`table set
//! --from`. Quoted fields (comma/newline inside a value), `""` escaping,
//! `\r\n` and `\n` both accepted.

use std::collections::HashSet;

use crate::errors::{SlidraError, SlidraResult};

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTableCsv {
    pub headers: Vec<String>,
    /// One entry per data row, in the same order as `headers`.
    pub rows: Vec<Vec<String>>,
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Splits `text` into rows of fields, honouring RFC 4180 double-quote
/// escaping (`""` -> `"`). Iterates by `char` (Unicode scalar value) —
/// matching the TS source's per-UTF-16-code-unit indexing closely enough
/// for this codebase's realistic CSV input (plain ASCII delimiters/quotes;
/// no code point used here is ever split across two UTF-16 units).
fn parse_rows(text: &str) -> SlidraResult<Vec<Vec<String>>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;

    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0usize;

    let end_field = |field: &mut String, row: &mut Vec<String>| {
        row.push(std::mem::take(field));
    };
    let end_row = |field: &mut String, row: &mut Vec<String>, rows: &mut Vec<Vec<String>>| {
        end_field(field, row);
        rows.push(std::mem::take(row));
    };

    while i < n {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
                i += 1;
                continue;
            }
            field.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' {
            in_quotes = true;
            i += 1;
            continue;
        }
        if ch == ',' {
            end_field(&mut field, &mut row);
            i += 1;
            continue;
        }
        if ch == '\r' {
            if chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            end_row(&mut field, &mut row, &mut rows);
            i += 1;
            continue;
        }
        if ch == '\n' {
            end_row(&mut field, &mut row, &mut rows);
            i += 1;
            continue;
        }
        field.push(ch);
        i += 1;
    }
    if in_quotes {
        return Err(SlidraError::invalid("CSV syntax error: unclosed quote"));
    }
    if !field.is_empty() || !row.is_empty() {
        end_row(&mut field, &mut row, &mut rows);
    }
    Ok(rows)
}

/// Parses a table-data CSV: header row is the column names (`{{ }}` keys);
/// every following row must have exactly the same number of fields. Blank
/// lines (no fields, or a single empty field) are dropped before
/// validation. Header cells must be non-empty and unique.
pub fn parse_table_csv(text: &str) -> SlidraResult<ParsedTableCsv> {
    let all_rows: Vec<Vec<String>> = parse_rows(strip_bom(text))?
        .into_iter()
        .filter(|row| !(row.len() == 1 && row[0].is_empty()))
        .collect();
    if all_rows.is_empty() {
        return Err(SlidraError::invalid("CSV has no content"));
    }
    let mut iter = all_rows.into_iter();
    let headers = iter.next().expect("just checked non-empty");
    let data_rows: Vec<Vec<String>> = iter.collect();

    let mut seen: HashSet<&str> = HashSet::new();
    for (index, header) in headers.iter().enumerate() {
        if header.trim().is_empty() {
            return Err(SlidraError::invalid(format!(
                "CSV header column {}'s name cannot be blank",
                index + 1
            )));
        }
        if !seen.insert(header.as_str()) {
            return Err(SlidraError::invalid(format!(
                "CSV header column name duplicated: {header}"
            )));
        }
    }

    for (row_index, row) in data_rows.iter().enumerate() {
        if row.len() != headers.len() {
            return Err(SlidraError::invalid(format!(
                "CSV row {}'s column count ({}) does not match header ({})",
                row_index + 2,
                row.len(),
                headers.len()
            )));
        }
    }

    Ok(ParsedTableCsv {
        headers,
        rows: data_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_csv_parses() {
        let csv = parse_table_csv("a,b\n1,2\n3,4\n").unwrap();
        assert_eq!(csv.headers, vec!["a", "b"]);
        assert_eq!(
            csv.rows,
            vec![
                vec!["1".to_string(), "2".to_string()],
                vec!["3".to_string(), "4".to_string()],
            ]
        );
    }

    #[test]
    fn crlf_and_lf_both_accepted() {
        let csv = parse_table_csv("a,b\r\n1,2\r\n3,4\n").unwrap();
        assert_eq!(csv.rows.len(), 2);
    }

    #[test]
    fn quoted_field_with_comma_and_newline() {
        let csv = parse_table_csv("a,b\n\"x,y\",\"line1\nline2\"\n").unwrap();
        assert_eq!(csv.rows[0][0], "x,y");
        assert_eq!(csv.rows[0][1], "line1\nline2");
    }

    #[test]
    fn double_quote_escaping() {
        let csv = parse_table_csv("a\n\"say \"\"hi\"\"\"\n").unwrap();
        assert_eq!(csv.rows[0][0], "say \"hi\"");
    }

    #[test]
    fn bom_is_stripped() {
        let csv = parse_table_csv("\u{feff}a,b\n1,2\n").unwrap();
        assert_eq!(csv.headers, vec!["a", "b"]);
    }

    #[test]
    fn trailing_blank_line_is_dropped() {
        let csv = parse_table_csv("a,b\n1,2\n\n").unwrap();
        assert_eq!(csv.rows.len(), 1);
    }

    #[test]
    fn unclosed_quote_errors() {
        let err = parse_table_csv("a\n\"unterminated").unwrap_err();
        assert_eq!(err.message(), "CSV syntax error: unclosed quote");
    }

    #[test]
    fn empty_content_errors() {
        let err = parse_table_csv("").unwrap_err();
        assert_eq!(err.message(), "CSV has no content");
    }

    #[test]
    fn blank_header_cell_errors() {
        let err = parse_table_csv("a, \n1,2\n").unwrap_err();
        assert_eq!(err.message(), "CSV header column 2's name cannot be blank");
    }

    #[test]
    fn duplicate_header_errors() {
        let err = parse_table_csv("a,a\n1,2\n").unwrap_err();
        assert_eq!(err.message(), "CSV header column name duplicated: a");
    }

    #[test]
    fn mismatched_column_count_errors_with_1_based_row_number() {
        let err = parse_table_csv("a,b\n1,2\n3\n").unwrap_err();
        assert_eq!(
            err.message(),
            "CSV row 3's column count (1) does not match header (2)"
        );
    }

    #[test]
    fn header_only_csv_is_legal_with_zero_data_rows() {
        let csv = parse_table_csv("a,b\n").unwrap();
        assert!(csv.rows.is_empty());
    }
}
