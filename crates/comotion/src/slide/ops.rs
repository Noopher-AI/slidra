//! Slide- and template-level file orchestration, ported from
//! `packages/core/src/slide-ops.ts` (the subset this ticket needs: `slide
//! add / delete / duplicate / move`, `template add / list / rename /
//! delete`, `slide notes set`, `slide transition set`'s merge logic,
//! `mint_element_ids`, `build_blank_slide_svg`; **not** the comment family —
//! that is a separate ticket, see plan §2 item 3). Every write here goes
//! through `workspace::write` (undo is free) or `workspace::project::write_project`
//! (which itself routes through `workspace::write::write_presentation_file`).

use crate::errors::{CoMotionError, CoMotionResult};
use crate::history::{begin_history_group, end_history_group};
use crate::id::generate_opaque_id;
use crate::slide::scan::{ScannedNode, attribute_of, scan_document};
use crate::slide::transition::{
    PageTransitionEffect, SlideTransition, SlideTransitionEdge, read_slide_transition,
    set_slide_transition,
};
use crate::workspace::project::{
    TemplateEntry, read_project_json, read_template_entries, write_project,
};
use crate::workspace::{self, virtual_fs, write as ws_write};
use std::collections::HashSet;

fn generate_element_id() -> String {
    format!("el-{}", generate_opaque_id())
}

/// Builds a blank slide/template: an empty, compliant `<svg viewBox>` with
/// no elements yet.
pub fn build_blank_slide_svg(width: f64, height: f64) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\"></svg>\n",
        crate::svgnum::format_svg_number(width),
        crate::svgnum::format_svg_number(height)
    )
}

/// Re-mints every `id` in the document (applying a template, or duplicating
/// a slide, always mints fresh ids so the copy never collides with the
/// source). Any `<comot:effect target="...">` naming a remapped id is
/// updated to the new id in the same pass.
pub fn mint_element_ids(
    svg_content: &str,
    generate_id: &mut dyn FnMut() -> String,
) -> CoMotionResult<String> {
    use crate::splice::{Splice, apply_splices};
    use crate::text::runs::utf16_offset_to_byte_offset as b;

    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))?;

    let mut used_ids: HashSet<String> = HashSet::new();
    collect_all_ids(&roots, &mut used_ids);

    let mut id_nodes: Vec<&ScannedNode> = Vec::new();
    fn collect_id_nodes<'a>(node: &'a ScannedNode, into: &mut Vec<&'a ScannedNode>) {
        if attribute_of(node, "id").is_some() {
            into.push(node);
        }
        for child in &node.children {
            collect_id_nodes(child, into);
        }
    }
    // `<metadata>` never carries an element id to re-mint — its
    // `<comot:effect>` children only ever *reference* one via `target`,
    // remapped below, not re-minted here.
    for child in &svg_root.children {
        if child.tag == "metadata" {
            continue;
        }
        collect_id_nodes(child, &mut id_nodes);
    }

    let mut mapping: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for node in &id_nodes {
        let id_attr = attribute_of(node, "id").expect("collected because it has one");
        let mut candidate = generate_id();
        while used_ids.contains(&candidate) {
            candidate = generate_id();
        }
        used_ids.insert(candidate.clone());
        mapping.insert(id_attr.value.clone(), candidate);
    }

    let mut splices: Vec<Splice> = Vec::new();
    for node in &id_nodes {
        let id_attr = attribute_of(node, "id").expect("collected because it has one");
        let new_id = mapping.get(&id_attr.value).expect("mapped above");
        splices.push(Splice {
            start: b(svg_content, id_attr.start),
            end: b(svg_content, id_attr.end),
            text: format!("id=\"{new_id}\""),
        });
    }

    let metadata = svg_root
        .children
        .iter()
        .find(|child| child.tag == "metadata");
    if let Some(metadata) = metadata {
        if let Some(effects_list) = metadata.children.iter().find(|c| c.tag == "comot:effects") {
            for effect in &effects_list.children {
                if effect.tag != "comot:effect" {
                    continue;
                }
                if let Some(target_attr) = attribute_of(effect, "target") {
                    if let Some(new_id) = mapping.get(&target_attr.value) {
                        splices.push(Splice {
                            start: b(svg_content, target_attr.start),
                            end: b(svg_content, target_attr.end),
                            text: format!("target=\"{new_id}\""),
                        });
                    }
                }
            }
        }
    }

    Ok(apply_splices(svg_content, &splices))
}

