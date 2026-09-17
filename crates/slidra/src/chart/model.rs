// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The `<slidra:chart>` data model, ported from `packages/core/src/chart/model.ts`
//! (356 lines). Pure `svgContent: string -> value` / `value -> string`
//! functions — no filesystem access, matching the TS original's "no `node:`
//! imports" design note (the front end's local preview channel has to run
//! this too, even though no Rust caller does yet).
//!
//! ## Signature deviation from the TS original: `require_chart_container`
//!
//! TS's `requireChartContainer(svgContent: string, elementId: string): ScannedNode`
//! calls `scanDocument` internally and returns a reference into the tree it
//! just built — trivial in JS, impossible in Rust without either cloning a
//! whole `ScannedNode` subtree (which does not implement `Clone`, and
//! `slide/scan.rs` is out of this ticket's scope to change) or returning a
//! self-referential struct. This port instead takes the ALREADY-scanned
//! `roots` and returns a borrow into them (`require_chart_container(roots,
//! element_id) -> SlidraResult<&ScannedNode>`); every caller here already
//! needs `scan_document`'s result for other reasons in the same scope, so
//! this costs nothing at the call sites (see `chart/edit.rs`). Purely a
//! signature change — the search algorithm and every error message are
//! ported verbatim.

use std::collections::HashSet;

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::format::CHART_CONTAINER_TYPE;
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::escape_xml_attr;

/// Same value as `effects::edit::EFFECTS_NS` — the `<slidra:effects>`/
/// `<slidra:notes>` namespace, reused for `<slidra:chart>` (ADR-0008
/// amendment). Duplicated here as a literal rather than imported, to avoid
/// a cross-module dependency for a single constant.
pub const CHART_NS: &str = "https://slidra.app/ns/2026";

pub const CHART_MIN_CATEGORIES: usize = 2;
pub const CHART_MAX_CATEGORIES: usize = 60;
pub const CHART_MIN_SERIES: usize = 1;
pub const CHART_MAX_SERIES: usize = 12;
/// `chart create`'s own, tighter caps (its insert-panel boundary, plan §4.4).
pub const CHART_CREATE_MAX_SERIES: usize = 4;
pub const CHART_CREATE_MAX_CATEGORIES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartType {
    Bar,
    Hbar,
    Line,
    Area,
    Pie,
    Donut,
}

impl ChartType {
    const VALUES: &'static [(ChartType, &'static str)] = &[
        (ChartType::Bar, "bar"),
        (ChartType::Hbar, "hbar"),
        (ChartType::Line, "line"),
        (ChartType::Area, "area"),
        (ChartType::Pie, "pie"),
        (ChartType::Donut, "donut"),
    ];

    pub fn as_str(self) -> &'static str {
        Self::VALUES
            .iter()
            .find(|(variant, _)| *variant == self)
            .expect("VALUES covers every variant")
            .1
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::VALUES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|(variant, _)| *variant)
    }
}

pub const CHART_TYPES: &[ChartType] = &[
    ChartType::Bar,
    ChartType::Hbar,
    ChartType::Line,
    ChartType::Area,
    ChartType::Pie,
    ChartType::Donut,
];

/// Only these three types have a meaningful "stack" (ADR-0008 amendment).
pub const CHART_STACKABLE_TYPES: &[ChartType] = &[ChartType::Bar, ChartType::Hbar, ChartType::Area];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartPalette {
    Brand,
    Cool,
    Warm,
}

impl ChartPalette {
    const VALUES: &'static [(ChartPalette, &'static str)] = &[
        (ChartPalette::Brand, "brand"),
        (ChartPalette::Cool, "cool"),
        (ChartPalette::Warm, "warm"),
    ];

    pub fn as_str(self) -> &'static str {
        Self::VALUES
            .iter()
            .find(|(variant, _)| *variant == self)
            .expect("VALUES covers every variant")
            .1
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::VALUES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|(variant, _)| *variant)
    }
}

pub const CHART_PALETTES: &[ChartPalette] =
    &[ChartPalette::Brand, ChartPalette::Cool, ChartPalette::Warm];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartLegend {
    None,
    Bottom,
    Right,
}

