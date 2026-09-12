// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `chart data set --csv` / `--csv-asset`'s parser, ported from
//! `packages/core/src/chart/csv.ts` (139 lines). RFC 4180 quoted fields (a
//! series name may legally contain a comma), BOM-stripped (CSV is data, not
//! a document — unlike slide text, which keeps a BOM verbatim), `\r\n` and
//! `\n` both accepted, trailing blank lines ignored.

use crate::errors::{SlidraError, SlidraResult};

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedChartCsvSeries {
    pub name: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedChartCsv {
    pub categories: Vec<String>,
    pub series: Vec<ParsedChartCsvSeries>,
}

/// Strips a single leading U+FEFF (BOM), if present. Deliberately checks
/// the first `char`, not the first byte — a UTF-8-encoded BOM is 3 bytes.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Splits `text` into rows of fields, honouring RFC 4180 double-quote
/// escaping (`""` -> `"`). Ported from `csv.ts`'s `parseRows`, operating on
/// `char`s (not bytes) since quote/comma/CR/LF are all single-`char`
/// ASCII delimiters and every other character is passed through verbatim
/// regardless of its byte width.
fn parse_rows(text: &str) -> SlidraResult<Vec<Vec<String>>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;

    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0usize;

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
            row.push(std::mem::take(&mut field));
            i += 1;
            continue;
        }
        if ch == '\r' {
            if chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            i += 1;
            continue;
        }
        if ch == '\n' {
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            i += 1;
            continue;
        }
        field.push(ch);
        i += 1;
    }

    if in_quotes {
        return Err(SlidraError::invalid("CSV syntax error: unclosed quote"));
    }
    // A trailing newline leaves `field == "" && row.is_empty()`, meaning
    // there is no partial final row to flush — only push one when there is
    // content pending.
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