fn collect_all_ids(nodes: &[ScannedNode], into: &mut HashSet<String>) {
    for node in nodes {
        if let Some(id_attr) = attribute_of(node, "id") {
            into.insert(id_attr.value.clone());
        }
        collect_all_ids(&node.children, into);
    }
}

fn format_slide_number(n: u32) -> String {
    format!("{n:03}")
}

/// The smallest number not currently used as a `NNN.svg` filename directly
/// under `dir_name` — a gap left by a deleted slide is filled before a new
/// number is minted, never left behind.
fn next_available_number(id: &str, dir_name: &str) -> CoMotionResult<u32> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let entries = match virtual_fs::list_virtual_entries(&work_dir, dir_name) {
        Ok(entries) => entries,
        Err(CoMotionError::NotFound(_)) => Vec::new(),
        Err(err) => return Err(err),
    };
    let mut used: HashSet<u32> = HashSet::new();
    for entry in entries {
        if entry.len() == 7 && entry.ends_with(".svg") {
            if let Ok(n) = entry[..3].parse::<u32>() {
                used.insert(n);
            }
        }
    }
    let mut n = 1;
    while used.contains(&n) {
        n += 1;
    }
    Ok(n)
}

/// `index` is a raw parsed number (not yet an integer/range check) — same
/// contract as TS's `assertValidIndex`, which rejects a non-integer float
/// (e.g. `--at 1.5`) the same way it rejects an out-of-range one.
fn assert_valid_index(index: f64, max: usize, arg_name: &str) -> CoMotionResult<usize> {
    if index.fract() != 0.0 || index < 0.0 || index > max as f64 {
        return Err(CoMotionError::invalid(format!(
            "{arg_name} 超出範圍：{}",
            crate::svgnum::format_svg_number(index)
        )));
    }
    Ok(index as usize)
}

pub struct AddSlideInput {
    pub template_path: Option<String>,
    pub at: Option<f64>,
    /// Already-ingested page markup (`slide add --svg`, #303) — written as
    /// is instead of a blank page or a template copy.
    pub content: Option<String>,
}

#[derive(Debug)]
pub struct AddSlideResult {
    pub slide_path: String,
}

/// `comotion slide add`. With `template_path`, the new slide is the
/// template's content byte-for-byte except every element id, which is
/// re-minted. `project.json` and the new SVG are written in one history
/// group so undo removes both together.
pub fn add_slide(id: &str, input: AddSlideInput) -> CoMotionResult<AddSlideResult> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;

    let content = match (&input.content, &input.template_path) {
        (Some(_), Some(_)) => {
            return Err(CoMotionError::invalid("--svg 與 --template 不能同時使用"));
        }
        (Some(content), None) => content.clone(),
        (None, Some(template_path)) => {
            let templates = read_template_entries(&project);
            if templates.iter().any(|t| &t.file == template_path) {
                let raw = virtual_fs::read_virtual_file(
                    &workspace::resolve_work_dir(id)?,
                    template_path,
                )?;
                mint_element_ids(&raw, &mut generate_element_id)?
            } else if project.slides.contains(template_path) {
                return Err(CoMotionError::invalid(format!("不是範本：{template_path}")));
            } else {
                return Err(CoMotionError::not_found(format!(
                    "找不到範本：{template_path}"
                )));
            }
        }
        (None, None) => build_blank_slide_svg(project.canvas.width, project.canvas.height),
    };

    let at = input.at.unwrap_or(project.slides.len() as f64);
    let at = assert_valid_index(at, project.slides.len(), "--at")?;

    let number = next_available_number(id, "slides")?;
    let slide_path = format!("slides/{}.svg", format_slide_number(number));
    let mut next_slides = project.slides.clone();
    next_slides.insert(at, slide_path.clone());

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        ws_write::create_presentation_file(id, &slide_path, content.as_bytes())?;
        let mut raw = project.raw.clone();
        raw.insert(
            "slides".to_string(),
            serde_json::to_value(&next_slides).expect("Vec<String> serializes"),
        );
        write_project(id, raw)
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result?;

    Ok(AddSlideResult { slide_path })
}