impl ChartLegend {
    const VALUES: &'static [(ChartLegend, &'static str)] = &[
        (ChartLegend::None, "none"),
        (ChartLegend::Bottom, "bottom"),
        (ChartLegend::Right, "right"),
    ];

    pub fn as_str(self) -> &'static str {
        Self::VALUES
            .iter()
            .find(|(variant, _)| *variant == self)
            .expect("VALUES covers every variant")
            .1
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::VALUES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|(variant, _)| *variant)
    }
}

pub const CHART_LEGENDS: &[ChartLegend] =
    &[ChartLegend::None, ChartLegend::Bottom, ChartLegend::Right];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartAxesMode {
    Single,
    Dual,
}

impl ChartAxesMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ChartAxesMode::Single => "single",
            ChartAxesMode::Dual => "dual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "single" => Some(ChartAxesMode::Single),
            "dual" => Some(ChartAxesMode::Dual),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartSeriesAxis {
    Left,
    Right,
}

impl ChartSeriesAxis {
    pub fn as_str(self) -> &'static str {
        match self {
            ChartSeriesAxis::Left => "left",
            ChartSeriesAxis::Right => "right",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(ChartSeriesAxis::Left),
            "right" => Some(ChartSeriesAxis::Right),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChartSeries {
    pub name: String,
    pub values: Vec<f64>,
    pub axis: ChartSeriesAxis,
    /// `None` when unset — the renderer falls back to the palette's `i % 6`
    /// colour.
    pub color: Option<String>,
}

/// `type` is a Rust keyword; the TS field of the same name is renamed
/// `chart_type` throughout this port (behavior-neutral).
#[derive(Debug, Clone, PartialEq)]
pub struct ChartModel {
    pub chart_type: ChartType,
    pub stacked: bool,
    pub axes: ChartAxesMode,
    pub palette: ChartPalette,
    pub legend: ChartLegend,
    pub grid: bool,
    pub labels: bool,
    pub x_title: String,
    pub y_title: String,
    pub width: f64,
    pub height: f64,
    pub series: Vec<ChartSeries>,
    pub categories: Vec<String>,
}

/// Ports `String(number)` for the specific job of interpolating a
/// (possibly non-finite) raw number into a Traditional-Chinese error
/// message — used only inside this module's validation errors, NOT for any
/// value that ends up in rendered SVG output (that is `format_js_number`'s
/// and `format_svg_number`'s job, both in `svgnum.rs`, already `pub` and
/// used as-is per this ticket's brief).
///
/// `crate::svgnum::format_js_number` (`format!("{value}")`) is deliberately
/// NOT reused here: verified against a real `rustc` build in this sandbox
/// (see delivery notes), Rust's `f64` `Display` prints `NaN`/-0` and
/// `inf`/`-inf` for the infinities — `NaN` happens to already match JS, but
/// `-0` and `inf`/`-inf` do NOT (`String(Infinity) === "Infinity"` in JS,
/// never `"inf"`; `String(-0) === "0"`, never `"-0"`). Error messages in
/// this module are exactly where a caller is most likely to pass a
/// non-finite or negative-zero value (that is often the whole point of the
/// message), so this project's "flag, don't silently assume" convention
/// (`svgnum.rs`'s own KNOWN GAP notes) applies: this helper closes the gap
/// locally instead of leaving a latent one in every validation message.
pub(crate) fn js_number_display(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == f64::INFINITY {
        return "Infinity".to_string();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    if value == 0.0 {
        // Collapses -0.0 to "0", matching JS's `String(-0) === "0"`.
        return "0".to_string();
    }
    crate::svgnum::format_js_number(value)
}

fn is_valid_hex_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    let chars: Vec<char> = hex.chars().collect();
    (chars.len() == 3 || chars.len() == 6) && chars.iter().all(|c| c.is_ascii_hexdigit())
}

/// `requireEnum` for a string already known (by construction, at the
/// read/parse boundary) to need runtime domain-checking — used only where
/// this port still has a raw `&str` to validate (reading an attribute off
/// `<slidra:chart>`). Once a value is one of this module's enums, Rust's
/// type system is the domain check, so `validate_chart_model` below never
/// needs to call this for `chart_type`/`palette`/`legend`/`axes`/`axis`
/// (unlike the TS original, which re-validates them defensively even
/// though its own `ChartModel` type claims they are already narrow unions
/// — a distinction without a runtime difference in JS, but a real one once
/// the type system enforces it, as here).
fn require_enum<T: Copy>(
    value: &str,
    values: &[(T, &'static str)],
    label: &str,
) -> SlidraResult<T> {
    values
        .iter()
        .find(|(_, name)| *name == value)
        .map(|(variant, _)| *variant)
        .ok_or_else(|| {
            let joined = values
                .iter()
                .map(|(_, name)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            SlidraError::invalid(format!(
                "{label} must be one of the following: {joined} (received: {value})"
            ))
        })
}

fn join_types(types: &[ChartType]) -> String {
    types
        .iter()
        .map(|t| t.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every invariant a `<slidra:chart>` must hold for `render_chart_svg` to
/// produce a sane picture — ported verbatim from `chart/model.ts:85-163`,
/// minus the four `requireEnum` calls TS makes for `type`/`palette`/
/// `legend`/`axis` (see `require_enum`'s doc comment for why those are
/// redundant once the field is Rust-enum-typed). Called before every write
/// (`chart/edit.rs`) and after every read (`read_chart_model` below): a
/// model this function accepts is always safe to render.
pub fn validate_chart_model(model: &ChartModel) -> SlidraResult<()> {
    if !(model.width.is_finite() && model.width > 0.0) {
        return Err(SlidraError::invalid(format!(
            "width must be a finite number greater than 0: {}",
            js_number_display(model.width)
        )));
    }
    if !(model.height.is_finite() && model.height > 0.0) {
        return Err(SlidraError::invalid(format!(
            "height must be a finite number greater than 0: {}",
            js_number_display(model.height)
        )));
    }

    let category_count = model.categories.len();
    if !(CHART_MIN_CATEGORIES..=CHART_MAX_CATEGORIES).contains(&category_count) {
        return Err(SlidraError::invalid(format!(
            "category count must be between {CHART_MIN_CATEGORIES} and {CHART_MAX_CATEGORIES} (received: {category_count})"
        )));
    }
    if model.categories.iter().any(|category| category.is_empty()) {
        return Err(SlidraError::invalid(
            "category name cannot be an empty string",
        ));
    }
    // `serialize_chart_data` joins categories with "," into
    // <slidra:categories values="…">; a category name that itself contains
    // a comma is indistinguishable from the delimiter on read-back,
    // silently splitting into extra categories and permanently desyncing
    // every series' value count from the category count (NOOP-159r2 FAIL
    // 2). Regression guard, do not remove.
    if let Some(comma_category) = model
        .categories
        .iter()
        .find(|category| category.contains(','))
    {
        return Err(SlidraError::invalid(format!(
            "category name cannot contain a comma (would be misread as a separator): {comma_category}"
        )));
    }

    let series_count = model.series.len();
    if !(CHART_MIN_SERIES..=CHART_MAX_SERIES).contains(&series_count) {
        return Err(SlidraError::invalid(format!(
            "series count must be between {CHART_MIN_SERIES} and {CHART_MAX_SERIES} (received: {series_count})"
        )));
    }

    let mut seen_names: HashSet<&str> = HashSet::new();
    for series in &model.series {
        if series.name.is_empty() {
            return Err(SlidraError::invalid(
                "series name cannot be an empty string",
            ));
        }
        if series.name.contains(',') {
            return Err(SlidraError::invalid(format!(
                "series name cannot contain a comma: {}",
                series.name
            )));
        }
        if !seen_names.insert(series.name.as_str()) {
            return Err(SlidraError::invalid(format!(
                "duplicate series name: {}",
                series.name
            )));
        }

        if series.values.len() != category_count {
            return Err(SlidraError::invalid(format!(
                "series \"{}\" value count ({}) does not match category count ({})",
                series.name,
                series.values.len(),
                category_count
            )));
        }
        for (index, value) in series.values.iter().enumerate() {
            if !value.is_finite() {
                return Err(SlidraError::invalid(format!(
                    "series \"{}\": the {}th value is not a finite number: {}",
                    series.name,
                    index + 1,
                    js_number_display(*value)
                )));
            }
        }

        if series.axis == ChartSeriesAxis::Right && model.axes == ChartAxesMode::Single {
            return Err(SlidraError::invalid(format!(
                "series \"{}\" specifies axis=\"right\", but chart axes is single",
                series.name
            )));
        }
        if let Some(color) = &series.color {
            if !is_valid_hex_color(color) {
                return Err(SlidraError::invalid(format!(
                    "series \"{}\" color is not a valid #RGB or #RRGGBB: {}",
                    series.name, color
                )));
            }
        }
    }

    if model.stacked {
        if !CHART_STACKABLE_TYPES.contains(&model.chart_type) {
            return Err(SlidraError::invalid(format!(
                "type={} does not support stacking, only {} can",
                model.chart_type.as_str(),
                join_types(CHART_STACKABLE_TYPES)
            )));
        }
        if model.axes != ChartAxesMode::Single {
            return Err(SlidraError::invalid("stacked chart must be axes=single"));
        }
    }

    if (model.chart_type == ChartType::Pie || model.chart_type == ChartType::Donut)
        && model.axes != ChartAxesMode::Single
    {
        return Err(SlidraError::invalid(format!(
            "type={} must be axes=single",
            model.chart_type.as_str()
        )));
    }

    Ok(())
}

/// Locates a chart's container `<g>` by id — `require_chart_container`'s
/// chart-specific counterpart in `element-edit.ts`. See this module's doc
/// comment for why this takes pre-scanned `roots` rather than raw
/// `svgContent` like the TS original.
pub fn require_chart_container<'a>(
    roots: &'a [ScannedNode],
    element_id: &str,
) -> SlidraResult<&'a ScannedNode> {
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))?;
    let found = find_chart_container(svg_root, element_id)
        .ok_or_else(|| SlidraError::invalid(format!("element not found: {element_id}")))?;
    if attribute_value(found, "data-slidra-type").as_deref() != Some(CHART_CONTAINER_TYPE) {
        return Err(SlidraError::invalid(format!(
            "element {element_id} is not a chart"
        )));
    }
    Ok(found)
}

fn find_chart_container<'a>(parent: &'a ScannedNode, id: &str) -> Option<&'a ScannedNode> {
    for child in &parent.children {
        if child.tag != "g" {
            continue;
        }
        if attribute_value(child, "id").as_deref() == Some(id) {
            return Some(child);
        }
        if let Some(found) = find_chart_container(child, id) {
            return Some(found);
        }
    }
    None
}

fn require_data_node<'a>(
    container: &'a ScannedNode,
    element_id: &str,
) -> SlidraResult<&'a ScannedNode> {
    container
        .children
        .iter()
        .find(|child| child.tag == "slidra:chart")
        .ok_or_else(|| {
            SlidraError::invalid(format!("element {element_id} is missing <slidra:chart>"))
        })
}

