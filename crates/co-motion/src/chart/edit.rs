//! The container-level splice writers for the `chart` command family,
//! ported from `packages/core/src/chart/edit.ts` (363 lines). Every command
//! re-derives the FULL `ChartModel` (`read_chart_model`), applies one
//! patch, re-validates the WHOLE result (`validate_chart_model` — never
//! just the touched field, since cross-field rules like "stacked requires
//! axes=single" can be broken by a change to either field), then
//! re-renders and splices both the data element and the embedded `<svg>`
//! back in.
//!
//! NOT ported: `scaleChartElement` (`element scale`/`element resize` on a
//! chart container) — that is F4's (element edit) territory, not one of
//! this ticket's 8 CLI commands.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{attribute_value, scan_document};
use crate::splice::{Splice, apply_splices};
use crate::svgnum::format_svg_number;

use super::model::{
    CHART_CREATE_MAX_CATEGORIES, CHART_CREATE_MAX_SERIES, CHART_PALETTES, CHART_TYPES,
    ChartAxesMode, ChartLegend, ChartModel, ChartPalette, ChartSeries, ChartSeriesAxis, ChartType,
    read_chart_model, require_chart_container, serialize_chart_data, validate_chart_model,
};
use super::render::{render_chart_svg, round_half_up};

/// Reads the slide's root `<svg viewBox="minX minY width height">` — the
/// canvas dimensions `chart create`'s default position/size are relative
/// to. Ported from `chart/edit.ts`'s private `readViewBox`.
fn read_view_box(svg_content: &str) -> CoMotionResult<(f64, f64)> {
    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))?;
    let raw = attribute_value(svg_root, "viewBox")
        .ok_or_else(|| CoMotionError::invalid("投影片缺少 viewBox"))?;
    let parts: Vec<f64> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
        .map(|token| crate::argv::parse_js_number(token).unwrap_or(f64::NAN))
        .collect();
    if parts.len() != 4 || parts.iter().any(|value| !value.is_finite()) {
        return Err(CoMotionError::invalid(format!(
            "投影片的 viewBox 不是四個數字：{raw}"
        )));
    }
    Ok((parts[2], parts[3]))
}

