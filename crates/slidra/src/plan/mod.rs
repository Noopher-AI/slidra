// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `plan/` — the presentation's own plan files (#303, ADR-0018):
//! `plan/outline.md` (page roster, mode, gate questions, status) and
//! `plan/design-spec.md` (density, palette, type scale). Each file opens
//! with one ```` ```json ```` fence — the machine-readable part this module
//! parses and validates — followed by free markdown for people and agents.
//!
//! Plan files are not slide content: writing/deleting them never touches
//! the undo history (unlike every `slides/`/`templates/` write).

use crate::errors::{SlidraError, SlidraResult};
use crate::workspace::{self, virtual_fs};
use serde_json::Value;
use std::path::Path;

pub const OUTLINE_PATH: &str = "plan/outline.md";
pub const DESIGN_SPEC_PATH: &str = "plan/design-spec.md";

pub const MODES: &[&str] = &[
    "pyramid",
    "narrative",
    "instructional",
    "showcase",
    "briefing",
];
pub const PAGE_TYPES: &[&str] = &[
    "cover", "section", "bullets", "compare", "number", "closing",
];
pub const RHYTHMS: &[&str] = &["anchor", "dense", "breathing"];
/// The relationship a page's content has (#303 §D), borrowed from
/// ppt-master's relationship atoms. It is what the composition has to
/// carry — named in the plan so the page's geometry answers to something
/// stated, not to the build's memory.
pub const RELATIONSHIPS: &[&str] = &[
    "order",
    "link",
    "parent",
    "membership",
    "contrast",
    "overlap",
    "none",
];
pub const DENSITIES: &[&str] = &["presentation", "balanced", "text"];
pub const ANIMATIONS: &[&str] = &["full", "minimal", "none"];
pub const BACKGROUNDS: &[&str] = &["on", "off"];
pub const VISUALS: &[&str] = &["editorial-tech"];
/// How the deck's shapes behave — corner radius, decoration density,
/// whitespace rhythm, texture (#303). Borrowed from ppt-master's separation
/// of *visual style* from *palette*: the shape language carries no colour,
/// so any of it pairs with any palette. Absent reads as `plain`.
pub const SHAPE_LANGUAGES: &[&str] = &[
    "plain",
    "swiss-minimal",
    "soft-rounded",
    "glass",
    "paper-cut",
    "ink-wash",
    "chalkboard",
    "sketch-notes",
    "brutalist",
    "data-dense",
];
pub const PALETTE_ROLES: &[&str] = &[
    "background",
    "secondary_bg",
    "primary",
    "accent",
    "secondary_accent",
    "text",
    "muted",
];
pub const TYPE_ROLES: &[&str] = &[
    "cover", "section", "number", "claim", "title", "subtitle", "body", "column", "caption",
];

/// `template add --name` for each page type (contract §5).
pub fn template_name_for(page_type: &str) -> &'static str {
    match page_type {
        "cover" => "cover",
        "section" => "section page",
        "bullets" => "bullet point page",
        "compare" => "comparison page",
        "number" => "big-number page",
        "closing" => "closing page",
        _ => "",
    }
}