/// `comotion slide delete`. Allowed to bring `slides` down to zero, and
/// allowed on a slide carrying locked elements.
pub fn delete_slide(id: &str, slide_path: &str) -> CoMotionResult<()> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    if !project.slides.contains(&slide_path.to_string()) {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }
    let next_slides: Vec<String> = project
        .slides
        .iter()
        .filter(|entry| entry.as_str() != slide_path)
        .cloned()
        .collect();

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        ws_write::delete_presentation_file(id, slide_path)?;
        let mut raw = project.raw.clone();
        raw.insert(
            "slides".to_string(),
            serde_json::to_value(&next_slides).expect("Vec<String> serializes"),
        );
        write_project(id, raw)
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result
}

pub struct DuplicateSlideResult {
    pub slide_path: String,
}

/// `comotion slide duplicate`: inserted directly after the source; every
/// element id (and nothing else) is re-minted; `<comot:notes>` is copied
/// verbatim along with the rest of the document.
pub fn duplicate_slide(id: &str, slide_path: &str) -> CoMotionResult<DuplicateSlideResult> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    let Some(source_index) = project
        .slides
        .iter()
        .position(|entry| entry.as_str() == slide_path)
    else {
        if read_template_entries(&project)
            .iter()
            .any(|t| t.file == slide_path)
        {
            return Err(CoMotionError::invalid(format!(
                "不是投影片：{slide_path}（複製範本請用 template add --from）"
            )));
        }
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    };

    let raw_svg = virtual_fs::read_virtual_file(&workspace::resolve_work_dir(id)?, slide_path)?;
    let content = mint_element_ids(&raw_svg, &mut generate_element_id)?;

    let number = next_available_number(id, "slides")?;
    let new_path = format!("slides/{}.svg", format_slide_number(number));
    let mut next_slides = project.slides.clone();
    next_slides.insert(source_index + 1, new_path.clone());

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        ws_write::create_presentation_file(id, &new_path, content.as_bytes())?;
        let mut raw = project.raw.clone();
        raw.insert(
            "slides".to_string(),
            serde_json::to_value(&next_slides).expect("Vec<String> serializes"),
        );
        write_project(id, raw)
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result?;

    Ok(DuplicateSlideResult {
        slide_path: new_path,
    })
}

/// `comotion slide move`: rewrites only `project.json`'s `slides` order —
/// no SVG file is opened or written.
pub fn move_slide(id: &str, slide_path: &str, new_index: f64) -> CoMotionResult<()> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    let Some(current_index) = project
        .slides
        .iter()
        .position(|entry| entry.as_str() == slide_path)
    else {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    };
    let max = if project.slides.is_empty() {
        0
    } else {
        project.slides.len() - 1
    };
    let new_index = assert_valid_index(new_index, max, "new-index")?;

    let mut next_slides = project.slides.clone();
    next_slides.remove(current_index);
    next_slides.insert(new_index, slide_path.to_string());

    let mut raw = project.raw.clone();
    raw.insert(
        "slides".to_string(),
        serde_json::to_value(&next_slides).expect("Vec<String> serializes"),
    );
    write_project(id, raw)
}

pub struct AddTemplateInput {
    pub from: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug)]
pub struct AddTemplateResult {
    pub template_path: String,
}

/// `comotion template add`: registers the new path in `project.json`'s
/// `templates` (created if this is the presentation's first template) —
/// never in `slides`.
pub fn add_template(id: &str, input: AddTemplateInput) -> CoMotionResult<AddTemplateResult> {
    let trimmed_name = input.name.as_deref().map(str::trim);
    if let Some(trimmed) = trimmed_name {
        if trimmed.is_empty() {
            return Err(CoMotionError::invalid("範本名稱不可為空"));
        }
    }

    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;

    let content = match &input.from {
        Some(from) => {
            if !project.slides.contains(from) {
                return Err(CoMotionError::not_found(format!("找不到投影片：{from}")));
            }
            let raw = virtual_fs::read_virtual_file(&workspace::resolve_work_dir(id)?, from)?;
            mint_element_ids(&raw, &mut generate_element_id)?
        }
        None => build_blank_slide_svg(project.canvas.width, project.canvas.height),
    };

    let number = next_available_number(id, "templates")?;
    let template_path = format!("templates/{}.svg", format_slide_number(number));
    let name = trimmed_name
        .map(str::to_string)
        .unwrap_or_else(|| format_slide_number(number));
    let mut next_templates: Vec<TemplateEntry> = read_template_entries(&project);
    next_templates.push(TemplateEntry {
        file: template_path.clone(),
        name,
    });

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        ws_write::create_presentation_file(id, &template_path, content.as_bytes())?;
        let mut raw = project.raw.clone();
        raw.insert(
            "templates".to_string(),
            serde_json::Value::Array(
                next_templates
                    .iter()
                    .map(|t| serde_json::json!({ "file": t.file, "name": t.name }))
                    .collect(),
            ),
        );
        write_project(id, raw)
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result?;

    Ok(AddTemplateResult { template_path })
}