#[derive(Debug, Clone, Default)]
pub struct CreateChartInput {
    pub chart_type: Option<String>,
    pub series_count: Option<f64>,
    pub categories_count: Option<f64>,
    pub palette: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// `chart create` — sample data from a deterministic formula so a
/// screenshot baseline stays stable.
pub fn create_chart_element(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: &CreateChartInput,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let (canvas_width, canvas_height) = read_view_box(svg_content)?;

    let chart_type = match &input.chart_type {
        None => ChartType::Bar,
        Some(raw) => ChartType::parse(raw)
            .filter(|t| CHART_TYPES.contains(t))
            .ok_or_else(|| CoMotionError::invalid(format!("chart create 不支援的 type：{raw}")))?,
    };

    let series_count = input.series_count.unwrap_or(1.0);
    if series_count.fract() != 0.0
        || series_count < 1.0
        || series_count > CHART_CREATE_MAX_SERIES as f64
    {
        return Err(CoMotionError::invalid(format!(
            "chart create 的 --series 必須介於 1 到 {CHART_CREATE_MAX_SERIES} 之間（收到：{})",
            crate::chart::model::js_number_display(series_count)
        )));
    }
    let series_count = series_count as usize;

    let categories_count = input.categories_count.unwrap_or(6.0);
    if categories_count.fract() != 0.0
        || categories_count < 2.0
        || categories_count > CHART_CREATE_MAX_CATEGORIES as f64
    {
        return Err(CoMotionError::invalid(format!(
            "chart create 的 --categories 必須介於 2 到 {CHART_CREATE_MAX_CATEGORIES} 之間，超過請用 chart create 建立後再用 chart data set 給更多資料（收到：{}）",
            crate::chart::model::js_number_display(categories_count)
        )));
    }
    let categories_count = categories_count as usize;

    let palette = match &input.palette {
        None => ChartPalette::Brand,
        Some(raw) => ChartPalette::parse(raw)
            .filter(|p| CHART_PALETTES.contains(p))
            .ok_or_else(|| {
                CoMotionError::invalid(format!("chart create 不支援的 palette：{raw}"))
            })?,
    };

    let x = input.x.unwrap_or(canvas_width * 0.54);
    let y = input.y.unwrap_or(canvas_height * 0.16);
    let width = input.width.unwrap_or(canvas_width * 0.38);
    let height = input.height.unwrap_or(canvas_height * 0.66);
    if !x.is_finite() || !y.is_finite() {
        return Err(CoMotionError::invalid("--x/--y 必須是有限數字"));
    }
    if !width.is_finite() || width <= 0.0 {
        return Err(CoMotionError::invalid("--width 必須是大於 0 的有限數字"));
    }
    if !height.is_finite() || height <= 0.0 {
        return Err(CoMotionError::invalid("--height 必須是大於 0 的有限數字"));
    }

    let categories: Vec<String> = (0..categories_count)
        .map(|j| format!("C{}", j + 1))
        .collect();
    let series: Vec<ChartSeries> = (0..series_count)
        .map(|i| ChartSeries {
            name: format!("Series {}", i + 1),
            values: (0..categories_count)
                .map(|j| round_half_up(30.0 + 60.0 * ((j as f64) * 1.3 + i as f64).sin().abs()))
                .collect(),
            axis: ChartSeriesAxis::Left,
            color: None,
        })
        .collect();

    let model = ChartModel {
        chart_type,
        stacked: false,
        axes: ChartAxesMode::Single,
        palette,
        legend: ChartLegend::Bottom,
        grid: true,
        labels: true,
        x_title: String::new(),
        y_title: String::new(),
        width,
        height,
        series,
        categories,
    };
    validate_chart_model(&model)?;

    let markup = format!(
        "<g id=\"{element_id}\" data-comot-type=\"chart\" transform=\"translate({} {})\">{}{}</g>",
        format_svg_number(x),
        format_svg_number(y),
        serialize_chart_data(&model),
        render_chart_svg(&model)
    );

    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .expect("assert_slide_compliant already confirmed the root is <svg>");
    // `content_end` is a UTF-16 code-unit offset (see `slide/scan.rs`'s
    // module doc and `crate::splice::Splice`'s doc comment) — must be
    // converted to a Rust byte offset before slicing `svg_content`, or a
    // CJK/astral character anywhere earlier in the document corrupts the
    // insertion point.
    let content_end =
        crate::text::runs::utf16_offset_to_byte_offset(svg_content, svg_root.content_end);
    Ok(format!(
        "{}{markup}{}",
        &svg_content[..content_end],
        &svg_content[content_end..]
    ))
}

fn update_chart_element(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    mutate: impl FnOnce(ChartModel) -> ChartModel,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    splice_chart_element(svg_content, element_id, mutate)
}

fn splice_chart_element(
    svg_content: &str,
    element_id: &str,
    mutate: impl FnOnce(ChartModel) -> ChartModel,
) -> CoMotionResult<String> {
    let current = read_chart_model(svg_content, element_id)?;
    let next = mutate(current);
    validate_chart_model(&next)?;

    let roots = scan_document(svg_content)?;
    let container = require_chart_container(&roots, element_id)?;
    let chart_node = container
        .children
        .iter()
        .find(|child| child.tag == "comot:chart")
        .expect("require_chart_container already confirmed this is a chart container");
    let svg_node = container
        .children
        .iter()
        .find(|child| child.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid(format!("元素 {element_id} 缺少內嵌 <svg>")))?;

    let splices = [
        Splice {
            start: chart_node.start,
            end: chart_node.end,
            text: serialize_chart_data(&next),
        },
        Splice {
            start: svg_node.start,
            end: svg_node.end,
            text: render_chart_svg(&next),
        },
    ];
    Ok(apply_splices(svg_content, &splices))
}

#[derive(Debug, Clone)]
pub struct SetChartDataInput {
    pub categories: Vec<String>,
    pub series: Vec<(String, Vec<f64>)>,
}

/// `chart data set` — a wholesale replace; an existing series' `axis`/
/// `color` carries over by name, a new name gets the defaults.
pub fn set_chart_data(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: SetChartDataInput,
) -> CoMotionResult<String> {
    if input.categories.is_empty() {
        return Err(CoMotionError::invalid("類別清單不可為空"));
    }
    if input.series.is_empty() {
        return Err(CoMotionError::invalid("圖表不能沒有系列"));
    }
    for (name, values) in &input.series {
        if name.is_empty() {
            return Err(CoMotionError::invalid("系列名稱不可為空字串"));
        }
        if values.is_empty() {
            return Err(CoMotionError::invalid(format!(
                "系列「{name}」不可沒有任何值"
            )));
        }
    }
    update_chart_element(svg_content, slide_path, element_id, |current| {
        let existing_by_name: std::collections::HashMap<&str, &ChartSeries> = current
            .series
            .iter()
            .map(|series| (series.name.as_str(), series))
            .collect();
        let next_series: Vec<ChartSeries> = input
            .series
            .into_iter()
            .map(|(name, values)| {
                let (axis, color) = existing_by_name
                    .get(name.as_str())
                    .map(|series| (series.axis, series.color.clone()))
                    .unwrap_or((ChartSeriesAxis::Left, None));
                ChartSeries {
                    name,
                    values,
                    axis,
                    color,
                }
            })
            .collect();
        ChartModel {
            categories: input.categories,
            series: next_series,
            ..current
        }
    })
}

/// `chart type set` — switching to pie/donut while stacked or dual is left
/// for `validate_chart_model` to reject.
pub fn set_chart_type(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    chart_type: &str,
) -> CoMotionResult<String> {
    let chart_type = ChartType::parse(chart_type)
        .ok_or_else(|| CoMotionError::invalid(format!("不支援的 type：{chart_type}")))?;
    update_chart_element(svg_content, slide_path, element_id, |current| ChartModel {
        chart_type,
        ..current
    })
}

/// `chart palette set` — `color_overrides` only touches the series named in
/// it; every other series keeps its current colour untouched.
pub fn set_chart_palette(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    palette: &str,
    color_overrides: &[(String, String)],
) -> CoMotionResult<String> {
    let palette = ChartPalette::parse(palette)
        .ok_or_else(|| CoMotionError::invalid(format!("不支援的 palette：{palette}")))?;

    // Name-existence check runs before the splice/validate pipeline (every
    // `update_chart_element` mutate closure is infallible by design — see
    // `set_chart_axis`'s identical pattern above): reading the current
    // model here once, then re-deriving it again inside
    // `update_chart_element`, is a deliberate small duplication in
    // exchange for keeping every mutate closure infallible.
    let current = read_chart_model(svg_content, element_id)?;
    let names: std::collections::HashSet<&str> =
        current.series.iter().map(|s| s.name.as_str()).collect();
    for (name, _) in color_overrides {
        if !names.contains(name.as_str()) {
            return Err(CoMotionError::invalid(format!("找不到系列：{name}")));
        }
    }

    let overrides: std::collections::HashMap<&str, &str> = color_overrides
        .iter()
        .map(|(name, color)| (name.as_str(), color.as_str()))
        .collect();
    update_chart_element(svg_content, slide_path, element_id, |current| ChartModel {
        palette,
        series: current
            .series
            .into_iter()
            .map(|series| {
                let color = overrides
                    .get(series.name.as_str())
                    .map(|c| c.to_string())
                    .or(series.color);
                ChartSeries { color, ..series }
            })
            .collect(),
        ..current
    })
}

#[derive(Debug, Clone)]
pub struct SetChartAxisInput {
    pub axes: String,
    pub right_series_names: Vec<String>,
}

/// `chart axis set` — a full replace of every series' axis assignment, not
/// an incremental patch.
pub fn set_chart_axis(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: SetChartAxisInput,
) -> CoMotionResult<String> {
    let axes = ChartAxesMode::parse(&input.axes)
        .ok_or_else(|| CoMotionError::invalid(format!("不支援的 axes：{}", input.axes)))?;
    if axes == ChartAxesMode::Single {
        if !input.right_series_names.is_empty() {
            return Err(CoMotionError::invalid("axes=single 不可指定 --right"));
        }
    } else if input.right_series_names.is_empty() {
        return Err(CoMotionError::invalid(
            "axes=dual 必須用 --right 指定至少一個系列，否則等同 single",
        ));
    }

    // Name-existence check runs before the splice/validate pipeline (same
    // reasoning as `set_chart_palette`): reading the current model here
    // once, then re-deriving it again inside `update_chart_element`, is a
    // deliberate small duplication in exchange for keeping every mutate
    // closure infallible.
    if axes == ChartAxesMode::Dual {
        let current = read_chart_model(svg_content, element_id)?;
        let names: std::collections::HashSet<&str> =
            current.series.iter().map(|s| s.name.as_str()).collect();
        for name in &input.right_series_names {
            if !names.contains(name.as_str()) {
                return Err(CoMotionError::invalid(format!("找不到系列：{name}")));
            }
        }
    }

    let right_set: std::collections::HashSet<&str> = input
        .right_series_names
        .iter()
        .map(String::as_str)
        .collect();
    update_chart_element(svg_content, slide_path, element_id, |current| {
        if axes == ChartAxesMode::Single {
            return ChartModel {
                axes,
                series: current
                    .series
                    .into_iter()
                    .map(|series| ChartSeries {
                        axis: ChartSeriesAxis::Left,
                        ..series
                    })
                    .collect(),
                ..current
            };
        }
        ChartModel {
            axes,
            series: current
                .series
                .into_iter()
                .map(|series| {
                    let axis = if right_set.contains(series.name.as_str()) {
                        ChartSeriesAxis::Right
                    } else {
                        ChartSeriesAxis::Left
                    };
                    ChartSeries { axis, ..series }
                })
                .collect(),
            ..current
        }
    })
}

/// `chart stack set` — the type/axes cross-checks are `validate_chart_model`'s,
/// not duplicated here.
pub fn set_chart_stack(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    stacked: bool,
) -> CoMotionResult<String> {
    update_chart_element(svg_content, slide_path, element_id, |current| ChartModel {
        stacked,
        ..current
    })
}

/// `chart legend set`.
pub fn set_chart_legend(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    legend: &str,
) -> CoMotionResult<String> {
    let legend = match legend {
        "none" => ChartLegend::None,
        "bottom" => ChartLegend::Bottom,
        "right" => ChartLegend::Right,
        _ => return Err(CoMotionError::invalid(format!("不支援的 legend：{legend}"))),
    };
    update_chart_element(svg_content, slide_path, element_id, |current| ChartModel {
        legend,
        ..current
    })
}

/// `chart option set` — the one command covering the four remaining display
/// toggles.
pub fn set_chart_option(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    key: &str,
    value: &str,
) -> CoMotionResult<String> {
    match key {
        "grid" | "labels" => {
            if value != "true" && value != "false" {
                return Err(CoMotionError::invalid(format!(
                    "{key} 的值只能是 true 或 false"
                )));
            }
        }
        "x-title" | "y-title" => {}
        _ => return Err(CoMotionError::invalid(format!("不支援的 key：{key}"))),
    }
    let key = key.to_string();
    let value = value.to_string();
    update_chart_element(
        svg_content,
        slide_path,
        element_id,
        move |current| match key.as_str() {
            "grid" => ChartModel {
                grid: value == "true",
                ..current
            },
            "labels" => ChartModel {
                labels: value == "true",
                ..current
            },
            "x-title" => ChartModel {
                x_title: value,
                ..current
            },
            "y-title" => ChartModel {
                y_title: value,
                ..current
            },
            _ => unreachable!("checked above"),
        },
    )
}
