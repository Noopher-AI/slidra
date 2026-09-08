//! `chart` family argv parsing, ported from `packages/cli/src/argv.ts`'s
//! `case "chart":` block (lines 664-777) — flag names, positional order,
//! and every error message are ported verbatim from that range.

use crate::chart::edit::{CreateChartInput, SetChartAxisInput};
use crate::errors::{CoMotionError, CoMotionResult};

use super::{collect_repeated_flag, optional_flag, optional_number_flag, require_positional};

#[derive(Debug)]
pub enum ChartCommand {
    Create {
        id: String,
        slide_path: String,
        input: CreateChartInput,
    },
    DataSet {
        id: String,
        slide_path: String,
        element_id: String,
        /// The literal value that followed `--csv`, unexamined — `-` is
        /// meaningful only at the `main.rs` entry layer (stdin
        /// substitution), never interpreted here.
        csv: Option<String>,
        csv_asset: Option<String>,
        categories: Option<Vec<String>>,
        series: Vec<(String, Vec<f64>)>,
    },
    TypeSet {
        id: String,
        slide_path: String,
        element_id: String,
        chart_type: String,
    },
    PaletteSet {
        id: String,
        slide_path: String,
        element_id: String,
        palette: String,
        colors: Vec<(String, String)>,
    },
    AxisSet {
        id: String,
        slide_path: String,
        element_id: String,
        input: SetChartAxisInput,
    },
    StackSet {
        id: String,
        slide_path: String,
        element_id: String,
        stacked: bool,
    },
    LegendSet {
        id: String,
        slide_path: String,
        element_id: String,
        legend: String,
    },
    OptionSet {
        id: String,
        slide_path: String,
        element_id: String,
        key: String,
        value: String,
    },
}

/// `--series "name=v1,v2,v3"` -> `(name, values)`. Splits on the FIRST `=`
/// — a series name may not itself contain `=`.
fn parse_chart_series_flag(raw: &str) -> CoMotionResult<(String, Vec<f64>)> {
    let eq = raw.find('=').ok_or_else(|| {
        CoMotionError::invalid(format!("--series 格式錯誤，必須是 name=v1,v2,...：{raw}"))
    })?;
    let name = raw[..eq].to_string();
    let values = raw[eq + 1..]
        .split(',')
        .map(|token| {
            let value = super::parse_js_number(token).unwrap_or(f64::NAN);
            if token.trim().is_empty() || !value.is_finite() {
                Err(CoMotionError::invalid(format!(
                    "--series 的值不是合法數字：{raw}"
                )))
            } else {
                Ok(value)
            }
        })
        .collect::<CoMotionResult<Vec<f64>>>()?;
    Ok((name, values))
}

/// `--color "name=#RRGGBB"` -> `(name, color)`, same split rule as
/// `parse_chart_series_flag`.
fn parse_chart_color_flag(raw: &str) -> CoMotionResult<(String, String)> {
    let eq = raw.find('=').ok_or_else(|| {
        CoMotionError::invalid(format!("--color 格式錯誤，必須是 name=#RRGGBB：{raw}"))
    })?;
    Ok((raw[..eq].to_string(), raw[eq + 1..].to_string()))
}