fn read_number_attr(node: &ScannedNode, name: &str, element_id: &str) -> SlidraResult<f64> {
    let raw = attribute_of(node, name).ok_or_else(|| {
        SlidraError::invalid(format!(
            "element {element_id}\'s <slidra:chart> is missing attribute: {name}"
        ))
    })?;
    let value = crate::argv::parse_js_number(&raw.value).unwrap_or(f64::NAN);
    if !value.is_finite() {
        return Err(SlidraError::invalid(format!(
            "element {element_id}\'s <slidra:chart> attribute {name} is not a finite number: {}",
            raw.value
        )));
    }
    Ok(value)
}

fn read_required_attr(node: &ScannedNode, name: &str, element_id: &str) -> SlidraResult<String> {
    attribute_of(node, name)
        .map(|attribute| attribute.value.clone())
        .ok_or_else(|| {
            SlidraError::invalid(format!(
                "element {element_id}\'s <slidra:chart> is missing attribute: {name}"
            ))
        })
}

fn parse_values(raw: &str, element_id: &str, series_name: &str) -> SlidraResult<Vec<f64>> {
    raw.split(',')
        .enumerate()
        .map(|(index, token)| {
            let value = crate::argv::parse_js_number(token).unwrap_or(f64::NAN);
            if token.trim().is_empty() || !value.is_finite() {
                return Err(SlidraError::invalid(format!(
                    "element {element_id}\'s series \"{series_name}\" value #{} is not a finite number: {token}",
                    index + 1
                )));
            }
            Ok(value)
        })
        .collect()
}

