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

/// The folder ADE makes beside a project for its sessions' worktrees: `<project>-worktrees`, a sibling, never inside it.
pub fn container_of(root: &Path) -> Option<std::path::PathBuf> {
    let name = root.file_name()?.to_string_lossy().into_owned();
    Some(root.with_file_name(format!("{name}-worktrees")))
}

/// Removes the project's `-worktrees` folder when nothing is left in it. `remove_dir` refuses a folder that is not empty, which is the check,
/// so a worktree that is still there (or anything else of the user's) keeps it. A link is not followed.
pub fn remove_empty_container(root: &Path) -> bool {
    let Some(container) = container_of(root) else { return false };
    match std::fs::symlink_metadata(&container) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir(&container).is_ok(),
        _ => false,
    }
}

/// Removes the empty `<project>-worktrees` folder beside an open project: whether it was removed. Only for the root of a project that is
/// open (not a folder inside one), since the folder it names is outside the project and is not otherwise in the window's reach.
#[tauri::command]
pub async fn ade_container_remove(window: tauri::WebviewWindow, roots: tauri::State<'_, WriteRoots>, root: String) -> Result<bool, String> {
    main_only(window.label())?;
    let resolved = crate::within_roots(&roots, &root)?;
    let is_a_root = roots.0.lock().map_err(|_| "radici bloccate")?.iter().any(|open| *open == resolved);
    if !is_a_root {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || remove_empty_container(&resolved)).await.map_err(|e| e.to_string())
}

/// What a worktree folder weighs, for the panel that lists them. Only a folder inside the project's own `-worktrees` folder, and only for the
/// root of an open project: the folder is outside the project, so it is the one place this door reads.
pub fn worktree_bytes(root: &Path, worktree: &Path) -> u64 {
    let Some(container) = container_of(root) else { return 0 };
    let (Ok(container), Ok(worktree)) = (container.canonicalize(), worktree.canonicalize()) else { return 0 };
    if worktree == container || !worktree.starts_with(&container) {
        return 0;
    }
    crate::tts::dir_bytes(&worktree)
}

#[tauri::command]
pub async fn ade_worktree_bytes(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WriteRoots>,
    root: String,
    worktree: String,
) -> Result<u64, String> {
    main_only(window.label())?;
    let resolved = crate::within_roots(&roots, &root)?;
    let is_a_root = roots.0.lock().map_err(|_| "radici bloccate")?.iter().any(|open| *open == resolved);
    if !is_a_root {
        return Ok(0);
    }
    tauri::async_runtime::spawn_blocking(move || worktree_bytes(&resolved, Path::new(&worktree))).await.map_err(|e| e.to_string())
}

/// The three folders of `.ade/` that a session writes into, relative to `.ade/`.
const SESSION_FOLDERS: [&[&str]; 3] = [&["results"], &["browser"], &["design", "note"]];

/// The first name beside `wanted` that is free in `dir`: `a.md`, then `a-2.md`, `a-3.md`... Both files are kept, never one over the other.
fn free_name(dir: &Path, wanted: &std::ffi::OsStr) -> std::path::PathBuf {
    let first = dir.join(wanted);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let name = Path::new(wanted);
    let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{extension}")))
        .find(|candidate| std::fs::symlink_metadata(candidate).is_err())
        .unwrap_or(first)
}

/// Moves a file, by rename when the disk allows and by copy and remove when it does not. Nothing is removed from the source before the copy
/// is whole.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| format!("{}: {e}", from.display()))?;
    std::fs::remove_file(from).map_err(|e| format!("{}: {e}", from.display()))
}