/// `comotion template list`: the presentation's templates in
/// `project.json` order, normalized.
pub fn list_templates(id: &str) -> CoMotionResult<Vec<TemplateEntry>> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    Ok(read_template_entries(&project))
}

/// `comotion template rename`: renames a template's `name` field only —
/// never the SVG file or its path. Two templates may share a name — no
/// uniqueness check, ever.
pub fn rename_template(id: &str, template_path: &str, new_name: &str) -> CoMotionResult<()> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(CoMotionError::invalid("範本名稱不可為空"));
    }

    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    let entries = read_template_entries(&project);
    let Some(index) = entries.iter().position(|e| e.file == template_path) else {
        if project.slides.contains(&template_path.to_string()) {
            return Err(CoMotionError::invalid(format!("不是範本：{template_path}")));
        }
        return Err(CoMotionError::not_found(format!(
            "找不到範本：{template_path}"
        )));
    };
    let mut next_entries = entries;
    next_entries[index].name = trimmed.to_string();

    let mut raw = project.raw.clone();
    raw.insert(
        "templates".to_string(),
        serde_json::Value::Array(
            next_entries
                .iter()
                .map(|t| serde_json::json!({ "file": t.file, "name": t.name }))
                .collect(),
        ),
    );
    write_project(id, raw)
}

/// `comotion template delete`: deletes the SVG file and removes its
/// `templates` entry in one history group. Never touches, scans, or warns
/// about slides already built from it (ADR-0013).
pub fn delete_template(id: &str, template_path: &str) -> CoMotionResult<()> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    let entries = read_template_entries(&project);
    if !entries.iter().any(|e| e.file == template_path) {
        if project.slides.contains(&template_path.to_string()) {
            return Err(CoMotionError::invalid(format!(
                "不是範本：{template_path}（刪除投影片請用 slide delete）"
            )));
        }
        return Err(CoMotionError::not_found(format!(
            "找不到範本：{template_path}"
        )));
    }
    let next_entries: Vec<TemplateEntry> = entries
        .into_iter()
        .filter(|e| e.file != template_path)
        .collect();

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        ws_write::delete_presentation_file(id, template_path)?;
        let mut raw = project.raw.clone();
        raw.insert(
            "templates".to_string(),
            serde_json::Value::Array(
                next_entries
                    .iter()
                    .map(|t| serde_json::json!({ "file": t.file, "name": t.name }))
                    .collect(),
            ),
        );
        write_project(id, raw)
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result
}

/// `comotion slide notes set` — slides only, never templates.
pub fn set_notes(id: &str, slide_path: &str, text: &str) -> CoMotionResult<()> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    if !project.slides.contains(&slide_path.to_string()) {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }
    let original = virtual_fs::read_virtual_file(&workspace::resolve_work_dir(id)?, slide_path)?;
    let updated = crate::slide::notes::set_slide_notes(&original, text)?;
    ws_write::write_presentation_file(id, slide_path, &updated)
}

pub struct SetSlideTransitionOnInput {
    pub enter: Option<PageTransitionEffect>,
    pub enter_duration: Option<f64>,
    pub exit: Option<PageTransitionEffect>,
    pub exit_duration: Option<f64>,
    pub all: bool,
}