/// What the build decided in its composition-reasoning step, written down
/// so it can be reconciled against the page it then drew. Without this the
/// step is a private thought and nothing can tell whether the page kept it.
#[derive(Debug, Clone, PartialEq)]
pub struct PageBlueprint {
    /// A short name for the composition actually chosen — e.g.
    /// `card-wall`, `shared-field`, `split-panel`. Free text: it exists so
    /// two adjacent pages that solved the same relationship the same way
    /// can be spotted, not to be validated against a catalogue.
    pub shape: String,
    /// How many semantic units the page carries — reconciled against the
    /// elements that declare `data-slidra-role="node"`.
    pub nodes: usize,
    /// How many click steps the page is told in — reconciled against the
    /// page's `on-click` enter effects.
    pub steps: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanPage {
    pub n: usize,
    /// What this page's content IS — one of `RELATIONSHIPS`. Required: the
    /// geometry has to carry it.
    pub relationship: String,
    /// A known solution's name, when one fits. Absent means the
    /// page composes its own answer to `relationship`.
    pub page_type: Option<String>,
    pub rhythm: String,
    pub title: String,
    /// Absent until the build's composition-reasoning step writes it.
    pub blueprint: Option<PageBlueprint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutlinePlan {
    pub status: String,
    pub mode: String,
    /// `full` | `minimal` | `none` (contract §9); absent reads as `full`.
    pub animation: String,
    /// `on` | `off` (contract §13); absent reads as `on`.
    pub background: String,
    pub pages: Vec<PlanPage>,
    pub question_count: usize,
}

/// The deck-wide layout anchors (#303 §C). Coordinates are the page's own
/// business — these are what every page must nonetheless agree on, so
/// freeing composition does not also free consistency. `validate` enforces
/// the three margins; `gutter` and `spacing` are the rhythm the build reads
/// when it places things, and are declared here so the whole deck draws
/// from one set of steps rather than inventing gaps per page.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutAnchors {
    pub side_margin: f64,
    pub bottom_margin: f64,
    pub footer_margin: f64,
    pub gutter: f64,
    pub spacing: Vec<f64>,
}

impl Default for LayoutAnchors {
    /// The values the six page-type samples were drawn with, so a spec
    /// written before this block reads exactly as it always did.
    fn default() -> Self {
        Self {
            side_margin: 80.0,
            bottom_margin: 72.0,
            footer_margin: 16.0,
            gutter: 24.0,
            spacing: vec![8.0, 16.0, 24.0, 40.0, 64.0],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesignSpec {
    pub density: String,
    /// Visual language name (contract §9); absent reads as `editorial-tech`.
    pub visual: String,
    /// Role -> uppercase `#RRGGBB`, in `PALETTE_ROLES` order.
    pub palette: Vec<(String, String)>,
    /// Role -> size, in `TYPE_ROLES` order.
    pub type_scale: Vec<(String, f64)>,
    /// Deck-wide layout anchors; absent reads as `LayoutAnchors::default()`.
    pub layout: LayoutAnchors,
    /// One of `SHAPE_LANGUAGES`; absent reads as `plain` (#303).
    pub shape_language: String,
}

impl DesignSpec {
    pub fn color(&self, role: &str) -> &str {
        self.palette
            .iter()
            .find(|(r, _)| r == role)
            .map(|(_, c)| c.as_str())
            .expect("validated palette has every role")
    }
    pub fn size(&self, role: &str) -> f64 {
        self.type_scale
            .iter()
            .find(|(r, _)| r == role)
            .map(|(_, s)| *s)
            .expect("validated type scale has every role")
    }
}

/// Extracts the JSON inside the leading ```` ```json ```` fence. The fence
/// must be the first non-blank content of the file.
pub fn extract_json_fence(text: &str) -> SlidraResult<Value> {
    let trimmed = text.trim_start_matches(['\u{FEFF}', ' ', '\t', '\r', '\n']);
    let Some(rest) = trimmed.strip_prefix("```json") else {
        return Err(SlidraError::invalid(
            "plan file must start with a ```json fence (machine-readable section)",
        ));
    };
    let Some(end) = rest.find("\n```") else {
        return Err(SlidraError::invalid(
            "the ```json fence of the plan file has no closing ```",
        ));
    };
    let body = &rest[..end];
    serde_json::from_str(body).map_err(|err| {
        SlidraError::invalid(format!(
            "the JSON section of the plan file cannot be parsed: {err}"
        ))
    })
}

fn require_object<'a>(
    value: &'a Value,
    what: &str,
) -> SlidraResult<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| SlidraError::invalid(format!("{what} must be a JSON object")))
}

fn require_str<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
    what: &str,
) -> SlidraResult<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| SlidraError::invalid(format!("{what} is missing string field {key}")))
}

fn require_enum(value: &str, allowed: &[&str], what: &str) -> SlidraResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(SlidraError::invalid(format!(
            "{what} has invalid value {value}, must be one of: {}",
            allowed.join(", ")
        )))
    }
}

