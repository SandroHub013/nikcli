//! Removes what ADE itself left in a project's `.ade/` and no longer needs (`session/ade-prune.ts` chooses what).
//!
//! The window cannot delete files; this is the one door, and it opens on three folders only: a capture of the browser pane and its note in
//! `.ade/browser/`, a session's result in `.ade/results/`, a note on a design sheet in `.ade/design/note/`. A path is removed only if it is
//! inside an open project, is a plain file of one of those folders with the extension it has there, and is not one of the files that are
//! the project's memory (`decisions.jsonl`, `design.jsonl`, `memory.md`) or that keep `.ade/` out of git (`.gitignore`). A link is never
//! followed: what is removed is the link's own file or nothing.

use crate::plugin_install::main_only;
use crate::WriteRoots;
use std::path::{Component, Path};

/// Never removed, whatever else is true of them.
const PROTECTED: [&str; 4] = ["decisions.jsonl", "design.jsonl", "memory.md", ".gitignore"];

/// The most files one call removes: the window sends what it chose, and a runaway list is not a bigger prune.
const MAX_PATHS: usize = 5_000;

/// Whether `path` is a file ADE may prune: `.ade/browser/<x>.png|md`, `.ade/results/<x>.md`, `.ade/design/note/<x>.md`.
pub fn prunable(path: &Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .map(|name| name.unwrap_or_default())
        .collect();
    // Anything that is not a plain name (`..`, `.`, a root) after the drive or the leading slash is not a path this door opens for.
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return false;
    }
    let Some(at) = parts.iter().rposition(|name| name == ".ade") else {
        return false;
    };
    let below: Vec<&str> = parts[at + 1..].iter().map(String::as_str).collect();
    let (extensions, name): (&[&str], &str) = match below.as_slice() {
        ["browser", name] => (&["png", "md"], name),
        ["results", name] => (&["md"], name),
        ["design", "note", name] => (&["md"], name),
        _ => return false,
    };
    if name.is_empty() || PROTECTED.contains(&name) {
        return false;
    }
    match name.rsplit_once('.') {
        Some((stem, extension)) => !stem.is_empty() && extensions.contains(&extension),
        None => false,
    }
}

/// Removes the files in `paths` that pass `prunable` and are plain files; the bytes freed. Nothing else is touched, and a file that will
/// not go (it is open somewhere, say) is skipped: the next opening of the project tries it again.
pub fn prune_files(paths: &[std::path::PathBuf]) -> u64 {
    let mut freed = 0;
    for path in paths {
        if !prunable(path) {
            continue;
        }
        // `symlink_metadata`: a link is not a file here, so it is not followed and not removed.
        let Ok(meta) = std::fs::symlink_metadata(path) else { continue };
        if !meta.file_type().is_file() {
            continue;
        }
        let size = meta.len();
        if std::fs::remove_file(path).is_ok() {
            freed += size;
        }
    }
    freed
}