/// Reads `element_id`'s `<slidra:chart>` back into a `ChartModel`.
/// Structural legality (exactly one `<slidra:chart>` and one `<svg>`) was
/// already checked by `assert_slide_compliant` — this only reads content.
/// Tolerates `axes="single"` documents where a stray series still carries
/// `axis="right"` (a hand-edited or pre-migration file, plan §4.4 "legal but
/// odd") by rendering that series against the left axis; it does not
/// tolerate anything `validate_chart_model` would reject for a FRESH write
/// (missing attributes, non-finite numbers, count mismatches).
pub fn read_chart_model(svg_content: &str, element_id: &str) -> SlidraResult<ChartModel> {
    let roots = scan_document(svg_content)?;
    let container = require_chart_container(&roots, element_id)?;
    let chart_node = require_data_node(container, element_id)?;

    let chart_type = require_enum(
        &read_required_attr(chart_node, "type", element_id)?,
        ChartType::VALUES,
        "type",
    )?;
    let stacked_raw = read_required_attr(chart_node, "stacked", element_id)?;
    let stacked = match stacked_raw.as_str() {
        "true" => true,
        "false" => false,
        _ => {
            return Err(SlidraError::invalid(format!(
                "element {element_id}\'s stacked must be true or false: {stacked_raw}"
            )));
        }
    };
    let axes_raw = read_required_attr(chart_node, "axes", element_id)?;
    let axes = ChartAxesMode::parse(&axes_raw).ok_or_else(|| {
        SlidraError::invalid(format!(
            "axes must be one of the following: single, dual (received: {axes_raw})"
        ))
    })?;
    let palette = require_enum(
        &read_required_attr(chart_node, "palette", element_id)?,
        ChartPalette::VALUES,
        "palette",
    )?;
    let legend = require_enum(
        &read_required_attr(chart_node, "legend", element_id)?,
        ChartLegend::VALUES,
        "legend",
    )?;
    let grid_raw = read_required_attr(chart_node, "grid", element_id)?;
    let labels_raw = read_required_attr(chart_node, "labels", element_id)?;
    let grid = match grid_raw.as_str() {
        "true" => true,
        "false" => false,
        _ => {
            return Err(SlidraError::invalid(format!(
                "element {element_id}\'s grid must be true or false: {grid_raw}"
            )));
        }
    };
    let labels = match labels_raw.as_str() {
        "true" => true,
        "false" => false,
        _ => {
            return Err(SlidraError::invalid(format!(
                "element {element_id}\'s labels must be true or false: {labels_raw}"
            )));
        }
    };
    let x_title = attribute_of(chart_node, "x-title")
        .map(|a| a.value.clone())
        .unwrap_or_default();
    let y_title = attribute_of(chart_node, "y-title")
        .map(|a| a.value.clone())
        .unwrap_or_default();
    let width = read_number_attr(chart_node, "width", element_id)?;
    let height = read_number_attr(chart_node, "height", element_id)?;

    let series_nodes: Vec<&ScannedNode> = chart_node
        .children
        .iter()
        .filter(|child| child.tag == "slidra:series")
        .collect();
    let categories_nodes: Vec<&ScannedNode> = chart_node
        .children
        .iter()
        .filter(|child| child.tag == "slidra:categories")
        .collect();
    if series_nodes.is_empty() {
        return Err(SlidraError::invalid(format!(
            "element {element_id}\'s chart has no <slidra:series>"
        )));
    }
    if categories_nodes.len() != 1 {
        return Err(SlidraError::invalid(format!(
            "element {element_id}\'s chart must have exactly one <slidra:categories>"
        )));
    }
    if let Some(other) = chart_node
        .children
        .iter()
        .find(|child| child.tag != "slidra:series" && child.tag != "slidra:categories")
    {
        return Err(SlidraError::invalid(format!(
            "element {element_id}\'s <slidra:chart> contains unknown child element: <{}>",
            other.tag
        )));
    }

    let categories: Vec<String> = read_required_attr(categories_nodes[0], "values", element_id)?
        .split(',')
        .map(|token| token.to_string())
        .collect();
    if categories.iter().any(|category| category.is_empty()) {
        return Err(SlidraError::invalid(format!(
            "element {element_id}\'s category list must not contain empty strings"
        )));
    }

    let mut series = Vec::with_capacity(series_nodes.len());
    for node in &series_nodes {
        let name = read_required_attr(node, "name", element_id)?;
        let values = parse_values(
            &read_required_attr(node, "values", element_id)?,
            element_id,
            &name,
        )?;
        let axis_raw = attribute_of(node, "axis")
            .map(|a| a.value.clone())
            .unwrap_or_else(|| "left".to_string());
        let axis = ChartSeriesAxis::parse(&axis_raw).ok_or_else(|| {
            SlidraError::invalid(format!(
                "series \"{name}\": axis must be one of: left, right (received: {axis_raw})"
            ))
        })?;
        let color = attribute_of(node, "color").map(|a| a.value.clone());
        series.push(ChartSeries {
            name,
            values,
            axis,
            color,
        });
    }

    let model = ChartModel {
        chart_type,
        stacked,
        axes,
        palette,
        legend,
        grid,
        labels,
        x_title,
        y_title,
        width,
        height,
        series,
        categories,
    };

    // Structural read only above; re-validate everything a write would
    // check EXCEPT the strict single-axis-implies-no-right-series rule
    // (plan §4.4 "legal but odd" — a stray legacy axis="right" under
    // axes="single" is tolerated on read, treated as "left" by the
    // renderer, see chart/render.rs).
    let for_validation = if model.axes == ChartAxesMode::Single {
        ChartModel {
            series: model
                .series
                .iter()
                .map(|s| ChartSeries {
                    axis: ChartSeriesAxis::Left,
                    ..s.clone()
                })
                .collect(),
            ..model.clone()
        }
    } else {
        model.clone()
    };
    validate_chart_model(&for_validation)?;

    Ok(model)
}