/// Validates and reads `plan/outline.md`'s JSON section (contract §1).
pub fn parse_outline(text: &str) -> SlidraResult<OutlinePlan> {
    let value = extract_json_fence(text)?;
    let obj = require_object(&value, "outline")?;
    let status = require_str(obj, "status", "outline")?;
    require_enum(status, &["draft", "confirmed"], "outline.status")?;
    let mode = require_str(obj, "mode", "outline")?;
    require_enum(mode, MODES, "outline.mode")?;
    let animation = match obj.get("animation") {
        None => "full",
        Some(value) => {
            let animation = value
                .as_str()
                .ok_or_else(|| SlidraError::invalid("outline.animation must be a string"))?;
            require_enum(animation, ANIMATIONS, "outline.animation")?;
            animation
        }
    };
    let background = match obj.get("background") {
        None => "on",
        Some(value) => {
            let background = value
                .as_str()
                .ok_or_else(|| SlidraError::invalid("outline.background must be a string"))?;
            require_enum(background, BACKGROUNDS, "outline.background")?;
            background
        }
    };

    let pages_value = obj
        .get("pages")
        .and_then(Value::as_array)
        .ok_or_else(|| SlidraError::invalid("outline missing pages array"))?;
    if pages_value.is_empty() {
        return Err(SlidraError::invalid("outline.pages cannot be empty"));
    }
    let mut pages = Vec::with_capacity(pages_value.len());
    for (index, page) in pages_value.iter().enumerate() {
        let what = format!("outline.pages[{index}]");
        let page = require_object(page, &what)?;
        let n = page
            .get("n")
            .and_then(Value::as_u64)
            .ok_or_else(|| SlidraError::invalid(format!("{what} is missing integer field n")))?;
        if n as usize != index + 1 {
            return Err(SlidraError::invalid(format!(
                "{what}.n must be {} (increasing consecutively from 1), actual is {n}",
                index + 1
            )));
        }
        // #303 §A': the relationship is what the composition must carry, so
        // it is the required field. The page TYPE is now optional — a name
        // for a known solution to a relationship, useful when one fits and
        // absent when the page needs its own answer.
        let relationship = require_str(page, "relationship", &what)?;
        require_enum(relationship, RELATIONSHIPS, &format!("{what}.relationship"))?;
        let page_type = match page.get("type") {
            None => None,
            Some(value) => {
                let page_type = value
                    .as_str()
                    .ok_or_else(|| SlidraError::invalid(format!("{what}.type must be a string")))?;
                require_enum(page_type, PAGE_TYPES, &format!("{what}.type"))?;
                Some(page_type.to_string())
            }
        };
        let rhythm = require_str(page, "rhythm", &what)?;
        require_enum(rhythm, RHYTHMS, &format!("{what}.rhythm"))?;
        let title = require_str(page, "title", &what)?;
        let blueprint = parse_blueprint(page, &what)?;
        pages.push(PlanPage {
            n: n as usize,
            relationship: relationship.to_string(),
            page_type,
            rhythm: rhythm.to_string(),
            title: title.to_string(),
            blueprint,
        });
    }

    let mut question_count = 0;
    if let Some(questions) = obj.get("questions") {
        let questions = questions
            .as_array()
            .ok_or_else(|| SlidraError::invalid("outline.questions must be an array"))?;
        let mut seen_ids: Vec<&str> = Vec::new();
        for (index, question) in questions.iter().enumerate() {
            let what = format!("outline.questions[{index}]");
            let question = require_object(question, &what)?;
            let id = require_str(question, "id", &what)?;
            if id.is_empty()
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(SlidraError::invalid(format!(
                    "{what}.id can only contain alphanumerics, - and _: {id}"
                )));
            }
            if seen_ids.contains(&id) {
                return Err(SlidraError::invalid(format!("{what}.id duplicated: {id}")));
            }
            seen_ids.push(id);
            require_str(question, "question", &what)?;
            if let Some(note) = question.get("note") {
                if !note.is_string() {
                    return Err(SlidraError::invalid(format!(
                        "{what}.note must be a string"
                    )));
                }
            }
            let recommended = require_str(question, "recommended", &what)?;
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| SlidraError::invalid(format!("{what} is missing options array")))?;
            if options.len() < 2 || options.len() > 4 {
                return Err(SlidraError::invalid(format!(
                    "{what}.options must have 2 to 4 options, actual {}",
                    options.len()
                )));
            }
            let mut values: Vec<&str> = Vec::new();
            for (option_index, option) in options.iter().enumerate() {
                let option_what = format!("{what}.options[{option_index}]");
                let option = require_object(option, &option_what)?;
                let value = require_str(option, "value", &option_what)?;
                require_str(option, "label", &option_what)?;
                values.push(value);
            }
            if !values.contains(&recommended) {
                return Err(SlidraError::invalid(format!(
                    "{what}.recommended must be one of options\' value: {recommended}"
                )));
            }
            if let Some(free_text) = question.get("free_text") {
                if !free_text.is_boolean() {
                    return Err(SlidraError::invalid(format!(
                        "{what}.free_text must be a boolean"
                    )));
                }
            }
            question_count += 1;
        }
    }

    Ok(OutlinePlan {
        status: status.to_string(),
        mode: mode.to_string(),
        animation: animation.to_string(),
        background: background.to_string(),
        pages,
        question_count,
    })
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c))
}

/// Validates and reads `plan/design-spec.md`'s JSON section (contract §1).
pub fn parse_design_spec(text: &str) -> SlidraResult<DesignSpec> {
    let value = extract_json_fence(text)?;
    let obj = require_object(&value, "design-spec")?;
    let density = require_str(obj, "density", "design-spec")?;
    require_enum(density, DENSITIES, "design-spec.density")?;
    let visual = match obj.get("visual") {
        None => "editorial-tech",
        Some(value) => {
            let visual = value
                .as_str()
                .ok_or_else(|| SlidraError::invalid("design-spec.visual must be a string"))?;
            require_enum(visual, VISUALS, "design-spec.visual")?;
            visual
        }
    };

    let palette_obj = obj
        .get("palette")
        .and_then(Value::as_object)
        .ok_or_else(|| SlidraError::invalid("design-spec missing palette object"))?;
    let mut palette = Vec::with_capacity(PALETTE_ROLES.len());
    for role in PALETTE_ROLES {
        let color = palette_obj
            .get(*role)
            .and_then(Value::as_str)
            .ok_or_else(|| SlidraError::invalid(format!("design-spec.palette missing {role}")))?;
        if !is_hex_color(color) {
            return Err(SlidraError::invalid(format!(
                "design-spec.palette.{role} must be uppercase #RRGGBB: {color}"
            )));
        }
        palette.push((role.to_string(), color.to_string()));
    }

    let scale_obj = obj
        .get("type_scale")
        .and_then(Value::as_object)
        .ok_or_else(|| SlidraError::invalid("design-spec missing type_scale object"))?;
    let mut type_scale = Vec::with_capacity(TYPE_ROLES.len());
    for role in TYPE_ROLES {
        let size = scale_obj
            .get(*role)
            .and_then(Value::as_f64)
            .ok_or_else(|| {
                SlidraError::invalid(format!("design-spec.type_scale missing {role}"))
            })?;
        if !size.is_finite() || size <= 0.0 {
            return Err(SlidraError::invalid(format!(
                "design-spec.type_scale.{role} must be a number greater than 0"
            )));
        }
        type_scale.push((role.to_string(), size));
    }

    let layout = parse_layout_anchors(obj)?;
    let shape_language = match obj.get("shape_language") {
        None => "plain",
        Some(value) => {
            let name = value.as_str().ok_or_else(|| {
                SlidraError::invalid("design-spec.shape_language must be a string")
            })?;
            require_enum(name, SHAPE_LANGUAGES, "design-spec.shape_language")?;
            name
        }
    };

    Ok(DesignSpec {
        density: density.to_string(),
        visual: visual.to_string(),
        palette,
        type_scale,
        layout,
        shape_language: shape_language.to_string(),
    })
}

