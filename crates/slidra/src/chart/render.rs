// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `render_chart_svg(model) -> String`: the ONE place a chart's pixels get
//! computed, ported from `packages/core/src/chart/render.ts` (311 lines).
//! Geometry is carried over from the prototype's `chartSvg`, extended with
//! the dual-axis and stacked modes the prototype never had.
//!
//! Three hard rules the output must never break (plan §4.1), all inherited
//! unchanged from the TS original:
//!   1. no `id` attribute anywhere;
//!   2. no `<style>`, class, `<defs>`, gradients, SMIL or CSS animation —
//!      every visual property is a presentation ATTRIBUTE;
//!   3. every SVG coordinate/size goes through `format_svg_number`.

use crate::chart::model::{
    ChartAxesMode, ChartModel, ChartPalette, ChartSeries, ChartSeriesAxis, ChartType,
};
use crate::svgnum::{format_js_number, format_svg_number};
use crate::text::DEFAULT_FONT_FAMILY;
use crate::text::escape_xml_text;

/// The six hex swatches per palette — MUST stay byte-for-byte identical to
/// `apps/web/src/styles/tokens.css`'s `--accent-palette-{brand,cool,warm}-{1..6}`.
/// See `chart/render.ts`'s identical constant for the full provenance note;
/// not re-derived here to avoid drifting from the TS source of truth.
pub const CHART_PALETTE_HEX_BRAND: [&str; 6] = [
    "#C8233B", "#5B6DEA", "#4A8F45", "#E08A2E", "#2B9E75", "#A9B0B8",
];
pub const CHART_PALETTE_HEX_COOL: [&str; 6] = [
    "#5B6DEA", "#2B9E75", "#38BDF8", "#A78BFA", "#22C55E", "#94A3B8",
];
pub const CHART_PALETTE_HEX_WARM: [&str; 6] = [
    "#C8233B", "#E08A2E", "#F4C542", "#D9634C", "#B45309", "#A9B0B8",
];

pub fn chart_palette_hex(palette: ChartPalette) -> [&'static str; 6] {
    match palette {
        ChartPalette::Brand => CHART_PALETTE_HEX_BRAND,
        ChartPalette::Cool => CHART_PALETTE_HEX_COOL,
        ChartPalette::Warm => CHART_PALETTE_HEX_WARM,
    }
}

const MUTED: &str = "#a9b0b8";
const INK: &str = "#e7e9ee";
const GRID_COLOR: &str = "rgba(255,255,255,.35)";
const ZERO_LINE_COLOR: &str = "rgba(255,255,255,.5)";

fn n(value: f64) -> String {
    format_svg_number(value)
}

fn esc(text: &str) -> String {
    escape_xml_text(text)
}

/// Ports `value.toFixed(digits)` as the STRING `toFixed` itself produces
/// (NOT re-parsed through `Number(...)` — `tickLabel` interpolates the
/// `toFixed` string directly, unlike `format_svg_number`'s `toFixed(4)` +
/// re-parse pipeline). Rust's `{:.digits}` formatting is, like `toFixed`, a
/// correctly-rounded decimal expansion of the exact binary64 value for the
/// overwhelming majority of inputs; the two are only known to diverge at a
/// genuine exact tie in the value's true binary representation, where JS
/// resolves toward +infinity and Rust resolves round-half-to-even — see
/// `crate::svgnum`'s `js_to_fixed_4` for the identical reasoning, applied
/// there to a fixed 4 digits instead of a caller-supplied count.
///
/// KNOWN GAP (flagged, not silently assumed away, matching this crate's
/// convention): unverified against a real JS engine in this sandbox (none
/// available) for this exact tie case; every chart golden fixture this
/// ticket adds must avoid landing on one.
fn js_to_fixed(value: f64, digits: usize) -> String {
    format!("{value:.digits$}")
}