/// Serializes `model` back into `<slidra:chart>…</slidra:chart>`, attribute
/// order fixed (plan §4.1).
pub fn serialize_chart_data(model: &ChartModel) -> String {
    let attrs = [
        format!("xmlns:slidra=\"{CHART_NS}\""),
        format!("type=\"{}\"", model.chart_type.as_str()),
        format!("stacked=\"{}\"", model.stacked),
        format!("axes=\"{}\"", model.axes.as_str()),
        format!("palette=\"{}\"", model.palette.as_str()),
        format!("legend=\"{}\"", model.legend.as_str()),
        format!("grid=\"{}\"", model.grid),
        format!("labels=\"{}\"", model.labels),
        format!("x-title=\"{}\"", escape_xml_attr(&model.x_title)),
        format!("y-title=\"{}\"", escape_xml_attr(&model.y_title)),
        format!("width=\"{}\"", format_svg_number(model.width)),
        format!("height=\"{}\"", format_svg_number(model.height)),
    ]
    .join(" ");

    let mut series_markup = String::new();
    for series in &model.series {
        let values = series
            .values
            .iter()
            .map(|value| format_svg_number(*value))
            .collect::<Vec<_>>()
            .join(",");
        let color_attr = match &series.color {
            Some(color) => format!(" color=\"{}\"", escape_xml_attr(color)),
            None => String::new(),
        };
        series_markup.push_str(&format!(
            "<slidra:series name=\"{}\" values=\"{}\" axis=\"{}\"{}/>",
            escape_xml_attr(&series.name),
            values,
            series.axis.as_str(),
            color_attr
        ));
    }

    let categories_markup = format!(
        "<slidra:categories values=\"{}\"/>",
        model
            .categories
            .iter()
            .map(|c| escape_xml_attr(c))
            .collect::<Vec<_>>()
            .join(",")
    );

    format!("<slidra:chart {attrs}>{series_markup}{categories_markup}</slidra:chart>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_model() -> ChartModel {
        ChartModel {
            chart_type: ChartType::Bar,
            stacked: false,
            axes: ChartAxesMode::Single,
            palette: ChartPalette::Brand,
            legend: ChartLegend::Bottom,
            grid: true,
            labels: true,
            x_title: String::new(),
            y_title: String::new(),
            width: 100.0,
            height: 100.0,
            series: vec![ChartSeries {
                name: "S1".to_string(),
                values: vec![1.0, 2.0],
                axis: ChartSeriesAxis::Left,
                color: None,
            }],
            categories: vec!["C1".to_string(), "C2".to_string()],
        }
    }

    #[test]
    fn valid_model_passes() {
        validate_chart_model(&valid_model()).unwrap();
    }

    #[test]
    fn width_not_finite_errors() {
        let mut model = valid_model();
        model.width = f64::NAN;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "width must be a finite number greater than 0: NaN"
        );
    }

    #[test]
    fn width_zero_errors() {
        let mut model = valid_model();
        model.width = 0.0;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "width must be a finite number greater than 0: 0"
        );
    }

    #[test]
    fn height_infinite_errors_with_js_infinity_spelling() {
        let mut model = valid_model();
        model.height = f64::INFINITY;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "height must be a finite number greater than 0: Infinity"
        );
    }

    #[test]
    fn categories_below_minimum_errors() {
        let mut model = valid_model();
        model.categories = vec!["only-one".to_string()];
        model.series[0].values = vec![1.0];
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "category count must be between 2 and 60 (received: 1)"
        );
    }

    #[test]
    fn categories_above_maximum_errors() {
        let mut model = valid_model();
        model.categories = (0..61).map(|i| format!("C{i}")).collect();
        model.series[0].values = (0..61).map(|i| i as f64).collect();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "category count must be between 2 and 60 (received: 61)"
        );
    }

    #[test]
    fn empty_category_name_errors() {
        let mut model = valid_model();
        model.categories[0] = String::new();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "category name cannot be an empty string");
    }

    #[test]
    fn category_name_with_comma_errors() {
        let mut model = valid_model();
        model.categories[0] = "Taipei, TW".to_string();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "category name cannot contain a comma (would be misread as a separator): Taipei, TW"
        );
    }

    #[test]
    fn series_below_minimum_errors() {
        let mut model = valid_model();
        model.series = vec![];
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series count must be between 1 and 12 (received: 0)"
        );
    }

    #[test]
    fn series_above_maximum_errors() {
        let mut model = valid_model();
        model.series = (0..13)
            .map(|i| ChartSeries {
                name: format!("S{i}"),
                values: vec![1.0, 2.0],
                axis: ChartSeriesAxis::Left,
                color: None,
            })
            .collect();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series count must be between 1 and 12 (received: 13)"
        );
    }

    #[test]
    fn empty_series_name_errors() {
        let mut model = valid_model();
        model.series[0].name = String::new();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "series name cannot be an empty string");
    }

    #[test]
    fn series_name_with_comma_errors() {
        let mut model = valid_model();
        model.series[0].name = "a,b".to_string();
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "series name cannot contain a comma: a,b");
    }

    #[test]
    fn duplicate_series_name_errors() {
        let mut model = valid_model();
        let mut second = model.series[0].clone();
        second.name = model.series[0].name.clone();
        model.series.push(second);
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "duplicate series name: S1");
    }

    #[test]
    fn series_value_count_mismatch_errors_and_never_pads() {
        let mut model = valid_model();
        model.series[0].values = vec![1.0];
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series \"S1\" value count (1) does not match category count (2)"
        );
    }

    #[test]
    fn series_non_finite_value_errors() {
        let mut model = valid_model();
        model.series[0].values = vec![1.0, f64::NAN];
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series \"S1\": the 2th value is not a finite number: NaN"
        );
    }

    #[test]
    fn axis_right_under_single_axes_errors_on_write() {
        let mut model = valid_model();
        model.series[0].axis = ChartSeriesAxis::Right;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series \"S1\" specifies axis=\"right\", but chart axes is single"
        );
    }

    #[test]
    fn invalid_hex_color_errors() {
        let mut model = valid_model();
        model.series[0].color = Some("blue".to_string());
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series \"S1\" color is not a valid #RGB or #RRGGBB: blue"
        );
    }

    #[test]
    fn three_digit_hex_color_is_valid() {
        let mut model = valid_model();
        model.series[0].color = Some("#abc".to_string());
        validate_chart_model(&model).unwrap();
    }

    #[test]
    fn stacked_on_unsupported_type_errors() {
        let mut model = valid_model();
        model.chart_type = ChartType::Line;
        model.stacked = true;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "type=line does not support stacking, only bar, hbar, area can"
        );
    }

    #[test]
    fn stacked_with_dual_axes_errors() {
        let mut model = valid_model();
        model.stacked = true;
        model.axes = ChartAxesMode::Dual;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "stacked chart must be axes=single");
    }

    #[test]
    fn pie_with_dual_axes_errors() {
        let mut model = valid_model();
        model.chart_type = ChartType::Pie;
        model.axes = ChartAxesMode::Dual;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "type=pie must be axes=single");
    }

    #[test]
    fn donut_with_dual_axes_errors() {
        let mut model = valid_model();
        model.chart_type = ChartType::Donut;
        model.axes = ChartAxesMode::Dual;
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(err.message(), "type=donut must be axes=single");
    }

    #[test]
    fn js_number_display_matches_js_string_semantics() {
        assert_eq!(js_number_display(f64::NAN), "NaN");
        assert_eq!(js_number_display(f64::INFINITY), "Infinity");
        assert_eq!(js_number_display(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number_display(-0.0), "0");
        assert_eq!(js_number_display(0.0), "0");
        assert_eq!(js_number_display(27.5), "27.5");
        assert_eq!(js_number_display(-3.0), "-3");
    }

    #[test]
    fn serialize_chart_data_matches_fixed_attribute_order() {
        let mut model = valid_model();
        model.series[0].color = Some("#fff".to_string());
        let markup = serialize_chart_data(&model);
        assert!(markup.starts_with(&format!(
            "<slidra:chart xmlns:slidra=\"{CHART_NS}\" type=\"bar\" stacked=\"false\" axes=\"single\" palette=\"brand\" legend=\"bottom\" grid=\"true\" labels=\"true\" x-title=\"\" y-title=\"\" width=\"100\" height=\"100\">"
        )));
        assert!(
            markup
                .contains(r##"<slidra:series name="S1" values="1,2" axis="left" color="#fff"/>"##)
        );
        assert!(markup.contains(r#"<slidra:categories values="C1,C2"/>"#));
    }

    #[test]
    fn require_chart_container_reports_missing_element() {
        let svg = r#"<svg viewBox="0 0 10 10"><g id="other" data-slidra-type="chart"/></svg>"#;
        let roots = scan_document(svg).unwrap();
        let err = require_chart_container(&roots, "missing").unwrap_err();
        assert_eq!(err.message(), "element not found: missing");
    }

    #[test]
    fn require_chart_container_reports_non_chart_element() {
        let svg = r#"<svg viewBox="0 0 10 10"><g id="e1"><rect/></g></svg>"#;
        let roots = scan_document(svg).unwrap();
        let err = require_chart_container(&roots, "e1").unwrap_err();
        assert_eq!(err.message(), "element e1 is not a chart");
    }

    #[test]
    fn read_chart_model_round_trips_serialize_output() {
        let model = valid_model();
        let markup = serialize_chart_data(&model);
        let svg = format!(
            r#"<svg viewBox="0 0 100 100"><g id="e1" data-slidra-type="chart">{markup}<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/></g></svg>"#
        );
        let read_back = read_chart_model(&svg, "e1").unwrap();
        assert_eq!(read_back, model);
    }

    #[test]
    fn read_chart_model_tolerates_legacy_right_axis_under_single_axes() {
        // Hand-crafted, not something `serialize_chart_data` would ever
        // produce for axes="single" — simulates a pre-migration file
        // (plan §4.4 "legal but odd").
        let svg = format!(
            r#"<svg viewBox="0 0 100 100"><g id="e1" data-slidra-type="chart"><slidra:chart xmlns:slidra="{CHART_NS}" type="bar" stacked="false" axes="single" palette="brand" legend="bottom" grid="true" labels="true" x-title="" y-title="" width="100" height="100"><slidra:series name="S1" values="1,2" axis="right"/><slidra:categories values="C1,C2"/></slidra:chart><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/></g></svg>"#
        );
        let model = read_chart_model(&svg, "e1").unwrap();
        // The stored value is tolerated verbatim...
        assert_eq!(model.series[0].axis, ChartSeriesAxis::Right);
        // ...even though `validate_chart_model` on a literal copy of this
        // model (as a WRITE would) rejects it outright.
        let err = validate_chart_model(&model).unwrap_err();
        assert_eq!(
            err.message(),
            "series \"S1\" specifies axis=\"right\", but chart axes is single"
        );
    }
}