/// Saves what a session wrote under its worktree's `.ade/` before the worktree goes. `.ade/` is out of git's sight (`.git/info/exclude`), so
/// `git worktree remove` takes it without a word: a sub-agent's result would go with its tab. Its `results/`, `browser/` and `design/note/`
/// files are moved into the same folders of the project's own `.ade/`; a name already there is kept and the new one gets a number. Plain
/// files only, nothing followed, and only from a worktree inside the project's own `-worktrees` folder. The number of files moved; an error
/// when one cannot be, and the caller then keeps the worktree.
pub fn rescue_reports(root: &Path, worktree: &Path) -> Result<u32, String> {
    let container = container_of(root).ok_or("progetto senza nome")?.canonicalize().map_err(|e| e.to_string())?;
    let tree = worktree.canonicalize().map_err(|e| e.to_string())?;
    if tree == container || !tree.starts_with(&container) {
        return Err("la worktree non è nella cartella del progetto".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut moved = 0;
    for folder in SESSION_FOLDERS {
        let mut from = tree.join(".ade");
        let mut into = root.join(".ade");
        for part in folder {
            from.push(part);
            into.push(part);
        }
        // A folder that is not there has nothing to save; one that is a link is not followed.
        match std::fs::symlink_metadata(&from) {
            Ok(meta) if meta.is_dir() => {}
            _ => continue,
        }
        let entries: Vec<_> = std::fs::read_dir(&from).map_err(|e| format!("{}: {e}", from.display()))?.flatten().collect();
        let files: Vec<_> = entries
            .iter()
            .filter(|entry| std::fs::symlink_metadata(entry.path()).map(|m| m.file_type().is_file()).unwrap_or(false))
            .collect();
        if files.is_empty() {
            continue;
        }
        std::fs::create_dir_all(&into).map_err(|e| format!("{}: {e}", into.display()))?;
        // `.ade/` could be a link out of the project; what is saved must land inside it.
        if !into.canonicalize().map_err(|e| e.to_string())?.starts_with(&root) {
            return Err(format!("{} esce dal progetto", into.display()));
        }
        for entry in files {
            move_file(&entry.path(), &free_name(&into, &entry.file_name()))?;
            moved += 1;
        }
    }
    Ok(moved)
}

/// Saves a session's results, captures and design notes from its worktree into the project's `.ade/` before the worktree is removed. Only for
/// the root of an open project; an error (including «not a root») means the caller keeps the worktree.
#[tauri::command]
pub async fn ade_worktree_rescue(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WriteRoots>,
    root: String,
    worktree: String,
) -> Result<u32, String> {
    main_only(window.label())?;
    let resolved = crate::within_roots(&roots, &root)?;
    let is_a_root = roots.0.lock().map_err(|_| "radici bloccate")?.iter().any(|open| *open == resolved);
    if !is_a_root {
        return Err("il progetto non è aperto".into());
    }
    tauri::async_runtime::spawn_blocking(move || rescue_reports(&resolved, Path::new(&worktree))).await.map_err(|e| e.to_string())?
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
    #[test]
    fn the_container_is_the_sibling_named_after_the_project() {
        assert_eq!(container_of(&sep("/work/app")), Some(sep("/work/app-worktrees")));
        assert_eq!(container_of(&sep("/work/app/")), Some(sep("/work/app-worktrees")));
        assert_eq!(container_of(&sep("/")), None);
    }

    #[test]
    fn an_empty_container_is_removed_and_the_project_is_not_touched() {
        let parent = scratch("container-empty");
        let project = parent.join("app");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("main.rs"), b"fn main() {}").unwrap();
        let container = parent.join("app-worktrees");
        std::fs::create_dir_all(&container).unwrap();
        assert!(remove_empty_container(&project));
        assert!(!container.exists());
        assert!(project.join("main.rs").is_file());
        // Again: there is nothing to remove, and it is not an error.
        assert!(!remove_empty_container(&project));
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_container_that_still_holds_a_worktree_or_anything_else_stays() {
        let parent = scratch("container-full");
        let project = parent.join("app");
        std::fs::create_dir_all(&project).unwrap();
        let container = parent.join("app-worktrees");
        std::fs::create_dir_all(container.join("fix")).unwrap();
        assert!(!remove_empty_container(&project));
        assert!(container.join("fix").is_dir());
        std::fs::remove_dir(container.join("fix")).unwrap();
        std::fs::write(container.join("notes.txt"), b"mine").unwrap();
        assert!(!remove_empty_container(&project));
        assert!(container.join("notes.txt").is_file());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_file_with_the_name_of_the_container_is_not_removed() {
        let parent = scratch("container-file");
        let project = parent.join("app");
        std::fs::create_dir_all(&project).unwrap();
        let odd = parent.join("app-worktrees");
        std::fs::write(&odd, b"a file").unwrap();
        assert!(!remove_empty_container(&project));
        assert!(odd.is_file());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn the_container_command_answers_to_the_main_window_and_only_for_the_root_of_an_open_project() {
        let source = include_str!("ade_prune.rs");
        let body = &source[source.find("pub async fn ade_container_remove").unwrap()..];
        assert_eq!(body.lines().nth(1).unwrap().trim(), "main_only(window.label())?;");
        assert!(body.contains("is_a_root"));
    }
    #[test]
    fn a_worktrees_weight_is_counted_only_inside_the_projects_container() {
        let parent = scratch("worktree-bytes");
        let project = parent.join("app");
        std::fs::create_dir_all(&project).unwrap();
        let tree = parent.join("app-worktrees").join("fix");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        std::fs::write(tree.join("src/a.rs"), vec![0u8; 700]).unwrap();
        std::fs::write(tree.join("b.txt"), vec![0u8; 30]).unwrap();
        assert_eq!(worktree_bytes(&project, &tree), 730);
        // The container itself, the project, and a folder elsewhere are none of this door's business.
        assert_eq!(worktree_bytes(&project, &parent.join("app-worktrees")), 0);
        assert_eq!(worktree_bytes(&project, &project), 0);
        std::fs::write(project.join("big.bin"), vec![0u8; 5000]).unwrap();
        assert_eq!(worktree_bytes(&project, &project.join("big.bin")), 0);
        let elsewhere = parent.join("other");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("x"), vec![0u8; 100]).unwrap();
        assert_eq!(worktree_bytes(&project, &elsewhere), 0);
        // A path that climbs out of the container does not count what it reaches.
        assert_eq!(worktree_bytes(&project, &tree.join("..").join("..").join("other")), 0);
        assert_eq!(worktree_bytes(&project, &parent.join("app-worktrees").join("missing")), 0);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn the_worktree_weight_command_answers_to_the_main_window_and_only_for_the_root_of_an_open_project() {
        let source = include_str!("ade_prune.rs");
        let body = &source[source.find("pub async fn ade_worktree_bytes").unwrap()..];
        assert_eq!(body.lines().nth(6).unwrap().trim(), "main_only(window.label())?;");
        assert!(body.contains("is_a_root"));
    }

    /// A project `app` with its `.ade/` and a worktree `app-worktrees/fix` that has written into the three folders.
    fn project_with_worktree(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let parent = scratch(name);
        let project = parent.join("app");
        let tree = parent.join("app-worktrees").join("fix");
        for folder in ["results", "browser", "design/note"] {
            std::fs::create_dir_all(tree.join(".ade").join(folder)).unwrap();
        }
        std::fs::create_dir_all(&project).unwrap();
        (parent, project, tree)
    }

    #[test]
    fn a_sessions_results_captures_and_notes_are_moved_into_the_project_before_the_worktree_goes() {
        let (parent, project, tree) = project_with_worktree("rescue");
        std::fs::write(tree.join(".ade/results/r.md"), "report").unwrap();
        std::fs::write(tree.join(".ade/browser/20260901-a.png"), vec![1u8; 10]).unwrap();
        std::fs::write(tree.join(".ade/browser/20260901-a.md"), "note").unwrap();
        std::fs::write(tree.join(".ade/design/note/n.md"), "design note").unwrap();
        assert_eq!(rescue_reports(&project, &tree), Ok(4));
        assert_eq!(std::fs::read_to_string(project.join(".ade/results/r.md")).unwrap(), "report");
        assert_eq!(std::fs::read(project.join(".ade/browser/20260901-a.png")).unwrap().len(), 10);
        assert_eq!(std::fs::read_to_string(project.join(".ade/design/note/n.md")).unwrap(), "design note");
        // Nothing is left behind to be taken with the folder.
        assert!(!tree.join(".ade/results/r.md").exists());
        // A second time there is nothing to move.
        assert_eq!(rescue_reports(&project, &tree), Ok(0));
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_name_the_project_already_has_is_kept_and_the_new_file_gets_a_number() {
        let (parent, project, tree) = project_with_worktree("rescue-clash");
        std::fs::create_dir_all(project.join(".ade/results")).unwrap();
        std::fs::write(project.join(".ade/results/r.md"), "old").unwrap();
        std::fs::write(project.join(".ade/results/r-2.md"), "older").unwrap();
        std::fs::write(tree.join(".ade/results/r.md"), "new").unwrap();
        assert_eq!(rescue_reports(&project, &tree), Ok(1));
        assert_eq!(std::fs::read_to_string(project.join(".ade/results/r.md")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(project.join(".ade/results/r-2.md")).unwrap(), "older");
        assert_eq!(std::fs::read_to_string(project.join(".ade/results/r-3.md")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn only_those_three_folders_and_only_plain_files_are_moved() {
        let (parent, project, tree) = project_with_worktree("rescue-scope");
        std::fs::write(tree.join(".ade/decisions.jsonl"), "x").unwrap();
        std::fs::create_dir_all(tree.join(".ade/design/1")).unwrap();
        std::fs::write(tree.join(".ade/design/1/a.html"), "x").unwrap();
        std::fs::create_dir_all(tree.join(".ade/results/sub")).unwrap();
        std::fs::write(tree.join(".ade/results/sub/deep.md"), "x").unwrap();
        std::fs::write(tree.join("src.txt"), "x").unwrap();
        assert_eq!(rescue_reports(&project, &tree), Ok(0));
        assert!(!project.join(".ade/decisions.jsonl").exists());
        assert!(!project.join(".ade/results/sub").exists());
        assert!(tree.join(".ade/results/sub/deep.md").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_folder_that_is_not_a_worktree_of_this_project_is_refused_and_nothing_moves() {
        let (parent, project, tree) = project_with_worktree("rescue-refuse");
        std::fs::write(tree.join(".ade/results/r.md"), "report").unwrap();
        // The container itself, the project, a folder elsewhere and one that does not exist.
        assert!(rescue_reports(&project, &parent.join("app-worktrees")).is_err());
        let elsewhere = parent.join("other");
        std::fs::create_dir_all(elsewhere.join(".ade/results")).unwrap();
        std::fs::write(elsewhere.join(".ade/results/x.md"), "x").unwrap();
        assert!(rescue_reports(&project, &elsewhere).is_err());
        assert!(elsewhere.join(".ade/results/x.md").exists());
        assert!(rescue_reports(&project, &parent.join("app-worktrees").join("missing")).is_err());
        assert!(!project.join(".ade/results/r.md").exists());
        assert!(tree.join(".ade/results/r.md").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_project_that_cannot_take_the_files_is_an_error_and_the_source_stays() {
        let (parent, project, tree) = project_with_worktree("rescue-fails");
        std::fs::write(tree.join(".ade/results/r.md"), "report").unwrap();
        // `.ade` in the project is a plain file, so `.ade/results` cannot be made there.
        std::fs::write(project.join(".ade"), "not a folder").unwrap();
        assert!(rescue_reports(&project, &tree).is_err());
        assert!(tree.join(".ade/results/r.md").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn the_rescue_command_answers_to_the_main_window_and_refuses_what_is_not_the_root_of_an_open_project() {
        let source = include_str!("ade_prune.rs");
        let body = &source[source.find("pub async fn ade_worktree_rescue").unwrap()..];
        assert_eq!(body.lines().nth(6).unwrap().trim(), "main_only(window.label())?;");
        // Not a root is an error, not a zero: the caller keeps the worktree.
        assert!(body.contains("return Err(\"il progetto non è aperto\".into())"));
    }
}