pub fn parse(rest: &[String]) -> CoMotionResult<ChartCommand> {
    let level1 = rest.first().map(String::as_str);

    if level1 == Some("create") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "chart create", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart create", "slide-path")?;
        let chart_type = optional_flag(args, "--type")?;
        let series_count = optional_number_flag(args, "--series", "chart create")?;
        let categories_count = optional_number_flag(args, "--categories", "chart create")?;
        let palette = optional_flag(args, "--palette")?;
        let x = optional_number_flag(args, "--x", "chart create")?;
        let y = optional_number_flag(args, "--y", "chart create")?;
        let width = optional_number_flag(args, "--width", "chart create")?;
        let height = optional_number_flag(args, "--height", "chart create")?;
        return Ok(ChartCommand::Create {
            id,
            slide_path,
            input: CreateChartInput {
                chart_type,
                series_count,
                categories_count,
                palette,
                x,
                y,
                width,
                height,
            },
        });
    }

    let level2 = rest.get(1).map(String::as_str);
    let combined = format!("{} {}", level1.unwrap_or(""), level2.unwrap_or(""))
        .trim()
        .to_string();
    let args: &[String] = if rest.len() > 2 { &rest[2..] } else { &[] };

    if combined == "data set" {
        let id = require_positional(args, 0, "chart data set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart data set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart data set", "element-id")?;
        let csv = optional_flag(args, "--csv")?;
        let csv_asset = optional_flag(args, "--csv-asset")?;
        let categories_raw = optional_flag(args, "--categories")?;
        let series_raw = collect_repeated_flag(args, "--series")?;

        let given_count = (csv.is_some() as u8)
            + (csv_asset.is_some() as u8)
            + ((categories_raw.is_some() || !series_raw.is_empty()) as u8);
        if given_count != 1 {
            return Err(CoMotionError::invalid(
                "chart data set 必須恰好提供一種資料來源：--categories/--series、--csv 或 --csv-asset",
            ));
        }

        if csv.is_some() {
            return Ok(ChartCommand::DataSet {
                id,
                slide_path,
                element_id,
                csv,
                csv_asset: None,
                categories: None,
                series: Vec::new(),
            });
        }
        if csv_asset.is_some() {
            return Ok(ChartCommand::DataSet {
                id,
                slide_path,
                element_id,
                csv: None,
                csv_asset,
                categories: None,
                series: Vec::new(),
            });
        }
        let categories_raw = categories_raw
            .ok_or_else(|| CoMotionError::invalid("chart data set 缺少參數：--categories"))?;
        let categories: Vec<String> = categories_raw.split(',').map(str::to_string).collect();
        let series = series_raw
            .iter()
            .map(|raw| parse_chart_series_flag(raw))
            .collect::<CoMotionResult<Vec<_>>>()?;
        return Ok(ChartCommand::DataSet {
            id,
            slide_path,
            element_id,
            csv: None,
            csv_asset: None,
            categories: Some(categories),
            series,
        });
    }

    if combined == "type set" {
        let id = require_positional(args, 0, "chart type set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart type set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart type set", "element-id")?;
        let chart_type = require_positional(args, 3, "chart type set", "type")?;
        return Ok(ChartCommand::TypeSet {
            id,
            slide_path,
            element_id,
            chart_type,
        });
    }

    if combined == "palette set" {
        let id = require_positional(args, 0, "chart palette set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart palette set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart palette set", "element-id")?;
        let palette = require_positional(args, 3, "chart palette set", "palette")?;
        let colors = collect_repeated_flag(args, "--color")?
            .iter()
            .map(|raw| parse_chart_color_flag(raw))
            .collect::<CoMotionResult<Vec<_>>>()?;
        return Ok(ChartCommand::PaletteSet {
            id,
            slide_path,
            element_id,
            palette,
            colors,
        });
    }

    if combined == "axis set" {
        let id = require_positional(args, 0, "chart axis set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart axis set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart axis set", "element-id")?;
        let axes = require_positional(args, 3, "chart axis set", "single|dual")?;
        let right = collect_repeated_flag(args, "--right")?;
        return Ok(ChartCommand::AxisSet {
            id,
            slide_path,
            element_id,
            input: SetChartAxisInput {
                axes,
                right_series_names: right,
            },
        });
    }

    if combined == "stack set" {
        let id = require_positional(args, 0, "chart stack set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart stack set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart stack set", "element-id")?;
        let on_off = require_positional(args, 3, "chart stack set", "on|off")?;
        let stacked = match on_off.as_str() {
            "on" => true,
            "off" => false,
            _ => {
                return Err(CoMotionError::invalid(format!(
                    "chart stack set 不支援的值：{on_off}"
                )));
            }
        };
        return Ok(ChartCommand::StackSet {
            id,
            slide_path,
            element_id,
            stacked,
        });
    }

    if combined == "legend set" {
        let id = require_positional(args, 0, "chart legend set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart legend set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart legend set", "element-id")?;
        let legend = require_positional(args, 3, "chart legend set", "legend")?;
        return Ok(ChartCommand::LegendSet {
            id,
            slide_path,
            element_id,
            legend,
        });
    }

    if combined == "option set" {
        let id = require_positional(args, 0, "chart option set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "chart option set", "slide-path")?;
        let element_id = require_positional(args, 2, "chart option set", "element-id")?;
        let key = require_positional(args, 3, "chart option set", "key")?;
        let value = require_positional(args, 4, "chart option set", "value")?;
        return Ok(ChartCommand::OptionSet {
            id,
            slide_path,
            element_id,
            key,
            value,
        });
    }

    let unknown = rest.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    Err(CoMotionError::invalid(format!(
        "未知的子命令：chart {unknown}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn create_with_no_flags_uses_all_defaults() {
        let cmd = parse(&s(&["create", "pres-1", "slides/001.svg"])).unwrap();
        match cmd {
            ChartCommand::Create {
                id,
                slide_path,
                input,
            } => {
                assert_eq!(id, "pres-1");
                assert_eq!(slide_path, "slides/001.svg");
                assert_eq!(input.chart_type, None);
                assert_eq!(input.series_count, None);
            }
            _ => panic!("expected Create"),
        }
    }

    #[test]
    fn data_set_requires_exactly_one_source() {
        let err = parse(&s(&["data", "set", "pres-1", "slides/001.svg", "el-a"])).unwrap_err();
        assert_eq!(
            err.message(),
            "chart data set 必須恰好提供一種資料來源：--categories/--series、--csv 或 --csv-asset"
        );
    }

    #[test]
    fn data_set_two_sources_given_errors() {
        let err = parse(&s(&[
            "data",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--categories",
            "A,B",
            "--csv",
            "/tmp/x.csv",
        ]))
        .unwrap_err();
        assert_eq!(
            err.message(),
            "chart data set 必須恰好提供一種資料來源：--categories/--series、--csv 或 --csv-asset"
        );
    }

    #[test]
    fn data_set_csv_value_is_captured_verbatim_including_dash() {
        let cmd = parse(&s(&[
            "data",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--csv",
            "-",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::DataSet { csv, .. } => assert_eq!(csv, Some("-".to_string())),
            _ => panic!("expected DataSet"),
        }
    }

    #[test]
    fn data_set_categories_and_series_parsed() {
        let cmd = parse(&s(&[
            "data",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--categories",
            "Q1,Q2",
            "--series",
            "Revenue=120,150",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::DataSet {
                categories, series, ..
            } => {
                assert_eq!(categories, Some(vec!["Q1".to_string(), "Q2".to_string()]));
                assert_eq!(series, vec![("Revenue".to_string(), vec![120.0, 150.0])]);
            }
            _ => panic!("expected DataSet"),
        }
    }

    #[test]
    fn type_set_reads_four_positionals() {
        let cmd = parse(&s(&[
            "type",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "line",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::TypeSet { chart_type, .. } => assert_eq!(chart_type, "line"),
            _ => panic!("expected TypeSet"),
        }
    }

    #[test]
    fn stack_set_on_off_maps_to_bool() {
        let cmd = parse(&s(&[
            "stack",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "on",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::StackSet { stacked, .. } => assert!(stacked),
            _ => panic!("expected StackSet"),
        }
        let err = parse(&s(&[
            "stack",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "sideways",
        ]))
        .unwrap_err();
        assert_eq!(err.message(), "chart stack set 不支援的值：sideways");
    }

    #[test]
    fn unknown_subcommand_reports_the_first_two_tokens() {
        let err = parse(&s(&["frobnicate", "extra"])).unwrap_err();
        assert_eq!(err.message(), "未知的子命令：chart frobnicate extra");
    }

    #[test]
    fn palette_set_parses_repeated_color_flags() {
        let cmd = parse(&s(&[
            "palette",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "cool",
            "--color",
            "Series 1=#5B6DEA",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::PaletteSet {
                palette, colors, ..
            } => {
                assert_eq!(palette, "cool");
                assert_eq!(
                    colors,
                    vec![("Series 1".to_string(), "#5B6DEA".to_string())]
                );
            }
            _ => panic!("expected PaletteSet"),
        }
    }

    #[test]
    fn axis_set_single_with_right_flag_is_parsed_but_rejected_downstream() {
        // argv layer only parses — the "single 不可指定 --right" business
        // rule lives in chart::edit::set_chart_axis, not here.
        let cmd = parse(&s(&[
            "axis",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "single",
            "--right",
            "S1",
        ]))
        .unwrap();
        match cmd {
            ChartCommand::AxisSet { input, .. } => {
                assert_eq!(input.axes, "single");
                assert_eq!(input.right_series_names, vec!["S1".to_string()]);
            }
            _ => panic!("expected AxisSet"),
        }
    }
}