/// Reads a page's optional `blueprint` object. Absent is fine (the page has
/// not been composed yet); present must be complete and well-typed — a
/// half-written blueprint would reconcile against nothing.
fn parse_blueprint(
    page: &serde_json::Map<String, Value>,
    what: &str,
) -> SlidraResult<Option<PageBlueprint>> {
    let Some(value) = page.get("blueprint") else {
        return Ok(None);
    };
    let obj = value
        .as_object()
        .ok_or_else(|| SlidraError::invalid(format!("{what}.blueprint must be an object")))?;

    let shape = obj
        .get("shape")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            SlidraError::invalid(format!(
                "{what}.blueprint is missing non-empty string field shape"
            ))
        })?;

    let mut counts = [0usize; 2];
    for (index, key) in ["nodes", "steps"].iter().enumerate() {
        counts[index] = obj.get(*key).and_then(Value::as_u64).ok_or_else(|| {
            SlidraError::invalid(format!(
                "{what}.blueprint is missing non-negative integer field {key}"
            ))
        })? as usize;
    }

    Ok(Some(PageBlueprint {
        shape: shape.to_string(),
        nodes: counts[0],
        steps: counts[1],
    }))
}

/// Reads the optional `layout` object. Every field is optional and falls
/// back to the default anchor, but a field that IS present must be a
/// positive finite number (or, for `spacing`, a non-empty array of them) —
/// a typo becomes an error, never a silent default.
fn parse_layout_anchors(obj: &serde_json::Map<String, Value>) -> SlidraResult<LayoutAnchors> {
    let mut anchors = LayoutAnchors::default();
    let Some(layout) = obj.get("layout") else {
        return Ok(anchors);
    };
    let layout = layout
        .as_object()
        .ok_or_else(|| SlidraError::invalid("design-spec.layout must be an object"))?;

    for (key, slot) in [
        ("side_margin", &mut anchors.side_margin),
        ("bottom_margin", &mut anchors.bottom_margin),
        ("footer_margin", &mut anchors.footer_margin),
        ("gutter", &mut anchors.gutter),
    ] {
        let Some(value) = layout.get(key) else {
            continue;
        };
        let number = value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(|| {
                SlidraError::invalid(format!("design-spec.layout.{key} must be a number ≥ 0"))
            })?;
        *slot = number;
    }

    if let Some(value) = layout.get("spacing") {
        let steps = value
            .as_array()
            .ok_or_else(|| SlidraError::invalid("design-spec.layout.spacing must be an array"))?;
        if steps.is_empty() {
            return Err(SlidraError::invalid(
                "design-spec.layout.spacing cannot be an empty array",
            ));
        }
        let mut parsed = Vec::with_capacity(steps.len());
        for step in steps {
            let number = step
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0)
                .ok_or_else(|| {
                    SlidraError::invalid(
                        "design-spec.layout.spacing's every item must be a number greater than 0",
                    )
                })?;
            parsed.push(number);
        }
        anchors.spacing = parsed;
    }

    Ok(anchors)
}

/// Which plan file a `plan set`/`plan delete` name addresses.
pub fn plan_path_for(name: &str) -> SlidraResult<&'static str> {
    match name {
        "outline" => Ok(OUTLINE_PATH),
        "design-spec" => Ok(DESIGN_SPEC_PATH),
        other => Err(SlidraError::invalid(format!(
            "plan file name can only be outline or design-spec: {other}"
        ))),
    }
}