/// `Math.round`, ported as `(x + 0.5).floor()` per ECMA-262 (`Math.round`
/// breaks ties toward +infinity, unlike Rust's `f64::round()`, which breaks
/// ties away from zero — `Math.round(-2.5) === -2`, `(-2.5_f64).round() ==
/// -3.0`). `pub(crate)` (not private) because `chart::edit`'s `chart create`
/// sample-value formula (`Math.round(30 + 60*|sin(...)|)`, plan §4.2) needs
/// the exact same semantics — one implementation, not two copies that could
/// drift.
pub(crate) fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn tick_label(value: f64) -> String {
    if value.abs() >= 1000.0 {
        format!("{}k", js_to_fixed(value / 1000.0, 1))
    } else {
        format_js_number(round_half_up(value))
    }
}

struct ResolvedSeries<'a> {
    series: &'a ChartSeries,
    color: String,
}

impl ResolvedSeries<'_> {
    fn name(&self) -> &str {
        &self.series.name
    }
    fn values(&self) -> &[f64] {
        &self.series.values
    }
    fn axis(&self) -> ChartSeriesAxis {
        self.series.axis
    }
}

struct Domain {
    min: f64,
    max: f64,
    span: f64,
}

fn domain_of(list: &[&ResolvedSeries<'_>], stacked: bool) -> Domain {
    if list.is_empty() {
        return Domain {
            min: 0.0,
            max: 1.0,
            span: 1.0,
        };
    }
    if stacked {
        let count = list[0].values().len();
        let mut max = 0.0_f64;
        let mut min = 0.0_f64;
        for i in 0..count {
            let mut pos = 0.0_f64;
            let mut neg = 0.0_f64;
            for series in list {
                let value = series.values().get(i).copied().unwrap_or(0.0);
                if value >= 0.0 {
                    pos += value;
                } else {
                    neg += value;
                }
            }
            max = max.max(pos);
            min = min.min(neg);
        }
        max = max.max(1.0);
        let span = if max - min == 0.0 { 1.0 } else { max - min };
        return Domain { min, max, span };
    }
    let mut min = 0.0_f64;
    let mut max = 1.0_f64;
    for series in list {
        for &value in series.values() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    let span = if max - min == 0.0 { 1.0 } else { max - min };
    Domain { min, max, span }
}

struct LegendItem {
    label: String,
    color: String,
}

pub fn render_chart_svg(model: &ChartModel) -> String {
    let w = model.width;
    let h = model.height;
    let palette = chart_palette_hex(model.palette);
    let cats = &model.categories;
    let count = cats.len();
    let series: Vec<ResolvedSeries<'_>> = model
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ResolvedSeries {
            series: s,
            color: s
                .color
                .clone()
                .unwrap_or_else(|| palette[i % palette.len()].to_string()),
        })
        .collect();

    let legend_bottom_height = if model.legend == crate::chart::model::ChartLegend::Bottom {
        26.0
    } else {
        0.0
    };
    let legend_right_width = if model.legend == crate::chart::model::ChartLegend::Right {
        118.0
    } else {
        0.0
    };
    let has_right_axis = model.axes == ChartAxesMode::Dual;
    let pad_l = if !model.y_title.is_empty() {
        60.0
    } else {
        44.0
    };
    let pad_r = (if has_right_axis { 44.0 } else { 14.0 }) + legend_right_width;
    let pad_b = (if !model.x_title.is_empty() {
        42.0
    } else {
        26.0
    }) + legend_bottom_height;
    let pad_t = 14.0_f64;
    let pw = w - pad_l - pad_r;
    let ph = h - pad_t - pad_b;

    let is_pie = model.chart_type == ChartType::Pie || model.chart_type == ChartType::Donut;
    let legend_items: Vec<LegendItem> = if is_pie {
        cats.iter()
            .enumerate()
            .map(|(i, label)| LegendItem {
                label: label.clone(),
                color: palette[i % palette.len()].to_string(),
            })
            .collect()
    } else {
        series
            .iter()
            .map(|s| LegendItem {
                label: s.name().to_string(),
                color: s.color.clone(),
            })
            .collect()
    };

    let legend_markup = || -> String {
        if model.legend == crate::chart::model::ChartLegend::None {
            return String::new();
        }
        let mut g = String::new();
        if model.legend == crate::chart::model::ChartLegend::Bottom {
            let mut x = pad_l;
            for item in &legend_items {
                g.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"10\" height=\"10\" rx=\"2\" fill=\"{}\"/><text x=\"{}\" y=\"{}\" font-size=\"10\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                    n(x), n(h - 16.0), item.color, n(x + 14.0), n(h - 7.5), esc(&item.label)
                ));
                x += 14.0 + item.label.chars().count() as f64 * 6.2 + 16.0;
            }
        } else {
            for (i, item) in legend_items.iter().enumerate() {
                let y = pad_t + 6.0 + i as f64 * 18.0;
                g.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"10\" height=\"10\" rx=\"2\" fill=\"{}\"/><text x=\"{}\" y=\"{}\" font-size=\"10\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                    n(w - legend_right_width + 8.0), n(y), item.color, n(w - legend_right_width + 22.0), n(y + 8.5), esc(&item.label)
                ));
            }
        }
        g
    };

    let titles_markup = || -> String {
        let mut g = String::new();
        if !model.x_title.is_empty() {
            g.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"10\" font-weight=\"700\" text-anchor=\"middle\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(pad_l + pw / 2.0), n(h - legend_bottom_height - 6.0), esc(&model.x_title.to_uppercase())
            ));
        }
        if !model.y_title.is_empty() {
            g.push_str(&format!(
                "<text transform=\"translate({} {}) rotate(-90)\" font-size=\"10\" font-weight=\"700\" text-anchor=\"middle\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(12.0), n(pad_t + ph / 2.0), esc(&model.y_title.to_uppercase())
            ));
        }
        g
    };

    let hit_area = format!(
        "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"transparent\"/>",
        n(w),
        n(h)
    );
    let wrap = |body: String| -> String {
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\">{hit_area}{body}</svg>",
            n(w),
            n(h),
            n(w),
            n(h)
        )
    };

    if is_pie {
        let mut body = String::new();
        let values: &[f64] = series.first().map(|s| s.values()).unwrap_or(&[]);
        let raw_total: f64 = values.iter().sum();
        let total = if raw_total == 0.0 { 1.0 } else { raw_total };
        let cx = pad_l + pw / 2.0;
        let cy = pad_t + ph / 2.0;
        let r = pw.min(ph) / 2.0 - 6.0;
        let ri = if model.chart_type == ChartType::Donut {
            r * 0.55
        } else {
            0.0
        };
        let mut angle = -std::f64::consts::FRAC_PI_2;
        for (i, &value) in values.iter().enumerate() {
            let next_angle = angle + (value / total) * std::f64::consts::PI * 2.0;
            let large = if next_angle - angle > std::f64::consts::PI {
                1
            } else {
                0
            };
            let point = |a: f64, radius: f64| {
                format!("{} {}", n(cx + radius * a.cos()), n(cy + radius * a.sin()))
            };
            let d = if ri != 0.0 {
                format!(
                    "M{} A{} {} 0 {large} 1 {} L{} A{} {} 0 {large} 0 {} Z",
                    point(angle, r),
                    n(r),
                    n(r),
                    point(next_angle, r),
                    point(next_angle, ri),
                    n(ri),
                    n(ri),
                    point(angle, ri)
                )
            } else {
                format!(
                    "M{} {} L{} A{} {} 0 {large} 1 {} Z",
                    n(cx),
                    n(cy),
                    point(angle, r),
                    n(r),
                    n(r),
                    point(next_angle, r)
                )
            };
            body.push_str(&format!(
                "<path d=\"{d}\" fill=\"{}\"/>",
                palette[i % palette.len()]
            ));
            if model.labels && value / total > 0.04 {
                let mid = (angle + next_angle) / 2.0;
                let r_mid = if ri != 0.0 { (r + ri) / 2.0 } else { r * 0.65 };
                body.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"10\" font-weight=\"700\" text-anchor=\"middle\" fill=\"#fff\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}%</text>",
                    n(cx + r_mid * mid.cos()), n(cy + r_mid * mid.sin() + 3.5), format_js_number(round_half_up((value / total) * 100.0))
                ));
            }
            angle = next_angle;
        }
        if ri != 0.0 {
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"14\" font-weight=\"800\" text-anchor=\"middle\" fill=\"{INK}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(cx), n(cy + 5.0), n(total)
            ));
        }
        return wrap(body + &legend_markup());
    }

    let horiz = model.chart_type == ChartType::Hbar;
    let left_series: Vec<&ResolvedSeries<'_>> = series
        .iter()
        .filter(|s| !(has_right_axis && s.axis() == ChartSeriesAxis::Right))
        .collect();
    let right_series: Vec<&ResolvedSeries<'_>> = if has_right_axis {
        series
            .iter()
            .filter(|s| s.axis() == ChartSeriesAxis::Right)
            .collect()
    } else {
        Vec::new()
    };
    let left_domain = domain_of(&left_series, model.stacked);
    let right_domain = if has_right_axis {
        domain_of(&right_series, false)
    } else {
        Domain {
            min: left_domain.min,
            max: left_domain.max,
            span: left_domain.span,
        }
    };

    let gw = (if horiz { ph } else { pw }) / count as f64;
    let x_of = |i: usize| pad_l + (i as f64 + 0.5) * gw;
    let yc_of = |i: usize| pad_t + (i as f64 + 0.5) * gw;
    let y_of = |domain: &Domain, v: f64| pad_t + ph - ((v - domain.min) / domain.span) * ph;
    let xv_of = |domain: &Domain, v: f64| pad_l + ((v - domain.min) / domain.span) * pw;

    let y_for = |s: &ResolvedSeries<'_>, v: f64| -> f64 {
        if has_right_axis && s.axis() == ChartSeriesAxis::Right {
            y_of(&right_domain, v)
        } else {
            y_of(&left_domain, v)
        }
    };
    let xv_for = |s: &ResolvedSeries<'_>, v: f64| -> f64 {
        if has_right_axis && s.axis() == ChartSeriesAxis::Right {
            xv_of(&right_domain, v)
        } else {
            xv_of(&left_domain, v)
        }
    };

    let mut body = String::new();
    let ticks = 4;
    for t in 0..=ticks {
        let v = left_domain.min + (left_domain.span * t as f64) / ticks as f64;
        if horiz {
            let x = xv_of(&left_domain, v);
            if model.grid {
                body.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{GRID_COLOR}\" stroke-dasharray=\"3 4\"/>",
                    n(x), n(pad_t), n(x), n(pad_t + ph)
                ));
            }
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" text-anchor=\"middle\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(x), n(pad_t + ph + 14.0), esc(&tick_label(v))
            ));
        } else {
            let y = y_of(&left_domain, v);
            if model.grid {
                body.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{GRID_COLOR}\" stroke-dasharray=\"3 4\"/>",
                    n(pad_l), n(y), n(pad_l + pw), n(y)
                ));
            }
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" text-anchor=\"end\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(pad_l - 8.0), n(y + 3.5), esc(&tick_label(v))
            ));
        }
    }
    if has_right_axis {
        for t in 0..=ticks {
            let v = right_domain.min + (right_domain.span * t as f64) / ticks as f64;
            if horiz {
                let x = xv_of(&right_domain, v);
                body.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" text-anchor=\"middle\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                    n(x), n(pad_t - 4.0), esc(&tick_label(v))
                ));
            } else {
                let y = y_of(&right_domain, v);
                body.push_str(&format!(
                    "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" text-anchor=\"start\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                    n(pad_l + pw + 8.0), n(y + 3.5), esc(&tick_label(v))
                ));
            }
        }
    }

    if horiz {
        body.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{ZERO_LINE_COLOR}\"/>",
            n(pad_l),
            n(pad_t),
            n(pad_l),
            n(pad_t + ph)
        ));
    } else {
        let y0 = y_of(&left_domain, 0.0);
        body.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{ZERO_LINE_COLOR}\"/>",
            n(pad_l),
            n(y0),
            n(pad_l + pw),
            n(y0)
        ));
    }

    for (i, c) in cats.iter().enumerate() {
        if horiz {
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"10\" text-anchor=\"end\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(pad_l - 8.0), n(yc_of(i) + 3.5), esc(c)
            ));
        } else {
            body.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"10\" text-anchor=\"middle\" fill=\"{MUTED}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                n(x_of(i)), n(pad_t + ph + 14.0), esc(c)
            ));
        }
    }

    if model.stacked && (model.chart_type == ChartType::Bar || model.chart_type == ChartType::Hbar)
    {
        let bar_width = gw * 0.6;
        let mut pos_acc = vec![0.0_f64; count];
        let mut neg_acc = vec![0.0_f64; count];
        for s in &series {
            for i in 0..count {
                let value = s.values()[i];
                let stack_bottom = if value >= 0.0 { pos_acc[i] } else { neg_acc[i] };
                let stack_top = stack_bottom + value;
                if horiz {
                    let x0 = xv_of(&left_domain, stack_bottom.min(stack_top));
                    let x1 = xv_of(&left_domain, stack_bottom.max(stack_top));
                    let y = yc_of(i) - bar_width / 2.0;
                    body.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\"/>",
                        n(x0),
                        n(y),
                        n(x1 - x0),
                        n(bar_width),
                        s.color
                    ));
                } else {
                    let y0 = y_of(&left_domain, stack_bottom.max(stack_top));
                    let y1 = y_of(&left_domain, stack_bottom.min(stack_top));
                    let x = x_of(i) - bar_width / 2.0;
                    body.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\"/>",
                        n(x),
                        n(y0),
                        n(bar_width),
                        n(y1 - y0),
                        s.color
                    ));
                }
                if value >= 0.0 {
                    pos_acc[i] = stack_top;
                } else {
                    neg_acc[i] = stack_top;
                }
            }
        }
    } else if model.chart_type == ChartType::Bar || horiz {
        let bar_width = (gw * 0.68) / series.len() as f64;
        for (si, s) in series.iter().enumerate() {
            for i in 0..count {
                let value = s.values()[i];
                if horiz {
                    let top = yc_of(i) - gw * 0.34 + si as f64 * bar_width;
                    let x0 = xv_for(s, 0.0_f64.min(value));
                    let width = (xv_for(s, value) - xv_for(s, 0.0)).abs();
                    body.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"2\" fill=\"{}\"/>",
                        n(x0),
                        n(top),
                        n(width),
                        n(bar_width - 2.0),
                        s.color
                    ));
                    if model.labels {
                        body.push_str(&format!(
                            "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" font-weight=\"700\" fill=\"{INK}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                            n(xv_for(s, value) + 5.0), n(top + bar_width / 2.0 + 2.5), esc(&format_js_number(value))
                        ));
                    }
                } else {
                    let left = x_of(i) - gw * 0.34 + si as f64 * bar_width;
                    let top = y_for(s, 0.0_f64.max(value));
                    let height = (y_for(s, value) - y_for(s, 0.0)).abs();
                    body.push_str(&format!(
                        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"2\" fill=\"{}\"/>",
                        n(left),
                        n(top),
                        n(bar_width - 2.0),
                        n(height),
                        s.color
                    ));
                    if model.labels {
                        body.push_str(&format!(
                            "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" font-weight=\"700\" text-anchor=\"middle\" fill=\"{INK}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                            n(left + (bar_width - 2.0) / 2.0), n(top - 5.0), esc(&format_js_number(value))
                        ));
                    }
                }
            }
        }
    } else {
        for s in &series {
            let points: Vec<(f64, f64)> = (0..count)
                .map(|i| (x_of(i), y_for(s, s.values()[i])))
                .collect();
            let line = points
                .iter()
                .map(|(px, py)| format!("{},{}", n(*px), n(*py)))
                .collect::<Vec<_>>()
                .join(" ");
            if model.chart_type == ChartType::Area {
                let first_point = format!("{},{}", n(x_of(0)), n(y_for(s, 0.0)));
                body.push_str(&format!(
                    "<polygon points=\"{first_point} {line} {},{}\" fill=\"{}\" fill-opacity=\".22\"/>",
                    n(x_of(count - 1)),
                    n(y_for(s, 0.0)),
                    s.color
                ));
            }
            body.push_str(&format!(
                "<polyline points=\"{line}\" fill=\"none\" stroke=\"{}\" stroke-width=\"2.5\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>",
                s.color
            ));
            for (i, (px, py)) in points.iter().enumerate() {
                body.push_str(&format!(
                    "<circle cx=\"{}\" cy=\"{}\" r=\"3.5\" fill=\"{}\"/>",
                    n(*px),
                    n(*py),
                    s.color
                ));
                if model.labels {
                    body.push_str(&format!(
                        "<text x=\"{}\" y=\"{}\" font-size=\"9.5\" font-weight=\"700\" text-anchor=\"middle\" fill=\"{INK}\" font-family=\"{DEFAULT_FONT_FAMILY}\">{}</text>",
                        n(*px), n(py - 9.0), esc(&format_js_number(s.values()[i]))
                    ));
                }
            }
        }
    }

    wrap(body + &titles_markup() + &legend_markup())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::model::{
        ChartAxesMode, ChartLegend, ChartPalette, ChartSeriesAxis, ChartType,
    };

    fn bar_model() -> ChartModel {
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
            width: 400.0,
            height: 300.0,
            series: vec![ChartSeries {
                name: "S1".to_string(),
                values: vec![10.0, 20.0, 30.0],
                axis: ChartSeriesAxis::Left,
                color: None,
            }],
            categories: vec!["C1".to_string(), "C2".to_string(), "C3".to_string()],
        }
    }

    #[test]
    fn output_starts_with_a_full_viewport_hit_rect_and_no_id_attribute() {
        let svg = render_chart_svg(&bar_model());
        assert!(svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect x="0" y="0" width="400" height="300" fill="transparent"/>"#));
        assert!(!svg.contains(" id=\""));
        assert!(!svg.contains("<style"));
        assert!(!svg.contains("<defs"));
    }

    #[test]
    fn tick_label_switches_to_k_suffix_at_1000() {
        assert_eq!(tick_label(999.0), "999");
        assert_eq!(tick_label(1000.0), "1.0k");
        assert_eq!(tick_label(-2500.0), "-2.5k");
    }

    #[test]
    fn round_half_up_breaks_ties_toward_positive_infinity() {
        assert_eq!(round_half_up(2.5), 3.0);
        assert_eq!(round_half_up(-2.5), -2.0);
    }

    #[test]
    fn pie_chart_renders_paths_not_bars() {
        let mut model = bar_model();
        model.chart_type = crate::chart::model::ChartType::Pie;
        model.axes = ChartAxesMode::Single;
        let svg = render_chart_svg(&model);
        assert!(svg.contains("<path d="));
        assert!(!svg.contains(
            "<rect x=\"0\" y=\"0\" width=\"400\" height=\"300\" fill=\"transparent\"/><rect x=\"44"
        ));
    }

    #[test]
    fn donut_chart_renders_a_center_total_label() {
        let mut model = bar_model();
        model.chart_type = crate::chart::model::ChartType::Donut;
        let svg = render_chart_svg(&model);
        assert!(svg.contains("60</text>")); // 10+20+30 total, via format_svg_number
    }

    #[test]
    fn labels_use_format_js_number_not_format_svg_number() {
        let mut model = bar_model();
        model.series[0].values = vec![10.5, 20.0, 30.0];
        let svg = render_chart_svg(&model);
        assert!(svg.contains(">10.5<"));
    }
}