/// Parses a chart CSV: header row is `<category axis label>,<series 1
/// name>,<series 2 name>,…` (the first header cell is ignored — it only
/// labels the category column for the human editing the file); every
/// following row is `<category name>,<value 1>,<value 2>,…`. Blank lines
/// (no fields, or a single empty field) are dropped before validation, so a
/// trailing newline is never "an empty data row".
pub fn parse_chart_csv(text: &str) -> SlidraResult<ParsedChartCsv> {
    let rows: Vec<Vec<String>> = parse_rows(strip_bom(text))?
        .into_iter()
        .filter(|row| !(row.len() == 1 && row[0].is_empty()))
        .collect();
    if rows.is_empty() {
        return Err(SlidraError::invalid("CSV has no data rows"));
    }
    let header = &rows[0];
    let data_rows = &rows[1..];
    if data_rows.is_empty() {
        return Err(SlidraError::invalid("CSV has no data rows"));
    }
    let series_names: Vec<&String> = header.iter().skip(1).collect();
    if series_names.is_empty() {
        return Err(SlidraError::invalid("CSV header has no series columns"));
    }

    let mut categories: Vec<String> = Vec::with_capacity(data_rows.len());
    let mut values: Vec<Vec<f64>> = series_names.iter().map(|_| Vec::new()).collect();

    for (row_index, row) in data_rows.iter().enumerate() {
        if row.len() != header.len() {
            return Err(SlidraError::invalid(format!(
                "CSV row {}'s column count ({}) does not match header ({})",
                row_index + 2,
                row.len(),
                header.len()
            )));
        }
        categories.push(row[0].clone());
        for (col, raw) in row.iter().enumerate().skip(1) {
            let value = crate::argv::parse_js_number(raw).unwrap_or(f64::NAN);
            if raw.trim().is_empty() || !value.is_finite() {
                return Err(SlidraError::invalid(format!(
                    "CSV row {} column {} is not a valid number: {raw}",
                    row_index + 2,
                    col + 1
                )));
            }
            values[col - 1].push(value);
        }
    }

    let series = series_names
        .into_iter()
        .zip(values)
        .map(|(name, values)| ParsedChartCsvSeries {
            name: name.clone(),
            values,
        })
        .collect();

    Ok(ParsedChartCsv { categories, series })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_csv() {
        let parsed = parse_chart_csv("Quarter,Revenue,Cost\nQ1,100,80\nQ2,120,90\n").unwrap();
        assert_eq!(parsed.categories, vec!["Q1".to_string(), "Q2".to_string()]);
        assert_eq!(
            parsed.series,
            vec![
                ParsedChartCsvSeries {
                    name: "Revenue".to_string(),
                    values: vec![100.0, 120.0]
                },
                ParsedChartCsvSeries {
                    name: "Cost".to_string(),
                    values: vec![80.0, 90.0]
                },
            ]
        );
    }

    #[test]
    fn strips_a_leading_bom() {
        let text = "\u{feff}Quarter,Revenue\nQ1,100\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.categories, vec!["Q1".to_string()]);
    }

    #[test]
    fn accepts_crlf_line_endings_same_as_lf() {
        let text = "Quarter,Revenue\r\nQ1,100\r\nQ2,120\r\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.categories, vec!["Q1".to_string(), "Q2".to_string()]);
    }

    #[test]
    fn ignores_a_trailing_blank_line() {
        let text = "Quarter,Revenue\nQ1,100\n\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.categories, vec!["Q1".to_string()]);
    }

    #[test]
    fn quoted_field_may_contain_a_comma() {
        let text = "Quarter,\"Rev, Net\"\nQ1,100\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.series[0].name, "Rev, Net");
    }

    #[test]
    fn doubled_quote_escapes_a_literal_quote() {
        let text = "Quarter,\"Say \"\"hi\"\"\"\nQ1,100\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.series[0].name, "Say \"hi\"");
    }

    #[test]
    fn unclosed_quote_is_a_syntax_error() {
        let text = "Quarter,\"Revenue\nQ1,100\n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(err.message(), "CSV syntax error: unclosed quote");
    }

    #[test]
    fn header_only_with_no_data_rows_errors() {
        let text = "Quarter,Revenue\n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(err.message(), "CSV has no data rows");
    }

    #[test]
    fn completely_empty_input_errors() {
        let err = parse_chart_csv("").unwrap_err();
        assert_eq!(err.message(), "CSV has no data rows");
    }

    #[test]
    fn header_with_no_series_columns_errors() {
        let text = "Quarter\nQ1\n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(err.message(), "CSV header has no series columns");
    }

    #[test]
    fn row_with_wrong_column_count_reports_one_based_row_number() {
        let text = "Quarter,Revenue\nQ1,100\nQ2\n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(
            err.message(),
            "CSV row 3's column count (1) does not match header (2)"
        );
    }

    #[test]
    fn blank_numeric_cell_reports_row_and_one_based_column_number() {
        let text = "Quarter,Revenue,Cost\nQ1,100, \n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(err.message(), "CSV row 2 column 3 is not a valid number:  ");
    }

    #[test]
    fn non_finite_numeric_cell_errors() {
        let text = "Quarter,Revenue\nQ1,not-a-number\n";
        let err = parse_chart_csv(text).unwrap_err();
        assert_eq!(
            err.message(),
            "CSV row 2 column 2 is not a valid number: not-a-number"
        );
    }

    #[test]
    fn category_name_with_a_comma_is_legal_at_the_csv_layer_when_quoted() {
        // NOOP-159r2 regression: a category containing a comma must be
        // quoted in the CSV (handled here) — `validate_chart_model`
        // (chart/model.rs) is the layer that then rejects it outright, so
        // this CSV-layer test only proves the comma survives quoting
        // intact into `categories`, not that the model accepts it.
        let text = "Quarter,Revenue\n\"Taipei, TW\",100\n";
        let parsed = parse_chart_csv(text).unwrap();
        assert_eq!(parsed.categories, vec!["Taipei, TW".to_string()]);
    }
}