/// Reads `plan/outline.md` if present. `Ok(None)` when the file is absent;
/// a present-but-invalid file is an error (never silently ignored).
pub fn read_outline(work_dir: &Path) -> SlidraResult<Option<OutlinePlan>> {
    match virtual_fs::read_virtual_file(work_dir, OUTLINE_PATH) {
        Ok(text) => parse_outline(&text).map(Some),
        Err(SlidraError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn read_design_spec(work_dir: &Path) -> SlidraResult<Option<DesignSpec>> {
    match virtual_fs::read_virtual_file(work_dir, DESIGN_SPEC_PATH) {
        Ok(text) => parse_design_spec(&text).map(Some),
        Err(SlidraError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

fn describe_blueprint(blueprint: Option<&PageBlueprint>) -> String {
    match blueprint {
        None => "(none)".to_string(),
        Some(b) => format!("{} / {} nodes / {} steps", b.shape, b.nodes, b.steps),
    }
}

/// What a `plan set outline` may still change once the author has confirmed
/// the plan. The build legitimately keeps writing here — `blueprint` is its
/// own composition-reasoning written down (see `PageBlueprint`) — so this is a field
/// whitelist, not a read-only flag. What it stops is the one move that makes
/// the reconciliation meaningless: draw the page, fail `validate`, then edit
/// the blueprint until the numbers agree. A real session did exactly that
/// three times, and `blueprint.nodes`/`blueprint.steps` reported nothing.
///
/// `drawn_pages` is how many slides the deck actually has. Pages pair with
/// slides by position, exactly as `validate` pairs them — `n` is already
/// pinned to `index + 1` by `parse_outline`.
///
/// Every violation is reported at once: told one at a time, an agent just
/// tries them one at a time.
pub fn assert_confirmed_outline_change_allowed(
    old: &OutlinePlan,
    new: &OutlinePlan,
    drawn_pages: usize,
    force: bool,
) -> SlidraResult<()> {
    if force || old.status != "confirmed" {
        return Ok(());
    }

    let mut violations: Vec<String> = Vec::new();
    if new.status != "confirmed" {
        violations.push(format!(
            "status: {} → {} (reverting to draft reopens the author's confirmation gate)",
            old.status, new.status
        ));
    }
    for (field, old_value, new_value) in [
        ("mode", &old.mode, &new.mode),
        ("animation", &old.animation, &new.animation),
        ("background", &old.background, &new.background),
    ] {
        if old_value != new_value {
            violations.push(format!("{field}: {old_value} → {new_value}"));
        }
    }
    if new.pages.len() < old.pages.len() {
        violations.push(format!(
            "page count: {} pages → {} pages (cannot delete pages)",
            old.pages.len(),
            new.pages.len()
        ));
    }

    for (index, old_page) in old.pages.iter().enumerate() {
        let Some(new_page) = new.pages.get(index) else {
            break;
        };
        let n = index + 1;
        for (field, old_value, new_value) in [
            (
                "relationship",
                &old_page.relationship,
                &new_page.relationship,
            ),
            ("rhythm", &old_page.rhythm, &new_page.rhythm),
            ("title", &old_page.title, &new_page.title),
        ] {
            if old_value != new_value {
                violations.push(format!("page {n} {field}: {old_value} → {new_value}"));
            }
        }
        // Writing a blueprint for the first time is the composition-reasoning step doing
        // its job, whenever it happens. Rewriting one the page was already
        // drawn against is the move this guard exists for.
        if index < drawn_pages
            && old_page.blueprint.is_some()
            && old_page.blueprint != new_page.blueprint
        {
            violations.push(format!(
                "page {n} blueprint (slides/{n:03}.svg is already drawn): {} → {}",
                describe_blueprint(old_page.blueprint.as_ref()),
                describe_blueprint(new_page.blueprint.as_ref()),
            ));
        }
    }

    if violations.is_empty() {
        return Ok(());
    }
    Err(SlidraError::invalid(format!(
        "the plan has already been confirmed, these can no longer change:\n  - {}\n\
         composition comes before pages: if a page is drawn wrong, fix the page, don't change the plan to match it.\n\
         to change a question the author already answered, ask the author first. to split a page or switch layouts mid-stream, add --force at the end of the same command.",
        violations.join("\n  - ")
    )))
}

/// `plan set`: validates the content for `name`, then writes it — no undo
/// history entry (plan files are not slide content).
pub fn set_plan(id: &str, name: &str, content: &str, force: bool) -> SlidraResult<String> {
    let path = plan_path_for(name)?;
    let work_dir = workspace::resolve_work_dir(id)?;
    match name {
        "outline" => {
            let new = parse_outline(content)?;
            // An existing outline this build cannot parse gets no guard —
            // that write is the repair path, and refusing it would leave
            // the plan unfixable.
            if let Ok(Some(old)) = read_outline(&work_dir) {
                let drawn = workspace::project::read_project_json(&work_dir)
                    .map(|project| project.slides.len())
                    .unwrap_or(0);
                assert_confirmed_outline_change_allowed(&old, &new, drawn, force)?;
            }
        }
        _ => {
            parse_design_spec(content)?;
        }
    }
    let plan_dir = work_dir.join("plan");
    std::fs::create_dir_all(&plan_dir)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {path}")))?;
    let file_name = path
        .strip_prefix("plan/")
        .expect("plan paths live under plan/");
    std::fs::write(plan_dir.join(file_name), content)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {path}")))?;
    Ok(path.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanListEntry {
    pub file: String,
    pub status: Option<String>,
}

/// `plan list`: the plan files present, outline first.
pub fn list_plans(id: &str) -> SlidraResult<Vec<PlanListEntry>> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut entries = Vec::new();
    if let Some(outline) = read_outline(&work_dir)? {
        entries.push(PlanListEntry {
            file: OUTLINE_PATH.to_string(),
            status: Some(outline.status),
        });
    }
    if read_design_spec(&work_dir)?.is_some() {
        entries.push(PlanListEntry {
            file: DESIGN_SPEC_PATH.to_string(),
            status: None,
        });
    }
    Ok(entries)
}

/// `plan delete`: one named file, or the whole `plan/` directory when
/// `name` is `None`. Not-found when there is nothing to delete.
pub fn delete_plan(id: &str, name: Option<&str>) -> SlidraResult<String> {
    let work_dir = workspace::resolve_work_dir(id)?;
    match name {
        Some(name) => {
            let path = plan_path_for(name)?;
            let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, path)?;
            std::fs::remove_file(&real_path)
                .map_err(|_| SlidraError::invalid(format!("error deleting file: {path}")))?;
            Ok(path.to_string())
        }
        None => {
            if virtual_fs::list_virtual_entries(&work_dir, "plan").is_err() {
                return Err(SlidraError::not_found("directory not found: plan/"));
            }
            std::fs::remove_dir_all(work_dir.join("plan"))
                .map_err(|_| SlidraError::invalid("error deleting file: plan/"))?;
            Ok("plan/".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const OUTLINE_OK: &str = "```json\n{ \"status\": \"draft\", \"mode\": \"pyramid\", \"pages\": [ { \"n\": 1, \"relationship\": \"membership\", \"type\": \"cover\", \"rhythm\": \"anchor\", \"title\": \"cover\" }, { \"n\": 2, \"relationship\": \"membership\", \"type\": \"bullets\", \"rhythm\": \"dense\", \"title\": \"bullet point\" } ], \"questions\": [ { \"id\": \"mode\", \"question\": \"skeleton\", \"note\": \"viewpoint\", \"recommended\": \"pyramid\", \"options\": [ { \"value\": \"pyramid\", \"label\": \"conclusion first\" }, { \"value\": \"narrative\", \"label\": \"storyline\" } ], \"free_text\": true } ] }\n```\n\n## Page 1\nDescription.\n";

    pub(crate) const DESIGN_SPEC_OK: &str = "```json\n{ \"density\": \"presentation\", \"palette\": { \"background\": \"#101418\", \"secondary_bg\": \"#1B2129\", \"primary\": \"#4F8DFF\", \"accent\": \"#F5B942\", \"secondary_accent\": \"#6DD3A5\", \"text\": \"#F4F6F8\", \"muted\": \"#9AA7B4\" }, \"type_scale\": { \"cover\": 64, \"section\": 56, \"number\": 140, \"claim\": 48, \"title\": 40, \"subtitle\": 28, \"body\": 24, \"column\": 22, \"caption\": 18 } }\n```\nBody.\n";

    #[test]
    fn parses_a_valid_outline() {
        let plan = parse_outline(OUTLINE_OK).unwrap();
        assert_eq!(plan.status, "draft");
        assert_eq!(plan.mode, "pyramid");
        assert_eq!(plan.pages.len(), 2);
        assert_eq!(plan.pages[1].page_type.as_deref(), Some("bullets"));
        assert_eq!(plan.question_count, 1);
    }

    #[test]
    fn shape_language_is_optional_and_checked_against_the_list() {
        // #303: borrowed from ppt-master — the shape language carries no
        // colour, so any of it pairs with any palette. Absent is `plain`.
        assert_eq!(
            parse_design_spec(DESIGN_SPEC_OK).unwrap().shape_language,
            "plain"
        );
        let with = DESIGN_SPEC_OK.replace(
            "\"type_scale\"",
            "\"shape_language\": \"ink-wash\", \"type_scale\"",
        );
        assert_eq!(parse_design_spec(&with).unwrap().shape_language, "ink-wash");
        let bogus = DESIGN_SPEC_OK.replace(
            "\"type_scale\"",
            "\"shape_language\": \"bauhaus\", \"type_scale\"",
        );
        assert!(parse_design_spec(&bogus).is_err());
    }

    #[test]
    fn layout_anchors_default_to_the_sample_values_and_reject_a_typo() {
        // #303 §C: composition is the page's own business, the safe area is
        // the deck's. A spec written before the block reads as it always did.
        let default = parse_design_spec(DESIGN_SPEC_OK).unwrap().layout;
        assert_eq!(default, LayoutAnchors::default());
        assert_eq!(default.side_margin, 80.0);

        let with_layout = DESIGN_SPEC_OK.replace(
            "\"type_scale\"",
            "\"layout\": { \"side_margin\": 64, \"gutter\": 32, \"spacing\": [12, 24, 48] }, \"type_scale\"",
        );
        let anchors = parse_design_spec(&with_layout).unwrap().layout;
        assert_eq!(anchors.side_margin, 64.0);
        assert_eq!(anchors.gutter, 32.0);
        assert_eq!(anchors.spacing, vec![12.0, 24.0, 48.0]);
        // Untouched fields keep the default.
        assert_eq!(anchors.bottom_margin, 72.0);

        // A present-but-wrong value is an error, never a silent default.
        let typo = DESIGN_SPEC_OK.replace(
            "\"type_scale\"",
            "\"layout\": { \"side_margin\": \"80\" }, \"type_scale\"",
        );
        assert!(parse_design_spec(&typo).is_err());
        let empty = DESIGN_SPEC_OK.replace(
            "\"type_scale\"",
            "\"layout\": { \"spacing\": [] }, \"type_scale\"",
        );
        assert!(parse_design_spec(&empty).is_err());
    }

    #[test]
    fn parses_a_valid_design_spec() {
        let spec = parse_design_spec(DESIGN_SPEC_OK).unwrap();
        assert_eq!(spec.density, "presentation");
        assert_eq!(spec.color("accent"), "#F5B942");
        assert_eq!(spec.size("number"), 140.0);
    }

    #[test]
    fn rejects_a_file_without_a_json_fence() {
        let err = parse_outline("# body only\n").unwrap_err();
        assert!(err.message().contains("```json"), "{}", err.message());
    }

    #[test]
    fn rejects_non_consecutive_page_numbers() {
        let text = OUTLINE_OK.replace("\"n\": 2", "\"n\": 3");
        let err = parse_outline(&text).unwrap_err();
        assert!(
            err.message().contains("increasing consecutively from 1"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn rejects_an_unknown_page_type_mode_and_status() {
        assert!(parse_outline(&OUTLINE_OK.replace("\"bullets\"", "\"timeline\"")).is_err());
        assert!(
            parse_outline(&OUTLINE_OK.replace("\"pyramid\", \"pages\"", "\"funnel\", \"pages\""))
                .is_err()
        );
        assert!(parse_outline(&OUTLINE_OK.replace("\"draft\"", "\"done\"")).is_err());
    }

    #[test]
    fn rejects_a_recommended_value_outside_the_options() {
        let text = OUTLINE_OK.replace(
            "\"recommended\": \"pyramid\"",
            "\"recommended\": \"showcase\"",
        );
        let err = parse_outline(&text).unwrap_err();
        assert!(err.message().contains("recommended"), "{}", err.message());
    }

    #[test]
    fn rejects_too_few_options_and_duplicate_ids() {
        let one_option = OUTLINE_OK.replace(
            ", { \"value\": \"narrative\", \"label\": \"storyline\" }",
            "",
        );
        assert!(
            parse_outline(&one_option)
                .unwrap_err()
                .message()
                .contains("2 to 4")
        );
        let dup = OUTLINE_OK.replace(
            "\"questions\": [",
            "\"questions\": [ { \"id\": \"mode\", \"question\": \"x\", \"recommended\": \"a\", \"options\": [ { \"value\": \"a\", \"label\": \"a\" }, { \"value\": \"b\", \"label\": \"b\" } ] },",
        );
        assert!(
            parse_outline(&dup)
                .unwrap_err()
                .message()
                .contains("duplicate")
        );
    }

    #[test]
    fn rejects_lowercase_or_missing_palette_colors_and_bad_sizes() {
        let lower = DESIGN_SPEC_OK.replace("#F5B942", "#f5b942");
        assert!(
            parse_design_spec(&lower)
                .unwrap_err()
                .message()
                .contains("#RRGGBB")
        );
        let missing = DESIGN_SPEC_OK.replace("\"muted\": \"#9AA7B4\"", "\"mutedd\": \"#9AA7B4\"");
        assert!(
            parse_design_spec(&missing)
                .unwrap_err()
                .message()
                .contains("muted")
        );
        let zero = DESIGN_SPEC_OK.replace("\"body\": 24", "\"body\": 0");
        assert!(
            parse_design_spec(&zero)
                .unwrap_err()
                .message()
                .contains("greater than 0")
        );
        let density = DESIGN_SPEC_OK.replace("\"presentation\"", "\"dense\"");
        assert!(parse_design_spec(&density).is_err());
    }

    #[test]
    fn animation_and_visual_are_optional_enums() {
        let outline = parse_outline(OUTLINE_OK).unwrap();
        assert_eq!(outline.animation, "full");
        let minimal = OUTLINE_OK.replacen("\"mode\"", "\"animation\": \"minimal\", \"mode\"", 1);
        assert_eq!(parse_outline(&minimal).unwrap().animation, "minimal");
        let bad = OUTLINE_OK.replacen("\"mode\"", "\"animation\": \"lots\", \"mode\"", 1);
        assert!(
            parse_outline(&bad)
                .unwrap_err()
                .message()
                .contains("animation")
        );
        assert_eq!(outline.background, "on");
        let off = OUTLINE_OK.replacen("\"mode\"", "\"background\": \"off\", \"mode\"", 1);
        assert_eq!(parse_outline(&off).unwrap().background, "off");
        let bad_bg = OUTLINE_OK.replacen("\"mode\"", "\"background\": \"maybe\", \"mode\"", 1);
        assert!(
            parse_outline(&bad_bg)
                .unwrap_err()
                .message()
                .contains("background")
        );

        let spec = parse_design_spec(DESIGN_SPEC_OK).unwrap();
        assert_eq!(spec.visual, "editorial-tech");
        let named = DESIGN_SPEC_OK.replacen(
            "\"density\"",
            "\"visual\": \"editorial-tech\", \"density\"",
            1,
        );
        assert_eq!(parse_design_spec(&named).unwrap().visual, "editorial-tech");
        let bad =
            DESIGN_SPEC_OK.replacen("\"density\"", "\"visual\": \"brutalist\", \"density\"", 1);
        assert!(
            parse_design_spec(&bad)
                .unwrap_err()
                .message()
                .contains("visual")
        );
    }

    #[test]
    fn plan_path_names_are_fixed() {
        assert_eq!(plan_path_for("outline").unwrap(), OUTLINE_PATH);
        assert_eq!(plan_path_for("design-spec").unwrap(), DESIGN_SPEC_PATH);
        assert!(plan_path_for("brief").is_err());
    }

    /// One page, `order`/`dense`, with the blueprint the build wrote.
    const PAGE_WITH_BLUEPRINT: &str = "{ \"n\": 1, \"relationship\": \"order\", \"rhythm\": \"dense\", \"title\": \"first page\", \"blueprint\": { \"shape\": \"spine-path\", \"nodes\": 3, \"steps\": 4 } }";

    fn outline(status: &str, pages: &str) -> OutlinePlan {
        parse_outline(&format!(
            "```json\n{{ \"status\": \"{status}\", \"mode\": \"narrative\", \"pages\": [{pages}] }}\n```\n"
        ))
        .unwrap()
    }

    fn guard(old: &OutlinePlan, new: &OutlinePlan, drawn_pages: usize) -> SlidraResult<()> {
        assert_confirmed_outline_change_allowed(old, new, drawn_pages, false)
    }

    #[test]
    fn a_draft_plan_is_not_guarded() {
        let old = outline("draft", PAGE_WITH_BLUEPRINT);
        let new = outline(
            "draft",
            &PAGE_WITH_BLUEPRINT.replace("\"nodes\": 3", "\"nodes\": 0"),
        );
        assert!(guard(&old, &new, 1).is_ok());
    }

    #[test]
    fn a_confirmed_plan_refuses_changing_an_answer_the_author_gave() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let mut new = outline("confirmed", PAGE_WITH_BLUEPRINT);
        new.mode = "pyramid".to_string();
        assert!(guard(&old, &new, 1).unwrap_err().message().contains("mode"));
    }

    #[test]
    fn a_confirmed_plan_refuses_rewriting_a_drawn_pages_blueprint() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let new = outline(
            "confirmed",
            &PAGE_WITH_BLUEPRINT.replace("\"nodes\": 3", "\"nodes\": 0"),
        );
        assert!(
            guard(&old, &new, 1)
                .unwrap_err()
                .message()
                .contains("slides/001.svg")
        );
    }

    #[test]
    fn the_same_rewrite_is_fine_while_the_page_is_still_undrawn() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let new = outline(
            "confirmed",
            &PAGE_WITH_BLUEPRINT.replace("\"nodes\": 3", "\"nodes\": 0"),
        );
        assert!(guard(&old, &new, 0).is_ok());
    }

    #[test]
    fn writing_a_blueprint_for_the_first_time_is_always_allowed() {
        let without = "{ \"n\": 1, \"relationship\": \"order\", \"rhythm\": \"dense\", \"title\": \"first page\" }";
        let old = outline("confirmed", without);
        let new = outline("confirmed", PAGE_WITH_BLUEPRINT);
        assert!(guard(&old, &new, 1).is_ok());
    }

    #[test]
    fn a_confirmed_plan_allows_appending_a_page_but_not_dropping_one() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let appended = format!(
            "{PAGE_WITH_BLUEPRINT}, {{ \"n\": 2, \"relationship\": \"none\", \"rhythm\": \"anchor\", \"title\": \"new page\" }}"
        );
        assert!(guard(&old, &outline("confirmed", &appended), 1).is_ok());

        let old_two = outline("confirmed", &appended);
        assert!(
            guard(&old_two, &outline("confirmed", PAGE_WITH_BLUEPRINT), 2)
                .unwrap_err()
                .message()
                .contains("cannot delete page")
        );
    }

    #[test]
    fn a_confirmed_plan_refuses_going_back_to_draft() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let new = outline("draft", PAGE_WITH_BLUEPRINT);
        assert!(
            guard(&old, &new, 1)
                .unwrap_err()
                .message()
                .contains("status")
        );
    }

    #[test]
    fn every_violation_is_reported_at_once() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let mut new = outline(
            "confirmed",
            &PAGE_WITH_BLUEPRINT
                .replace("\"nodes\": 3", "\"nodes\": 0")
                .replace("first page", "edited title"),
        );
        new.mode = "pyramid".to_string();
        let message = guard(&old, &new, 1).unwrap_err().message().to_string();
        assert!(message.contains("mode"), "{message}");
        assert!(message.contains("title"), "{message}");
        assert!(message.contains("blueprint"), "{message}");
    }

    #[test]
    fn force_bypasses_the_guard() {
        let old = outline("confirmed", PAGE_WITH_BLUEPRINT);
        let new = outline(
            "draft",
            "{ \"n\": 1, \"relationship\": \"none\", \"rhythm\": \"anchor\", \"title\": \"all changed\" }",
        );
        assert!(assert_confirmed_outline_change_allowed(&old, &new, 1, true).is_ok());
    }
}
