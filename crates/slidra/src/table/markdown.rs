//! `parseMarkdownTable`.
//!
//! GitHub-flavored Markdown pipe table parsing (`table set --markdown`).
//! Header row, an alignment row (`:---`/`---:`/`:---:`), then data rows.
//! `\|` inside a cell is a literal pipe, never a column separator.

use crate::errors::{SlidraError, SlidraResult};

use super::model::CellAlign;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMarkdownTable {
    pub headers: Vec<String>,
    /// Per-column alignment, from the alignment row; `Left` when the row
    /// declares no opinion for that column.
    pub aligns: Vec<CellAlign>,
    pub rows: Vec<Vec<String>>,
}

/// Splits one markdown table row into trimmed cells, honouring `\|` as a
/// literal pipe and stripping the table's own leading/trailing `|`.
fn split_row(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix('|') {
        trimmed = rest;
    }
    if trimmed.ends_with('|') && !trimmed.ends_with("\\|") {
        trimmed = &trimmed[..trimmed.len() - 1];
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' && chars.get(i + 1) == Some(&'|') {
            current.push('|');
            i += 2;
            continue;
        }
        if ch == '|' {
            cells.push(current.trim().to_string());
            current.clear();
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    cells.push(current.trim().to_string());
    cells
}

fn parse_align_cell(cell: &str) -> CellAlign {
    let left = cell.starts_with(':');
    let right = cell.ends_with(':');
    if left && right {
        CellAlign::Center
    } else if right {
        CellAlign::Right
    } else {
        CellAlign::Left
    }
}

/// `^:?-+:?$` — an alignment-row cell: optional leading/trailing `:`, one or
/// more `-` in between.
fn is_align_row_cell(cell: &str) -> bool {
    let bytes = cell.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut start = 0;
    let mut end = bytes.len();
    if bytes[start] == b':' {
        start += 1;
    }
    if end > start && bytes[end - 1] == b':' {
        end -= 1;
    }
    if start >= end {
        return false;
    }
    bytes[start..end].iter().all(|&b| b == b'-')
}

/// Parses a GitHub-style pipe table. Requires at least a header row and an
/// alignment row; every data row's cell count must match the header's.
pub fn parse_markdown_table(text: &str) -> SlidraResult<ParsedMarkdownTable> {
    // `split(/\r\n|\r|\n/)` in TS: splitting on either bare char
    // independently instead produces one extra empty segment between the
    // `\r` and `\n` of a `\r\n` pair — filtering empty (post-trim) lines
    // out below makes the two approaches observably identical here, since
    // only non-empty trimmed lines are ever kept.
    let lines: Vec<&str> = text
        .split(['\r', '\n'])
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() < 2 {
        return Err(SlidraError::invalid("Markdown 表格至少需要標頭列與對齊列"));
    }

    let headers = split_row(lines[0]);
    let align_cells = split_row(lines[1]);
    if align_cells.len() != headers.len() || !align_cells.iter().all(|cell| is_align_row_cell(cell))
    {
        return Err(SlidraError::invalid(
            "Markdown 表格第二列必須是對齊列（例如 :---、---:、:---:）",
        ));
    }
    let aligns: Vec<CellAlign> = align_cells.iter().map(|c| parse_align_cell(c)).collect();

    let mut rows = Vec::with_capacity(lines.len().saturating_sub(2));
    for (index, line) in lines.iter().skip(2).enumerate() {
        let cells = split_row(line);
        if cells.len() != headers.len() {
            return Err(SlidraError::invalid(format!(
                "Markdown 表格第 {} 列的欄數（{}）與標頭（{}）不符",
                index + 3,
                cells.len(),
                headers.len()
            )));
        }
        rows.push(cells);
    }

    Ok(ParsedMarkdownTable {
        headers,
        aligns,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_table_parses() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let parsed = parse_markdown_table(md).unwrap();
        assert_eq!(parsed.headers, vec!["a", "b"]);
        assert_eq!(parsed.aligns, vec![CellAlign::Left, CellAlign::Left]);
        assert_eq!(parsed.rows, vec![vec!["1".to_string(), "2".to_string()]]);
    }

    #[test]
    fn alignment_markers_parsed_per_column() {
        let md = "| a | b | c |\n|:---|---:|:---:|\n| 1 | 2 | 3 |\n";
        let parsed = parse_markdown_table(md).unwrap();
        assert_eq!(
            parsed.aligns,
            vec![CellAlign::Left, CellAlign::Right, CellAlign::Center]
        );
    }

    #[test]
    fn escaped_pipe_is_literal() {
        let md = "| a |\n|---|\n| x\\|y |\n";
        let parsed = parse_markdown_table(md).unwrap();
        assert_eq!(parsed.rows[0][0], "x|y");
    }

    #[test]
    fn missing_alignment_row_errors() {
        let err = parse_markdown_table("| a |\n").unwrap_err();
        assert_eq!(err.message(), "Markdown 表格至少需要標頭列與對齊列");
    }

    #[test]
    fn invalid_alignment_row_errors() {
        let md = "| a | b |\n| x | y |\n";
        let err = parse_markdown_table(md).unwrap_err();
        assert_eq!(
            err.message(),
            "Markdown 表格第二列必須是對齊列（例如 :---、---:、:---:）"
        );
    }

    #[test]
    fn mismatched_data_row_cell_count_errors() {
        let md = "| a | b |\n|---|---|\n| 1 |\n";
        let err = parse_markdown_table(md).unwrap_err();
        assert_eq!(
            err.message(),
            "Markdown 表格第 3 列的欄數（1）與標頭（2）不符"
        );
    }

    #[test]
    fn no_data_rows_is_legal() {
        let md = "| a |\n|---|\n";
        let parsed = parse_markdown_table(md).unwrap();
        assert!(parsed.rows.is_empty());
    }
}
