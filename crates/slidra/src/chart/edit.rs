// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The container-level splice writers for the `chart` command family.
//! Every command re-derives the FULL `ChartModel` (`read_chart_model`),
//! applies one patch, re-validates the WHOLE result (`validate_chart_model`
//! — never just the touched field, since cross-field rules like "stacked
//! requires axes=single" can be broken by a change to either field), then
//! re-renders and splices both the data element and the embedded `<svg>`
//! back in.
//!
//! NOT handled here: `scaleChartElement` (`element scale`/`element resize`
//! on a chart container) — that lives in element edit, not this file.

use crate::errors::{SlidraError, SlidraResult};
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
/// to.
fn read_view_box(svg_content: &str) -> SlidraResult<(f64, f64)> {
    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))?;
    let raw = attribute_value(svg_root, "viewBox")
        .ok_or_else(|| SlidraError::invalid("slide is missing viewBox"))?;
    let parts: Vec<f64> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
        .map(|token| crate::argv::parse_js_number(token).unwrap_or(f64::NAN))
        .collect();
    if parts.len() != 4 || parts.iter().any(|value| !value.is_finite()) {
        return Err(SlidraError::invalid(format!(
            "viewBox of the slide is not four numbers: {raw}"
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
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let (canvas_width, canvas_height) = read_view_box(svg_content)?;

    let chart_type = match &input.chart_type {
        None => ChartType::Bar,
        Some(raw) => ChartType::parse(raw)
            .filter(|t| CHART_TYPES.contains(t))
            .ok_or_else(|| SlidraError::invalid(format!("chart create unsupported type: {raw}")))?,
    };

    let series_count = input.series_count.unwrap_or(1.0);
    if series_count.fract() != 0.0
        || series_count < 1.0
        || series_count > CHART_CREATE_MAX_SERIES as f64
    {
        return Err(SlidraError::invalid(format!(
            "chart create's --series must be between 1 and {CHART_CREATE_MAX_SERIES} (received: {})",
            crate::chart::model::js_number_display(series_count)
        )));
    }
    let series_count = series_count as usize;

    let categories_count = input.categories_count.unwrap_or(6.0);
    if categories_count.fract() != 0.0
        || categories_count < 2.0
        || categories_count > CHART_CREATE_MAX_CATEGORIES as f64
    {
        return Err(SlidraError::invalid(format!(
            "chart create's --categories must be between 2 and {CHART_CREATE_MAX_CATEGORIES}; for more, create with chart create then add more data with chart data set (received: {})",
            crate::chart::model::js_number_display(categories_count)
        )));
    }
    let categories_count = categories_count as usize;

    let palette = match &input.palette {
        None => ChartPalette::Brand,
        Some(raw) => ChartPalette::parse(raw)
            .filter(|p| CHART_PALETTES.contains(p))
            .ok_or_else(|| {
                SlidraError::invalid(format!("chart create unsupported palette: {raw}"))
            })?,
    };

    let x = input.x.unwrap_or(canvas_width * 0.54);
    let y = input.y.unwrap_or(canvas_height * 0.16);
    let width = input.width.unwrap_or(canvas_width * 0.38);
    let height = input.height.unwrap_or(canvas_height * 0.66);
    if !x.is_finite() || !y.is_finite() {
        return Err(SlidraError::invalid("--x/--y must be finite numbers"));
    }
    if !width.is_finite() || width <= 0.0 {
        return Err(SlidraError::invalid(
            "--width must be a finite number greater than 0",
        ));
    }
    if !height.is_finite() || height <= 0.0 {
        return Err(SlidraError::invalid(
            "--height must be a finite number greater than 0",
        ));
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
        "<g id=\"{element_id}\" data-slidra-type=\"chart\" transform=\"translate({} {})\">{}{}</g>",
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
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    splice_chart_element(svg_content, element_id, mutate)
}

fn splice_chart_element(
    svg_content: &str,
    element_id: &str,
    mutate: impl FnOnce(ChartModel) -> ChartModel,
) -> SlidraResult<String> {
    let current = read_chart_model(svg_content, element_id)?;
    let next = mutate(current);
    validate_chart_model(&next)?;

    let roots = scan_document(svg_content)?;
    let container = require_chart_container(&roots, element_id)?;
    let chart_node = container
        .children
        .iter()
        .find(|child| child.tag == "slidra:chart")
        .expect("require_chart_container already confirmed this is a chart container");
    let svg_node = container
        .children
        .iter()
        .find(|child| child.tag == "svg")
        .ok_or_else(|| {
            SlidraError::invalid(format!("element {element_id} is missing embedded <svg>"))
        })?;

    // `chart_node`/`svg_node` offsets are UTF-16 code-unit offsets (see
    // `slide/scan.rs`'s module doc) — `crate::splice::Splice`'s offsets are
    // Rust byte offsets (see its module doc), so every offset here must be
    // converted before building a `Splice`, exactly as `set_attr_splice`
    // does for its own callers.
    let splices = [
        Splice {
            start: crate::text::runs::utf16_offset_to_byte_offset(svg_content, chart_node.start),
            end: crate::text::runs::utf16_offset_to_byte_offset(svg_content, chart_node.end),
            text: serialize_chart_data(&next),
        },
        Splice {
            start: crate::text::runs::utf16_offset_to_byte_offset(svg_content, svg_node.start),
            end: crate::text::runs::utf16_offset_to_byte_offset(svg_content, svg_node.end),
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
) -> SlidraResult<String> {
    if input.categories.is_empty() {
        return Err(SlidraError::invalid("category list cannot be empty"));
    }
    if input.series.is_empty() {
        return Err(SlidraError::invalid("chart cannot have no series"));
    }
    for (name, values) in &input.series {
        if name.is_empty() {
            return Err(SlidraError::invalid(
                "series name cannot be an empty string",
            ));
        }
        if values.is_empty() {
            return Err(SlidraError::invalid(format!(
                "series \"{name}\" cannot have zero values"
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
) -> SlidraResult<String> {
    let chart_type = ChartType::parse(chart_type)
        .ok_or_else(|| SlidraError::invalid(format!("unsupported type: {chart_type}")))?;
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
) -> SlidraResult<String> {
    let palette = ChartPalette::parse(palette)
        .ok_or_else(|| SlidraError::invalid(format!("unsupported palette: {palette}")))?;

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
            return Err(SlidraError::invalid(format!("series not found: {name}")));
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
) -> SlidraResult<String> {
    let axes = ChartAxesMode::parse(&input.axes)
        .ok_or_else(|| SlidraError::invalid(format!("unsupported axes: {}", input.axes)))?;
    if axes == ChartAxesMode::Single {
        if !input.right_series_names.is_empty() {
            return Err(SlidraError::invalid("axes=single cannot specify --right"));
        }
    } else if input.right_series_names.is_empty() {
        return Err(SlidraError::invalid(
            "axes=dual must use --right to specify at least one series, otherwise it's the same as single",
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
                return Err(SlidraError::invalid(format!("series not found: {name}")));
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
) -> SlidraResult<String> {
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
) -> SlidraResult<String> {
    let legend = match legend {
        "none" => ChartLegend::None,
        "bottom" => ChartLegend::Bottom,
        "right" => ChartLegend::Right,
        _ => {
            return Err(SlidraError::invalid(format!(
                "unsupported legend: {legend}"
            )));
        }
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
) -> SlidraResult<String> {
    match key {
        "grid" | "labels" => {
            if value != "true" && value != "false" {
                return Err(SlidraError::invalid(format!(
                    "{key}'s value can only be true or false"
                )));
            }
        }
        "x-title" | "y-title" => {}
        _ => return Err(SlidraError::invalid(format!("unsupported key: {key}"))),
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