/// `comotion slide transition set`. Reads `slide_path`'s current
/// transition, merges in whichever of the four fields `input` names, then
/// either writes just `slide_path` or — with `all: true` — the fully
/// resolved result to every slide, as one undo step.
pub fn set_slide_transition_on(
    id: &str,
    slide_path: &str,
    input: SetSlideTransitionOnInput,
) -> CoMotionResult<usize> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    if !project.slides.contains(&slide_path.to_string()) {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }

    let source_raw = virtual_fs::read_virtual_file(&workspace::resolve_work_dir(id)?, slide_path)?;
    let current = read_slide_transition(&source_raw)?;
    let resolved = SlideTransition {
        enter: SlideTransitionEdge {
            effect: input.enter.unwrap_or(current.enter.effect),
            duration: input.enter_duration.unwrap_or(current.enter.duration),
        },
        exit: SlideTransitionEdge {
            effect: input.exit.unwrap_or(current.exit.effect),
            duration: input.exit_duration.unwrap_or(current.exit.duration),
        },
    };

    if !input.all {
        let updated = set_slide_transition(&source_raw, resolved)?;
        ws_write::write_presentation_file(id, slide_path, &updated)?;
        return Ok(1);
    }

    let opened_group = begin_history_group(id)?;
    let result = (|| -> CoMotionResult<()> {
        for path in &project.slides {
            let raw = if path == slide_path {
                source_raw.clone()
            } else {
                virtual_fs::read_virtual_file(&workspace::resolve_work_dir(id)?, path)?
            };
            let updated = set_slide_transition(&raw, resolved)?;
            ws_write::write_presentation_file(id, path, &updated)?;
        }
        Ok(())
    })();
    if opened_group {
        end_history_group(id)?;
    }
    result?;
    Ok(project.slides.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "comotion-test-ops-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let id = format!("test-{label}");
            unsafe {
                std::env::set_var("COMOTION_HOME", &home);
            }
            std::fs::create_dir_all(work.join("slides")).unwrap();
            std::fs::write(
                work.join("project.json"),
                r#"{"formatVersion":1,"name":"T","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"fonts":[]}"#,
            )
            .unwrap();
            std::fs::write(work.join("slides/001.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><rect id=\"r1\" width=\"1\" height=\"1\"/></svg>\n").unwrap();
            registry::register_for_test(&home, &id, &work);
            Fixture {
                home,
                work,
                id,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("COMOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn build_blank_slide_svg_matches_expected_bytes() {
        assert_eq!(
            build_blank_slide_svg(1280.0, 720.0),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n"
        );
    }

    #[test]
    fn mint_element_ids_remaps_ids_and_effect_targets() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><rect id=\"a\" width=\"1\"/><metadata><comot:effects xmlns:comot=\"https://co-motion.dev/ns\"><comot:effect target=\"a\" family=\"enter\"/></comot:effects></metadata></svg>";
        let mut counter = 0;
        let mut gen_fn = move || {
            counter += 1;
            format!("new-{counter}")
        };
        let updated = mint_element_ids(svg, &mut gen_fn).unwrap();
        assert!(updated.contains("id=\"new-1\""));
        assert!(updated.contains("target=\"new-1\""));
        assert!(!updated.contains("id=\"a\""));
    }

    #[test]
    fn mint_element_ids_handles_cjk_content_before_the_minted_id() {
        // NOOP-317 debt item 2 (M3 mutation survived): `ScannedNode`/
        // `ScannedAttribute` positions are UTF-16 code-unit offsets (see
        // `slide/scan.rs`'s `Utf16Tracker`), but `svg_content` is a UTF-8
        // Rust `&str`, so `mint_element_ids` must run every position through
        // `utf16_offset_to_byte_offset` before slicing it. Each CJK
        // character below is ONE UTF-16 code unit but THREE UTF-8 bytes, so
        // a version that spliced using the raw UTF-16 offset as a byte
        // offset would either panic (non-char-boundary slice) or splice the
        // wrong bytes instead of the `id` attribute.
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><text>中文本文標籤</text><rect id=\"a\" width=\"1\"/></svg>";
        let mut counter = 0;
        let mut gen_fn = move || {
            counter += 1;
            format!("new-{counter}")
        };
        let updated = mint_element_ids(svg, &mut gen_fn).unwrap();
        assert!(
            updated.contains("中文本文標籤"),
            "CJK text content must survive untouched: {updated}"
        );
        assert!(
            updated.contains("id=\"new-1\""),
            "id attribute must be spliced at the correct byte offset: {updated}"
        );
        assert!(!updated.contains("id=\"a\""));
    }

    #[test]
    fn add_slide_appends_and_writes_project_json() {
        let fixture = Fixture::new("add-slide");
        let result = add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: None,
                content: None,
            },
        )
        .unwrap();
        assert_eq!(result.slide_path, "slides/002.svg");
        assert!(fixture.work.join("slides/002.svg").exists());
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            project["slides"],
            serde_json::json!(["slides/001.svg", "slides/002.svg"])
        );
    }

    #[test]
    fn add_slide_fills_gap_left_by_deletion() {
        let fixture = Fixture::new("add-slide-gap");
        std::fs::write(
            fixture.work.join("slides/002.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n",
        )
        .unwrap();
        let result = add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: None,
                content: None,
            },
        )
        .unwrap();
        assert_eq!(result.slide_path, "slides/003.svg");
    }

    #[test]
    fn add_slide_at_out_of_range_errors() {
        let fixture = Fixture::new("add-slide-oor");
        let err = add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: Some(99.0),
                content: None,
            },
        )
        .unwrap_err();
        assert!(err.message().contains("超出範圍"));
    }

    /// Regression: `assert_valid_index` rejects a non-integer float
    /// (`--at 1.5`) the same way it rejects an out-of-range one — same
    /// contract as TS's `assertValidIndex`. Previously only exercised via
    /// `crates/comotion/tests/cli_golden.rs`'s
    /// `slide_add_and_move_reject_non_integer_position_byte_identical_to_node`,
    /// which was deleted with the Node CLI it cross-checked against; this
    /// keeps the behavior itself under test.
    #[test]
    fn add_slide_at_non_integer_errors() {
        // Fixture starts with 1 slide, so `max` is 1 and `0.5` is in range
        // — this isolates the `fract() != 0.0` branch from the `> max`
        // branch, which `add_slide_at_out_of_range_errors` already covers.
        let fixture = Fixture::new("add-slide-non-integer");
        let err = add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: Some(0.5),
                content: None,
            },
        )
        .unwrap_err();
        assert!(err.message().contains("0.5"));
    }

    #[test]
    fn move_slide_to_non_integer_index_errors() {
        // After the extra `add_slide`, there are 2 slides, so `max` is
        // `len() - 1 == 1` and `0.5` is in range — isolates the non-integer
        // check from the range check the same way as above.
        let fixture = Fixture::new("move-slide-non-integer");
        add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: None,
                content: None,
            },
        )
        .unwrap();
        let err = move_slide(&fixture.id, "slides/001.svg", 0.5).unwrap_err();
        assert!(err.message().contains("0.5"));
    }

    #[test]
    fn delete_slide_removes_file_and_updates_project() {
        let fixture = Fixture::new("delete-slide");
        delete_slide(&fixture.id, "slides/001.svg").unwrap();
        assert!(!fixture.work.join("slides/001.svg").exists());
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project["slides"], serde_json::json!([]));
    }

    #[test]
    fn delete_slide_not_a_slide_errors() {
        let fixture = Fixture::new("delete-slide-notfound");
        let err = delete_slide(&fixture.id, "slides/999.svg").unwrap_err();
        assert_eq!(err.message(), "不是投影片：slides/999.svg");
    }

    #[test]
    fn duplicate_slide_inserts_directly_after_source_with_new_id() {
        let fixture = Fixture::new("duplicate-slide");
        let result = duplicate_slide(&fixture.id, "slides/001.svg").unwrap();
        assert_eq!(result.slide_path, "slides/002.svg");
        let dup_content = std::fs::read_to_string(fixture.work.join("slides/002.svg")).unwrap();
        assert!(!dup_content.contains("id=\"r1\""));
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            project["slides"],
            serde_json::json!(["slides/001.svg", "slides/002.svg"])
        );
    }

    #[test]
    fn move_slide_only_rewrites_project_json() {
        let fixture = Fixture::new("move-slide");
        add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: None,
                content: None,
            },
        )
        .unwrap();
        let before = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        move_slide(&fixture.id, "slides/001.svg", 1.0).unwrap();
        let after = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert_eq!(before, after);
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            project["slides"],
            serde_json::json!(["slides/002.svg", "slides/001.svg"])
        );
    }

    #[test]
    fn add_template_registers_in_templates_never_slides() {
        let fixture = Fixture::new("add-template");
        let result = add_template(
            &fixture.id,
            AddTemplateInput {
                from: None,
                name: Some("My Template".to_string()),
            },
        )
        .unwrap();
        assert_eq!(result.template_path, "templates/001.svg");
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            project["templates"],
            serde_json::json!([{"file": "templates/001.svg", "name": "My Template"}])
        );
        assert_eq!(project["slides"], serde_json::json!(["slides/001.svg"]));
    }

    #[test]
    fn add_template_blank_name_errors_before_any_write() {
        let fixture = Fixture::new("add-template-blank-name");
        let err = add_template(
            &fixture.id,
            AddTemplateInput {
                from: None,
                name: Some("   ".to_string()),
            },
        )
        .unwrap_err();
        assert_eq!(err.message(), "範本名稱不可為空");
        assert!(!fixture.work.join("templates").exists());
    }

    #[test]
    fn list_templates_empty_is_ok_not_error() {
        let fixture = Fixture::new("list-templates-empty");
        let templates = list_templates(&fixture.id).unwrap();
        assert!(templates.is_empty());
    }

    #[test]
    fn rename_template_only_touches_name() {
        let fixture = Fixture::new("rename-template");
        add_template(
            &fixture.id,
            AddTemplateInput {
                from: None,
                name: Some("Old".to_string()),
            },
        )
        .unwrap();
        rename_template(&fixture.id, "templates/001.svg", "New").unwrap();
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project["templates"][0]["name"], "New");
        assert!(fixture.work.join("templates/001.svg").exists());
    }

    #[test]
    fn rename_template_targeting_a_slide_errors() {
        let fixture = Fixture::new("rename-template-is-slide");
        let err = rename_template(&fixture.id, "slides/001.svg", "New").unwrap_err();
        assert_eq!(err.message(), "不是範本：slides/001.svg");
    }

    #[test]
    fn delete_template_removes_file_and_entry_never_touches_slides() {
        let fixture = Fixture::new("delete-template");
        add_template(
            &fixture.id,
            AddTemplateInput {
                from: None,
                name: None,
            },
        )
        .unwrap();
        delete_template(&fixture.id, "templates/001.svg").unwrap();
        assert!(!fixture.work.join("templates/001.svg").exists());
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project["templates"], serde_json::json!([]));
        assert_eq!(project["slides"], serde_json::json!(["slides/001.svg"]));
    }

    #[test]
    fn set_notes_writes_comot_notes() {
        let fixture = Fixture::new("set-notes");
        set_notes(&fixture.id, "slides/001.svg", "hello").unwrap();
        let content = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert!(
            content.contains(
                "<comot:notes xmlns:comot=\"https://co-motion.dev/ns\">hello</comot:notes>"
            )
        );
    }

    #[test]
    fn set_notes_on_non_slide_errors() {
        let fixture = Fixture::new("set-notes-not-a-slide");
        let err = set_notes(&fixture.id, "slides/999.svg", "x").unwrap_err();
        assert_eq!(err.message(), "不是投影片：slides/999.svg");
    }

    #[test]
    fn set_slide_transition_on_single_slide() {
        let fixture = Fixture::new("transition-single");
        let count = set_slide_transition_on(
            &fixture.id,
            "slides/001.svg",
            SetSlideTransitionOnInput {
                enter: Some(PageTransitionEffect::Fade),
                enter_duration: None,
                exit: None,
                exit_duration: None,
                all: false,
            },
        )
        .unwrap();
        assert_eq!(count, 1);
        let content = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert!(content.contains("enter=\"fade\""));
    }

    #[test]
    fn set_slide_transition_on_all_applies_to_every_slide() {
        let fixture = Fixture::new("transition-all");
        add_slide(
            &fixture.id,
            AddSlideInput {
                template_path: None,
                at: None,
                content: None,
            },
        )
        .unwrap();
        let count = set_slide_transition_on(
            &fixture.id,
            "slides/001.svg",
            SetSlideTransitionOnInput {
                enter: Some(PageTransitionEffect::Zoom),
                enter_duration: None,
                exit: None,
                exit_duration: None,
                all: true,
            },
        )
        .unwrap();
        assert_eq!(count, 2);
        assert!(
            std::fs::read_to_string(fixture.work.join("slides/001.svg"))
                .unwrap()
                .contains("enter=\"zoom\"")
        );
        assert!(
            std::fs::read_to_string(fixture.work.join("slides/002.svg"))
                .unwrap()
                .contains("enter=\"zoom\"")
        );
    }
}