/// Removes the listed files of a project's `.ade/` that are old; the bytes freed. Only inside an open project (the same roots the window
/// may write in), only the shapes of `prunable`.
#[tauri::command]
pub async fn ade_prune(window: tauri::WebviewWindow, roots: tauri::State<'_, WriteRoots>, paths: Vec<String>) -> Result<u64, String> {
    main_only(window.label())?;
    let mut inside = Vec::new();
    for path in paths.iter().take(MAX_PATHS) {
        // The refusals are skipped, not errors: one path outside the project does not stop the others.
        if let Ok(resolved) = crate::within_roots(&roots, path) {
            inside.push(resolved);
        }
    }
    tauri::async_runtime::spawn_blocking(move || prune_files(&inside)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sep(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn the_three_folders_and_their_extensions_are_the_only_shapes() {
        assert!(prunable(&sep("/work/app/.ade/browser/20260901-100000-anteprima.png")));
        assert!(prunable(&sep("/work/app/.ade/browser/20260901-100000-anteprima.md")));
        assert!(prunable(&sep("/work/app/.ade/results/a.md")));
        assert!(prunable(&sep("/work/app/.ade/design/note/a.md")));
        // Case does not matter on a case-insensitive disk.
        assert!(prunable(&sep("/work/app/.ADE/Browser/A.PNG")));
    }

    #[test]
    fn what_is_the_projects_memory_or_keeps_ade_out_of_git_is_never_removed() {
        for name in PROTECTED {
            for folder in ["browser", "results", "design/note"] {
                assert!(!prunable(&sep(&format!("/work/app/.ade/{folder}/{name}"))), "{folder}/{name}");
            }
        }
        assert!(!prunable(&sep("/work/app/.ade/decisions.jsonl")));
        assert!(!prunable(&sep("/work/app/.ade/design.jsonl")));
        assert!(!prunable(&sep("/work/app/.ade/memory.md")));
        assert!(!prunable(&sep("/work/app/.ade/.gitignore")));
        assert!(!prunable(&sep("/work/app/.ade/MEMORY.MD")));
    }

    #[test]
    fn the_previews_of_the_design_proposals_and_other_folders_are_not_pruned() {
        assert!(!prunable(&sep("/work/app/.ade/design/3/1.html")));
        assert!(!prunable(&sep("/work/app/.ade/design/note/sub/a.md")));
        assert!(!prunable(&sep("/work/app/.ade/design/a.md")));
        assert!(!prunable(&sep("/work/app/.ade/browser/sub/a.png")));
        assert!(!prunable(&sep("/work/app/.ade/other/a.md")));
        assert!(!prunable(&sep("/work/app/.ade/a.md")));
        assert!(!prunable(&sep("/work/app/.ade/browser")));
        assert!(!prunable(&sep("/work/app/.ade")));
    }

    #[test]
    fn a_file_of_another_kind_or_with_no_extension_is_not_pruned() {
        assert!(!prunable(&sep("/work/app/.ade/browser/a.txt")));
        assert!(!prunable(&sep("/work/app/.ade/browser/a.json")));
        assert!(!prunable(&sep("/work/app/.ade/results/a.png")));
        assert!(!prunable(&sep("/work/app/.ade/results/log")));
        assert!(!prunable(&sep("/work/app/.ade/results/.md")));
        assert!(!prunable(&sep("/work/app/.ade/design/note/a.html")));
    }

    #[test]
    fn a_path_that_climbs_or_has_no_ade_is_not_pruned() {
        assert!(!prunable(&sep("/work/app/.ade/results/../../src/a.md")));
        assert!(!prunable(&sep("/work/app/results/a.md")));
        assert!(!prunable(&sep("/work/app/browser/a.png")));
        assert!(!prunable(&sep("")));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ade-prune-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn it_removes_the_files_chosen_counts_the_bytes_and_touches_nothing_else() {
        let project = scratch("files");
        let ade = project.join(".ade");
        for folder in ["browser", "results", "design/note"] {
            std::fs::create_dir_all(ade.join(folder)).unwrap();
        }
        let old_png = ade.join("browser/20260801-100000-a.png");
        let old_md = ade.join("browser/20260801-100000-a.md");
        let result = ade.join("results/old.md");
        let note = ade.join("design/note/old.md");
        std::fs::write(&old_png, vec![0u8; 1000]).unwrap();
        std::fs::write(&old_md, vec![0u8; 200]).unwrap();
        std::fs::write(&result, vec![0u8; 30]).unwrap();
        std::fs::write(&note, vec![0u8; 4]).unwrap();
        // What must survive: the memory, the design log, the .gitignore, a preview, a source file.
        let memory = ade.join("memory.md");
        let decisions = ade.join("decisions.jsonl");
        let design = ade.join("design.jsonl");
        let ignore = ade.join("browser/.gitignore");
        std::fs::create_dir_all(ade.join("design/3")).unwrap();
        let preview = ade.join("design/3/1.html");
        let source = project.join("src.md");
        for keep in [&memory, &decisions, &design, &ignore, &preview, &source] {
            std::fs::write(keep, b"keep").unwrap();
        }

        let freed = prune_files(&[
            old_png.clone(),
            old_md.clone(),
            result.clone(),
            note.clone(),
            memory.clone(),
            decisions.clone(),
            design.clone(),
            ignore.clone(),
            preview.clone(),
            source.clone(),
            ade.join("results/missing.md"),
        ]);
        assert_eq!(freed, 1000 + 200 + 30 + 4);
        for gone in [&old_png, &old_md, &result, &note] {
            assert!(!gone.exists(), "{}", gone.display());
        }
        for kept in [&memory, &decisions, &design, &ignore, &preview, &source] {
            assert_eq!(std::fs::read(kept).unwrap(), b"keep", "{}", kept.display());
        }
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_folder_with_the_name_of_a_file_is_not_removed() {
        let project = scratch("folder");
        let trap = project.join(".ade/results/odd.md");
        std::fs::create_dir_all(&trap).unwrap();
        std::fs::write(trap.join("inside.txt"), b"x").unwrap();
        assert_eq!(prune_files(&[trap.clone()]), 0);
        assert!(trap.join("inside.txt").exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_path_that_does_not_match_is_left_even_when_the_file_exists() {
        let project = scratch("shape");
        let ade = project.join(".ade");
        std::fs::create_dir_all(ade.join("results")).unwrap();
        let wrong = ade.join("results/data.json");
        std::fs::write(&wrong, b"x").unwrap();
        assert_eq!(prune_files(&[wrong.clone()]), 0);
        assert!(wrong.exists());
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn the_command_answers_to_the_main_window_only() {
        let source = include_str!("ade_prune.rs");
        let body = &source[source.find("pub async fn ade_prune").unwrap()..];
        let first = body.lines().nth(1).unwrap().trim();
        assert_eq!(first, "main_only(window.label())?;");
    }
}
