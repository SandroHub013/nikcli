//! Serving a project's own media files to the window.
//!
//! The video panel plays a file that is on disk, and a `<video>` element cannot
//! be handed a path: it needs a URL, and it needs that URL to answer range
//! requests, because seeking is the whole point of a player. Reading the file
//! into a blob would work for a clip and fail for a screen recording — the
//! files this panel is for are the ones a session just produced, and those are
//! measured in hundreds of megabytes.
//!
//! So this registers a scheme of its own. Tauri's built-in asset protocol would
//! do the same job, but it comes with a second scope to configure and keep in
//! step with the one the window already has; here the answer to "may this file
//! be read" is the set of roots the user has actually opened, which is the
//! registry `allow_write_root` already maintains. One rule, one place.
//!
//! The confinement is not decoration. Anything running in the browser pane's
//! frame can reach a URL, so a scheme that served an arbitrary path would be a
//! way to read the user's whole disk through an `<video>` tag.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};

/// The scheme name. Reachable as `ade-media://localhost/<path>`, which Windows
/// rewrites to `http://ade-media.localhost/<path>` — both arrive here.
pub const SCHEME: &str = "ade-media";

/// How much of a file one range request may return.
///
/// A `<video>` asks for what it needs and asks again; answering an open-ended
/// range with the whole file would put a 700 MB recording through the IPC
/// boundary in one piece the first time the element probes it.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// Builds the URL the frontend puts in `<video src>`.
///
/// Nothing in Rust calls it, and that is the point: the page builds the URL
/// itself in `video/video.ts`, and this is the half the tests below check the
/// encoding against. A wrong encoding is a silent 404 inside a media element
/// — a player that never starts, with nothing on any console — so the two
/// implementations are held to the same cases rather than to a comment.
#[cfg_attr(not(test), allow(dead_code))]
pub fn url_for(path: &str) -> String {
    format!("{SCHEME}://localhost/{}", urlencoding(path))
}

#[cfg_attr(not(test), allow(dead_code))]
fn urlencoding(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn urldecode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The content type, from the extension: the video panel's, and a design preview's page.
fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        // A design variant's page, loaded as a frame's `src` (design-preview.tsx).
        "html" | "htm" => "text/html; charset=utf-8",
        // The file panes' viewers (editor/file-view.tsx). An SVG served as
        // octet-stream with nosniff is not drawn at all.
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "aac" => "audio/aac",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "oga" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// Parses `bytes=start-end`, returning the start and the inclusive end.
///
/// Only the single-range form, which is the only one a media element sends.
/// An open-ended range is capped rather than refused, so the element gets its
/// first bytes immediately and asks for the rest as it plays.
fn parse_range(header: &str, length: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (from, to) = spec.split_once('-')?;

    if from.is_empty() {
        // `bytes=-500`: the last 500 bytes. MP4 metadata at the tail is read
        // this way, so it is not a theoretical form.
        let count: u64 = to.parse().ok()?;
        if count == 0 || length == 0 {
            return None;
        }
        // The last bytes asked for, at most one chunk of them: `bytes=-4000000000` must not allocate the file.
        let start = length.saturating_sub(count.min(MAX_CHUNK));
        return Some((start, length - 1));
    }

    let start: u64 = from.parse().ok()?;
    if start >= length {
        return None;
    }
    let end = if to.is_empty() {
        length - 1
    } else {
        to.parse::<u64>().ok()?.min(length - 1)
    };
    if end < start {
        return None;
    }
    Some((start, start.max(end).min(start + MAX_CHUNK - 1)))
}

/// Whether `path` sits inside one of the roots the user has opened.
///
/// `roots` are canonical; `opened` are the same roots as the user opened
/// them, before a junction, a symlink or a mapped drive was followed.
fn within(roots: &[PathBuf], opened: &[String], path: &Path) -> bool {
    within_with(roots, opened, path, |path| path.canonicalize().ok())
}

/*
 * The same, with the resolution handed in so a test can see whether it ran.
 *
 * Resolving is not harmless (audit 0.7.7, C2-2). `canonicalize` on
 * `\\host\x` — which `%5C%5Chost%5Cx` decodes to — opens a connection to
 * that host: Windows sends the user's NTLM hash to it, and this handler,
 * which is synchronous, waits for the network. So nothing is resolved until
 * the text alone says the path is local and inside a root:
 *
 * - two separators at the start, in any mix, are UNC or a device path
 *   (`\\host`, `//host`, `\\?\`, `\\.\`) and are refused outright;
 * - the path must then begin with one of the roots, compared as text,
 *   separators unified and case ignored, on a component boundary. A root
 *   counts in either of its forms, canonical or as it was opened: the URL
 *   carries the path as opened, so a project under a junction (`C:\dev`
 *   pointing to `D:\src`) or on a mapped drive (`Z:`, whose canonical form
 *   is `\\?\UNC\server\…`) matches only the second.
 *
 * Only then the resolution, and the check that was here before: `..` and
 * links can still lead out, and that is what it catches.
 */
fn within_with(
    roots: &[PathBuf],
    opened: &[String],
    path: &Path,
    resolve: impl Fn(&Path) -> Option<PathBuf>,
) -> bool {
    let text = path.to_string_lossy();
    let mut start = text.chars();
    let is_separator = |c: Option<char>| matches!(c, Some('/') | Some('\\'));
    if is_separator(start.next()) && is_separator(start.next()) {
        return false;
    }
    let wanted = comparable(&text);
    let canonical = roots.iter().map(|root| comparable(&root_text(root)));
    let as_opened = opened.iter().map(|root| comparable(root));
    if !canonical.chain(as_opened).any(|root| begins_with_root(&wanted, &root)) {
        return false;
    }
    let Some(resolved) = resolve(path) else {
        return false;
    };
    roots.iter().any(|root| resolved.starts_with(root))
}

/// A root as the user would write it: without the `\\?\` a canonical Windows path carries.
fn root_text(root: &Path) -> String {
    let text = root.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        // A share, `\\?\UNC\host\x`: its paths are refused above anyway.
        Some(rest) if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(r"UNC\") => format!(r"\\{}", &rest[4..]),
        Some(rest) => rest.to_owned(),
        None => text.into_owned(),
    }
}

/// Forward slashes, lower case, no trailing separator: two spellings of one path compare equal.
fn comparable(text: &str) -> String {
    let unified = text.replace('\\', "/").to_lowercase();
    match unified.trim_end_matches('/') {
        "" => unified,
        trimmed => trimmed.to_owned(),
    }
}

/// Whether `path` is `root` or lies under it, a whole component at a time: `C:/p` is not under `C:/pro`.
fn begins_with_root(path: &str, root: &str) -> bool {
    match path.strip_prefix(root) {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || root.ends_with('/'),
        None => false,
    }
}

/*
 * What every answer carries, whatever it is (audit 0.7.7, C1).
 *
 * The scheme serves HTML (a design variant's page) and SVG (the file panes'
 * viewer), and both can run script. Opened as a document — the browser pane
 * navigated to it, a link followed — such a file ran with ade-media's own
 * origin, and from there `fetch` read every file of every open project, a
 * `.env` included. The sandbox takes the origin away: an opaque one, whose
 * requests carry no `Origin` ADE answers. Scripts and forms stay, because a
 * design page is a page; Design already frames it without
 * `allow-same-origin`, so for it nothing changes. `nosniff` keeps a file
 * served as one type from being run as another.
 *
 * An `<img>`, `<video>` or `<audio>` is not a document: the CSP does not
 * apply to it, and the viewers and the markdown preview read as before.
 */
const HARDENING: [(&str, &str); 2] = [
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Security-Policy", "sandbox allow-scripts allow-forms"),
];

fn hardened(mut builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    for (name, value) in HARDENING {
        builder = builder.header(name, value);
    }
    builder
}

/*
 * A design sheet's page, under `.ade/design/` (the design sheet, piece 1).
 *
 * The same sandbox, and nothing from outside: an agent writes the page, and
 * "everything in one file, no CDN, no web font, no fetch" is a rule only if
 * something holds it. This does, in the same header, so both halves apply. An
 * image may still come from the same scheme, since an agent may put a
 * screenshot beside its sheet.
 *
 * `default-src` covers neither where a form is sent nor what a `<base>` makes
 * relative links mean (review of piece 1, BASSO 1): both are shut apart.
 */
const DESIGN_SHEET_CSP: &str = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; \
style-src 'unsafe-inline'; img-src data: http://ade-media.localhost ade-media://localhost; font-src data:; \
form-action 'none'; base-uri 'none'";

/// Whether a path is a design sheet's: inside some `.ade/design/` folder.
fn is_design_sheet(path: &Path) -> bool {
    comparable(&path.to_string_lossy()).contains("/.ade/design/")
}

/// What a sheet answer carries: the hardening, with the sheet's policy in place of the plain sandbox.
fn hardened_for(path: &Path, builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    if !is_design_sheet(path) {
        return hardened(builder);
    }
    builder
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", DESIGN_SHEET_CSP)
}

/*
 * The file `ade-msg design <file>` names, checked before a pane shows it.
 *
 * A session asks ADE to open a page it wrote. What it may name is narrow: an
 * `.html` inside `.ade/design/` of the folder it works in, inside a folder
 * ADE already serves. Every refusal says why, and goes back to the session.
 * The order matters as it does in `within_with`: the text is judged before
 * anything is resolved, so a UNC path never reaches the network.
 *
 * The answer is the path as the session's folder spells it, not the
 * resolved one: the frame's URL is checked again by `within` when it loads,
 * and that check knows a root in the form it was opened.
 */
pub fn design_sheet(roots: &[PathBuf], opened: &[String], path: &str, cwd: &str) -> Result<PathBuf, String> {
    design_sheet_with(roots, opened, path, cwd, |path| path.canonicalize().ok())
}

fn design_sheet_with(
    roots: &[PathBuf],
    opened: &[String],
    path: &str,
    cwd: &str,
    resolve: impl Fn(&Path) -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("manca il file: ade-msg design .ade/design/<nome>.html".to_string());
    }
    if cwd.trim().is_empty() {
        return Err("non so in che cartella lavora la sessione".to_string());
    }
    let is_html = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if !is_html {
        return Err(format!("{path} non è una pagina .html"));
    }
    if path.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("{path}: niente `..`, il foglio sta in .ade/design/ della tua cartella"));
    }
    let joined = if Path::new(path).is_absolute() { PathBuf::from(path) } else { Path::new(cwd.trim()).join(path) };
    let design_dir = Path::new(cwd.trim()).join(".ade").join("design");
    // As text first, in the session's own spelling: nothing is resolved for a path that is plainly elsewhere.
    if !begins_with_root(&comparable(&joined.to_string_lossy()), &comparable(&design_dir.to_string_lossy())) {
        // Said in the folder's own spelling: a join put `\` after a cwd written with `/`.
        let folder = cwd.trim().trim_end_matches(['/', '\\']);
        let sep = if folder.contains('\\') { '\\' } else { '/' };
        return Err(format!("{path} non sta in .ade/design/ della tua cartella ({folder}{sep}.ade{sep}design)"));
    }
    if !within_with(roots, opened, &joined, &resolve) {
        return Err(format!(
            "{path} è fuori dalle cartelle aperte in ADE, o non esiste: il pannello non lo potrebbe mostrare"
        ));
    }
    // A link inside `.ade/design/` that leads out is caught here: both sides resolved.
    let (Some(real), Some(real_dir)) = (resolve(&joined), resolve(&design_dir)) else {
        return Err(format!("{path} non esiste"));
    };
    if !real.starts_with(&real_dir) {
        return Err(format!("{path} porta fuori da .ade/design/ (un collegamento)"));
    }
    Ok(joined)
}

/// The file in a proposal's folder that describes it.
pub const PROPOSAL_FILE: &str = "proposta.json";
const MAX_PROPOSAL_BYTES: u64 = 40 * 1024;
const MAX_VARIANT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_VARIANTS: usize = 6;
/// The sides `<meta name="ade-size">` may give, as the card shows them (`preview-plan.ts`).
const SIDES: std::ops::RangeInclusive<u32> = 120..=1600;

/// A proposal `ade-msg design proponi` names, read and checked: what the page builds the event from.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct DesignProposal {
    /// The proposal's key: the folder's name.
    pub k: String,
    /// The folder, in the spelling the session's folder gave it.
    pub folder: String,
    /// `proposta.json` as written.
    pub proposal: String,
    /// Each variant's page, in the order of `variants`.
    pub files: Vec<String>,
}

/*
 * The folder `ade-msg design proponi <cartella>` names, and what is in it.
 *
 * The same rule as a sheet's, narrower: the folder is `.ade/design/<k>` of
 * the sender's project, one level and no deeper, `<k>` a key the register
 * takes. Its text is judged before anything is resolved — a UNC or device
 * path never reaches the network, `..` never gets the chance to climb — and
 * only then is it resolved, and every file in it again, so a link that leads
 * out is caught whichever of them it is.
 *
 * Each page is read here, where it is already open, rather than shipped to
 * the page: what a variant may not do (load from the network, declare a size
 * the card cannot show) is said with the file's name and the reason.
 */
pub fn design_proposal(
    roots: &[PathBuf],
    opened: &[String],
    folder: &str,
    cwd: &str,
    project: &str,
) -> Result<DesignProposal, String> {
    design_proposal_with(roots, opened, folder, cwd, project, |path| path.canonicalize().ok())
}

fn design_proposal_with(
    roots: &[PathBuf],
    opened: &[String],
    folder: &str,
    cwd: &str,
    project: &str,
    resolve: impl Fn(&Path) -> Option<PathBuf>,
) -> Result<DesignProposal, String> {
    let folder = folder.trim();
    let (cwd, project) = (cwd.trim(), project.trim());
    let usage = "ade-msg design proponi .ade/design/<chiave>";
    if folder.is_empty() {
        return Err(format!("manca la cartella: {usage}"));
    }
    if project.is_empty() {
        return Err("non so di che progetto è la sessione: la proposta va nel suo .ade/design/".to_string());
    }
    for (what, text) in [("la cartella", folder), ("la cartella della sessione", cwd), ("il progetto", project)] {
        if let Some(why) = unsafe_path_text(text) {
            return Err(format!("{folder}: {what} {why}; la proposta sta in .ade/design/<chiave> del tuo progetto"));
        }
    }
    let joined = if Path::new(folder).is_absolute() {
        PathBuf::from(folder)
    } else if cwd.is_empty() {
        return Err(format!("{folder}: non so in che cartella lavori, dammi il percorso intero"));
    } else {
        Path::new(cwd).join(folder)
    };
    let design_dir = Path::new(project).join(".ade").join("design");
    let spelled = || {
        let root = project.trim_end_matches(['/', '\\']);
        let sep = if root.contains('\\') { '\\' } else { '/' };
        format!("{root}{sep}.ade{sep}design{sep}<chiave>")
    };
    // As text, one component under `.ade/design/` of the project: nothing is resolved for a folder elsewhere.
    let wanted = comparable(&joined.to_string_lossy());
    let rest = wanted.strip_prefix(&comparable(&design_dir.to_string_lossy())).unwrap_or("");
    let one_level = rest.len() > 1 && rest.starts_with('/') && !rest[1..].contains('/');
    if !one_level {
        return Err(format!("{folder} non è la cartella di una proposta del tuo progetto ({})", spelled()));
    }
    let k = joined
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    if !is_design_key(&k) {
        return Err(format!(
            "{folder}: «{k}» non è una chiave valida (lettere, cifre, . _ -, al massimo 40, la prima una lettera o una cifra)"
        ));
    }
    if !within_with(roots, opened, &joined, &resolve) {
        return Err(format!("{folder} è fuori dalle cartelle aperte in ADE, o non esiste"));
    }
    let (Some(real), Some(real_dir)) = (resolve(&joined), resolve(&design_dir)) else {
        return Err(format!("{folder} non esiste"));
    };
    if !real.starts_with(&real_dir) || real == real_dir {
        return Err(format!("{folder} porta fuori da .ade/design/ (un collegamento)"));
    }
    if !real.is_dir() {
        return Err(format!("{folder} non è una cartella"));
    }

    let proposal_bytes = read_inside(&real, PROPOSAL_FILE, MAX_PROPOSAL_BYTES, &resolve)?;
    let proposal = String::from_utf8(proposal_bytes).map_err(|_| format!("{PROPOSAL_FILE}: non è UTF-8"))?;
    let parsed: serde_json::Value = serde_json::from_str(proposal.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{PROPOSAL_FILE}: il json non si legge: {e}"))?;
    let Some(variants) = parsed.get("variants").and_then(|v| v.as_array()) else {
        return Err(format!("{PROPOSAL_FILE}: mancano le varianti (variants, da 1 a {MAX_VARIANTS})"));
    };
    if variants.is_empty() || variants.len() > MAX_VARIANTS {
        return Err(format!(
            "{PROPOSAL_FILE}: {} varianti, ne servono da 1 a {MAX_VARIANTS}",
            variants.len()
        ));
    }
    let mut files = Vec::with_capacity(variants.len());
    for (index, variant) in variants.iter().enumerate() {
        let n = index + 1;
        let Some(file) = variant.get("file").and_then(|f| f.as_str()).map(str::trim) else {
            return Err(format!("{PROPOSAL_FILE}: la variante {n} non ha file (per esempio \"{n}.html\")"));
        };
        if !is_page_name(file) {
            return Err(format!(
                "{PROPOSAL_FILE}: variante {n}, «{file}» non è un nome di pagina: solo lettere, cifre, . _ - e .html alla fine, nella cartella della proposta"
            ));
        }
        if files.iter().any(|seen: &String| seen.eq_ignore_ascii_case(file)) {
            return Err(format!("{PROPOSAL_FILE}: due varianti con la stessa pagina ({file}): una pagina per variante"));
        }
        let page = read_inside(&real, file, MAX_VARIANT_BYTES, &resolve)?;
        if let Some(why) = page_problem(&String::from_utf8_lossy(&page)) {
            return Err(format!("{file}: {why}"));
        }
        files.push(file.to_string());
    }
    Ok(DesignProposal { k, folder: joined.to_string_lossy().into_owned(), proposal, files })
}

/// Why a path's text is refused before anything is resolved: control characters, a UNC or device path, `..`.
fn unsafe_path_text(text: &str) -> Option<&'static str> {
    if text.chars().any(char::is_control) {
        return Some("contiene caratteri di controllo");
    }
    let mut start = text.chars();
    let is_separator = |c: Option<char>| matches!(c, Some('/') | Some('\\'));
    if (is_separator(start.next()) && is_separator(start.next())) || text.contains(r"\??\") || text.contains("/??/") {
        return Some("è un percorso di rete o di dispositivo");
    }
    if text.split(['/', '\\']).any(|part| part == "..") {
        return Some("contiene `..`");
    }
    None
}

/// The register's rule for a key (`isDesignKey`, `design/log.ts`).
fn is_design_key(k: &str) -> bool {
    let mut chars = k.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && k.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A variant's page name: `[A-Za-z0-9._-]+\.html`, never a path.
fn is_page_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.len() > ".html".len()
        && lower.ends_with(".html")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `dir/name` read whole, if it is a file inside `dir` once resolved and no larger than `max`.
fn read_inside(dir: &Path, name: &str, max: u64, resolve: &impl Fn(&Path) -> Option<PathBuf>) -> Result<Vec<u8>, String> {
    let Some(real) = resolve(&dir.join(name)) else {
        return Err(format!("{name} non c'è nella cartella della proposta"));
    };
    if !real.starts_with(dir) {
        return Err(format!("{name} porta fuori dalla cartella della proposta (un collegamento)"));
    }
    let meta = std::fs::metadata(&real).map_err(|e| format!("{name} non si legge: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{name} non è un file"));
    }
    if meta.len() > max {
        return Err(format!("{name} pesa {} KB, il massimo è {} KB", meta.len().div_ceil(1024), max / 1024));
    }
    std::fs::read(&real).map_err(|e| format!("{name} non si legge: {e}"))
}

/*
 * What a variant's page may not hold: anything loaded from the network, and
 * a size the card would not show.
 *
 * The CSP (`DESIGN_SHEET_CSP`) already blocks every load; this says so to
 * the session before the user sees a broken preview. It reads attributes and
 * CSS, not script: `xmlns="http://www.w3.org/2000/svg"` in an inline SVG is
 * a name, not a load, and is not refused.
 */
fn page_problem(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let line_of = |at: usize| html[..at].matches('\n').count() + 1;
    let outside = |value: &str| {
        let value = value.trim_start();
        value.starts_with("http:") || value.starts_with("https:") || value.starts_with("//")
    };
    let bytes = lower.as_bytes();
    let is_name = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    if let Some(at) = lower.find("@import") {
        return Some(format!("riga {}: @import, i fogli di stile vanno dentro la pagina", line_of(at)));
    }
    for attribute in ["src", "href", "srcset", "poster", "action", "data", "formaction"] {
        let mut from = 0;
        while let Some(found) = lower[from..].find(attribute) {
            let at = from + found;
            from = at + attribute.len();
            if at > 0 && is_name(bytes[at - 1]) {
                continue;
            }
            let after = lower[from..].trim_start();
            let Some(value) = after.strip_prefix('=') else { continue };
            let value = value.trim_start().trim_start_matches(['"', '\'']);
            let end = value.find(['"', '\'', '>']).unwrap_or(value.len());
            let hit = if attribute == "srcset" {
                value[..end].split(',').any(outside)
            } else {
                outside(&value[..end])
            };
            if hit {
                return Some(format!(
                    "riga {}: {attribute}= carica dalla rete; immagini come data: o SVG dentro la pagina, niente CDN",
                    line_of(at)
                ));
            }
        }
    }
    let mut from = 0;
    while let Some(found) = lower[from..].find("url(") {
        let at = from + found;
        from = at + 4;
        if outside(lower[from..].trim_start().trim_start_matches(['"', '\''])) {
            return Some(format!("riga {}: url( carica dalla rete; usa data: dentro la pagina", line_of(at)));
        }
    }
    meta_problem(&lower).map(|(at, why)| format!("riga {}: {why}", line_of(at)))
}

/*
 * The two `<meta>` a page may get wrong: a refresh, which takes the frame to
 * another page, and an `ade-size` the card would ignore (without one the
 * page shows at 360×240, which is allowed).
 */
fn meta_problem(lower: &str) -> Option<(usize, String)> {
    let said = "<meta name=\"ade-size\" content=\"LxA\">, lati da 120 a 1600 px";
    let mut from = 0;
    while let Some(found) = lower[from..].find("<meta") {
        let at = from + found;
        let tag = &lower[at..at + lower[at..].find('>').unwrap_or(lower.len() - at)];
        from = at + 5;
        if tag.contains("http-equiv") && tag.contains("refresh") {
            return Some((at, "meta refresh porta la pagina altrove".to_string()));
        }
        if !tag.contains("ade-size") {
            continue;
        }
        let Some(content) = tag.split("content").nth(1) else {
            return Some((at, format!("ade-size senza content: {said}")));
        };
        let value = content.trim_start().trim_start_matches('=').trim_start().trim_start_matches(['"', '\'']);
        let value = &value[..value.find(['"', '\'']).unwrap_or(value.len())];
        let mut sides = value.split(['x', '×']).map(|side| side.trim().parse::<u32>().ok());
        match (sides.next().flatten(), sides.next().flatten(), sides.next()) {
            (Some(w), Some(h), None) if SIDES.contains(&w) && SIDES.contains(&h) => {}
            _ => return Some((at, format!("ade-size «{value}» non va: {said}"))),
        }
    }
    None
}

fn deny(status: StatusCode) -> Response<Vec<u8>> {
    hardened(Response::builder())
        .status(status)
        .body(Vec::new())
        .expect("risposta statica")
}

/// Answers one request for a media file.
///
/// Split from the registration below so the parts that can be wrong — the
/// range arithmetic and the confinement — are reachable from a test.
///
/// `app_origin` is the origin of the page that asked, as the webview itself
/// reports it. A request whose `Origin` header matches it gets that origin
/// back as allowed, which is what lets the recording export draw a take into
/// a canvas and still record the canvas: a frame drawn without CORS leaves the
/// canvas unclean and `MediaRecorder` writes nothing.
///
/// Any other origin gets no CORS header at all. Not `null`: answering
/// `Access-Control-Allow-Origin: null` would let a sandboxed page without
/// `allow-same-origin` read the file. With `allow-same-origin` (S52) the
/// pane sends the site's own origin (`https://example.com`), which still
/// must not match ADE's window, so the same filter keeps the file out.
pub fn respond(roots: &[PathBuf], opened: &[String], request: &Request<Vec<u8>>, app_origin: Option<&str>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    if raw.is_empty() {
        return deny(StatusCode::BAD_REQUEST);
    }
    let path = PathBuf::from(urldecode(raw));

    if !within(roots, opened, &path) {
        // Not "not found": the file may well exist. It is outside every
        // project this window has opened, and that is the whole rule.
        return deny(StatusCode::FORBIDDEN);
    }
    let hardened = |builder| hardened_for(&path, builder);

    let Ok(mut file) = File::open(&path) else {
        return deny(StatusCode::NOT_FOUND);
    };
    let Ok(meta) = file.metadata() else {
        return deny(StatusCode::NOT_FOUND);
    };
    let length = meta.len();

    let allowed = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| *origin != "null" && Some(*origin) == app_origin);

    // An empty file has no byte to serve and no range to satisfy: `0 - 1` below would underflow and panic the
    // handler. It is a plain 200 with no body.
    if length == 0 {
        let mut response = hardened(Response::builder())
            .status(StatusCode::OK)
            .header("Content-Type", mime_of(&path))
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", "0")
            .header("Vary", "Origin");
        if let Some(origin) = allowed {
            response = response.header("Access-Control-Allow-Origin", origin);
        }
        return response
            .body(Vec::new())
            .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR));
    }

    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|header| parse_range(header, length));

    let (start, end) = match range {
        Some(pair) => pair,
        // No range header: hand over the first chunk and advertise that
        // ranges work, so the element knows it may seek.
        None => (0, length.saturating_sub(1).min(MAX_CHUNK - 1)),
    };

    if file.seek(SeekFrom::Start(start)).is_err() {
        return deny(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let count = (end - start + 1) as usize;
    let mut body = vec![0u8; count];
    let read = match file.read(&mut body) {
        Ok(read) => read,
        Err(_) => return deny(StatusCode::INTERNAL_SERVER_ERROR),
    };
    body.truncate(read);
    // The file shrank between `metadata` and `read`: nothing at that offset any more, and `read - 1` would underflow.
    if read == 0 {
        return hardened(Response::builder())
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{length}"))
            .body(Vec::new())
            .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR));
    }
    let last = start + read as u64 - 1;

    let mut response = hardened(Response::builder())
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime_of(&path))
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{last}/{length}"))
        .header("Content-Length", read.to_string())
        .header("Vary", "Origin");
    if let Some(origin) = allowed {
        response = response.header("Access-Control-Allow-Origin", origin);
    }
    response
        .body(body)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn request(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(uri);
        if let Some(value) = range {
            builder = builder.header("range", value);
        }
        builder.body(Vec::new()).expect("richiesta")
    }

    fn fixture(bytes: &[u8]) -> (tempdir::Dir, PathBuf) {
        let dir = tempdir::Dir::new("ade-media");
        let path = dir.path().join("clip.mp4");
        let mut file = File::create(&path).expect("file");
        file.write_all(bytes).expect("scrittura");
        (dir, path)
    }

    /// A temporary directory, without pulling in a crate for four lines.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new(tag: &str) -> Self {
                let base = std::env::temp_dir().join(format!(
                    "{tag}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&base).expect("cartella temporanea");
                Self(base)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// A project with `.ade/design/menu.html` in it, served as a root.
    fn sheet_project() -> (tempdir::Dir, PathBuf, Vec<PathBuf>) {
        let dir = tempdir::Dir::new("ade-design");
        let design = dir.path().join(".ade").join("design");
        std::fs::create_dir_all(&design).expect("cartella");
        std::fs::write(design.join("menu.html"), b"<p>ciao</p>").expect("foglio");
        std::fs::write(dir.path().join("fuori.html"), b"<p>no</p>").expect("fuori");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let cwd = dir.path().to_path_buf();
        (dir, cwd, roots)
    }

    #[test]
    fn a_sheet_in_the_sessions_design_folder_is_accepted_absolute_or_relative() {
        let (_dir, cwd, roots) = sheet_project();
        let cwd_text = cwd.to_string_lossy().into_owned();
        let absolute = cwd.join(".ade").join("design").join("menu.html");
        assert_eq!(design_sheet(&roots, &[], &absolute.to_string_lossy(), &cwd_text), Ok(absolute.clone()));
        assert_eq!(design_sheet(&roots, &[], ".ade/design/menu.html", &cwd_text), Ok(cwd.join(".ade/design/menu.html")));
    }

    #[test]
    fn a_sheet_is_refused_with_the_reason() {
        let (_dir, cwd, roots) = sheet_project();
        let cwd_text = cwd.to_string_lossy().into_owned();
        let refused = |path: &str| design_sheet(&roots, &[], path, &cwd_text).expect_err(path);
        assert!(refused(".ade/design/menu.txt").contains("non è una pagina .html"));
        assert!(refused(".ade/design/../../fuori.html").contains("niente `..`"));
        assert!(refused("fuori.html").contains("non sta in .ade/design/"));
        // The folder is said in the session's own spelling, with no `\` after a `/` (seen live in ADE Test).
        let slashed = cwd_text.replace('\\', "/");
        let said = design_sheet(&roots, &[], "fuori.html", &slashed).expect_err("slash");
        assert!(said.ends_with(&format!("({slashed}/.ade/design)")), "{said}");
        assert!(refused(".ade/design/manca.html").contains("non esiste"));
        // Another project's design folder, even an open one: not this session's.
        let other = tempdir::Dir::new("ade-design-altro");
        let theirs = other.path().join(".ade").join("design");
        std::fs::create_dir_all(&theirs).expect("cartella");
        std::fs::write(theirs.join("x.html"), b"x").expect("foglio");
        let both = vec![roots[0].clone(), other.path().canonicalize().expect("radice")];
        let err = design_sheet(&both, &[], &theirs.join("x.html").to_string_lossy(), &cwd_text).expect_err("altro");
        assert!(err.contains("non sta in .ade/design/"));
        // A folder ADE does not serve: the frame could not load it.
        assert!(design_sheet(&[], &[], ".ade/design/menu.html", &cwd_text).expect_err("radici").contains("fuori dalle cartelle"));
    }

    #[test]
    fn a_link_inside_the_design_folder_that_leads_out_is_refused() {
        let (_dir, cwd, roots) = sheet_project();
        let sheet = cwd.join(".ade").join("design").join("menu.html");
        let outside = cwd.join("fuori.html").canonicalize().expect("fuori");
        // `menu.html` resolving to a file outside `.ade/design/`, as a symbolic link would.
        let resolve = |path: &Path| {
            if path == sheet.as_path() {
                Some(outside.clone())
            } else {
                path.canonicalize().ok()
            }
        };
        let err = design_sheet_with(&roots, &[], &sheet.to_string_lossy(), &cwd.to_string_lossy(), resolve).expect_err("link");
        assert!(err.contains("porta fuori da .ade/design/"));
    }

    #[test]
    fn a_unc_sheet_is_refused_before_anything_is_resolved() {
        let resolved = std::cell::Cell::new(0);
        let resolve = |_: &Path| {
            resolved.set(resolved.get() + 1);
            None
        };
        let roots = vec![PathBuf::from(r"\\host\share")];
        let err = design_sheet_with(&roots, &[], r"\\host\share\.ade\design\a.html", r"\\host\share", resolve);
        assert!(err.is_err());
        assert_eq!(resolved.get(), 0);
    }

    const PAGE: &str = "<!doctype html><meta name=\"ade-size\" content=\"360x240\"><svg xmlns=\"http://www.w3.org/2000/svg\"></svg><img src=\"data:image/png;base64,AA\"><a href=\"#su\" data-src=\"x\">su</a>";

    /// A project with a proposal `.ade/design/DS-t2/` of two pages, served as a root.
    fn proposal_project() -> (tempdir::Dir, PathBuf, Vec<PathBuf>) {
        let dir = tempdir::Dir::new("ade-proposta");
        let folder = dir.path().join(".ade").join("design").join("DS-t2");
        std::fs::create_dir_all(&folder).expect("cartella");
        let json = r#"{"title":"Tasti","context":"Perché adesso.","variants":[{"name":"1 · Scura","file":"1.html"},{"name":"2 · Carta","file":"2.html"}]}"#;
        std::fs::write(folder.join(PROPOSAL_FILE), json).expect("proposta");
        std::fs::write(folder.join("1.html"), PAGE).expect("pagina");
        std::fs::write(folder.join("2.html"), PAGE).expect("pagina");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let project = dir.path().to_path_buf();
        (dir, project, roots)
    }

    fn propose(roots: &[PathBuf], folder: &str, cwd: &Path, project: &Path) -> Result<DesignProposal, String> {
        design_proposal(roots, &[], folder, &cwd.to_string_lossy(), &project.to_string_lossy())
    }

    #[test]
    fn a_proposal_in_the_projects_design_folder_is_read_relative_or_absolute() {
        let (_dir, project, roots) = proposal_project();
        let read = propose(&roots, ".ade/design/DS-t2", &project, &project).expect("relativa");
        assert_eq!(read.k, "DS-t2");
        assert_eq!(read.files, vec!["1.html".to_string(), "2.html".to_string()]);
        assert!(read.proposal.contains("\"Tasti\""));
        let absolute = project.join(".ade").join("design").join("DS-t2");
        let again = propose(&roots, &absolute.to_string_lossy(), Path::new(""), &project).expect("assoluta");
        assert_eq!(again.folder, absolute.to_string_lossy());
        // From a subfolder of the project, the way a session that did `cd` names it.
        let sub = project.join("src");
        std::fs::create_dir_all(&sub).expect("sotto");
        assert!(propose(&roots, r"..\.ade\design\DS-t2", &sub, &project).expect_err("..").contains("contiene `..`"));
        assert_eq!(propose(&roots, &absolute.to_string_lossy(), &sub, &project).expect("da sotto").k, "DS-t2");
    }

    #[test]
    fn a_proposal_outside_its_folder_is_refused_with_the_reason() {
        let (_dir, project, roots) = proposal_project();
        let refused = |folder: &str| propose(&roots, folder, &project, &project).expect_err(folder);
        assert!(refused("").contains("manca la cartella"));
        assert!(refused(".ade/DS-t2").contains("non è la cartella di una proposta"));
        assert!(refused(".ade/design").contains("non è la cartella di una proposta"));
        assert!(refused(".ade/design/DS-t2/dentro").contains("non è la cartella di una proposta"));
        assert!(refused(".ade/design/../design/DS-t2").contains("`..`"));
        assert!(refused(".ade/design/.nascosta").contains("non è una chiave valida"));
        assert!(refused(".ade/design/DS-manca").contains("non esiste"));
        assert!(refused(".ade/design/DS\u{1b}[2J").contains("caratteri di controllo"));
        // Another project's proposal folder, even an open one, is not this session's.
        let other = tempdir::Dir::new("ade-proposta-altra");
        let theirs = other.path().join(".ade").join("design").join("DS-t2");
        std::fs::create_dir_all(&theirs).expect("cartella");
        let both = vec![roots[0].clone(), other.path().canonicalize().expect("radice")];
        let err = propose(&both, &theirs.to_string_lossy(), &project, &project).expect_err("altro");
        assert!(err.contains("non è la cartella di una proposta"), "{err}");
        // A folder ADE does not serve: the frame could not load the pages.
        assert!(propose(&[], ".ade/design/DS-t2", &project, &project).expect_err("radici").contains("fuori dalle cartelle"));
    }

    #[test]
    fn a_unc_or_device_proposal_is_refused_before_anything_is_resolved() {
        let resolved = std::cell::Cell::new(0);
        let resolve = |_: &Path| {
            resolved.set(resolved.get() + 1);
            None
        };
        let roots = vec![PathBuf::from(r"\\host\share")];
        for (folder, cwd, project) in [
            (r"\\host\share\.ade\design\DS1", r"C:\p", r"C:\p"),
            (r"//host/share/.ade/design/DS1", r"C:\p", r"C:\p"),
            (r"\??\C:\p\.ade\design\DS1", r"C:\p", r"C:\p"),
            (r".ade\design\DS1", r"\\host\share", r"\\host\share"),
            (r"C:\p\.ade\design\DS1", r"C:\p", r"\\host\share"),
        ] {
            let err = design_proposal_with(&roots, &[], folder, cwd, project, &resolve).expect_err(folder);
            assert!(err.contains("percorso di rete o di dispositivo"), "{folder}: {err}");
        }
        assert_eq!(resolved.get(), 0);
    }

    #[test]
    fn a_link_out_of_the_proposal_folder_is_refused_folder_or_page() {
        let (_dir, project, roots) = proposal_project();
        let folder = project.join(".ade").join("design").join("DS-t2");
        let real_folder = folder.canonicalize().expect("cartella");
        // Inside the project, so ADE serves it: only the proposal's folder is left.
        std::fs::create_dir_all(project.join("fuori")).expect("fuori");
        let out = project.join("fuori").canonicalize().expect("fuori");
        std::fs::write(out.join("1.html"), PAGE).expect("fuori");
        let (p, f) = (project.to_string_lossy().into_owned(), folder.to_string_lossy().into_owned());

        // The folder itself a junction to somewhere else.
        let to_out = |path: &Path| if path == folder.as_path() { Some(out.clone()) } else { path.canonicalize().ok() };
        let err = design_proposal_with(&roots, &[], &f, &p, &p, to_out).expect_err("cartella");
        assert!(err.contains("porta fuori da .ade/design/"), "{err}");

        // One page a link to a file outside.
        let page = real_folder.join("1.html");
        let page_out = |path: &Path| if path == page.as_path() { Some(out.join("1.html")) } else { path.canonicalize().ok() };
        let err = design_proposal_with(&roots, &[], &f, &p, &p, page_out).expect_err("pagina");
        assert!(err.contains("1.html porta fuori dalla cartella della proposta"), "{err}");
    }

    #[test]
    fn a_proposal_past_its_limits_says_which_file_and_why() {
        let (_dir, project, roots) = proposal_project();
        let folder = project.join(".ade").join("design").join("DS-t2");
        let with = |json: &str| {
            std::fs::write(folder.join(PROPOSAL_FILE), json).expect("proposta");
            propose(&roots, ".ade/design/DS-t2", &project, &project).expect_err(json)
        };
        let variant = |file: &str| format!(r#"{{"name":"{file}","file":"{file}"}}"#);
        let seven = (1..=7).map(|n| variant(&format!("{n}.html"))).collect::<Vec<_>>().join(",");
        assert!(with(&format!(r#"{{"variants":[{seven}]}}"#)).contains("7 varianti, ne servono da 1 a 6"));
        assert!(with(r#"{"variants":[]}"#).contains("0 varianti"));
        assert!(with(r#"{"title":"x"}"#).contains("mancano le varianti"));
        assert!(with(r#"{"variants":[{"name":"a"}]}"#).contains("la variante 1 non ha file"));
        for bad in ["../1.html", "sotto/1.html", r"sotto\\1.html", "1.htm", ".html", "pagina 1.html"] {
            let err = with(&format!(r#"{{"variants":[{{"name":"a","file":"{bad}"}}]}}"#));
            assert!(err.contains("non è un nome di pagina"), "{bad}: {err}");
        }
        assert!(with(&format!("{{\"variants\":[{},{}]}}", variant("1.html"), variant("1.HTML"))).contains("stessa pagina"));
        assert!(with(&format!("{{\"variants\":[{}]}}", variant("9.html"))).contains("9.html non c'è"));
        assert!(with("{non json").contains("il json non si legge"));

        std::fs::write(folder.join("3.html"), "x".repeat(2 * 1024 * 1024 + 1)).expect("grande");
        assert!(with(&format!("{{\"variants\":[{}]}}", variant("3.html"))).contains("3.html pesa 2049 KB, il massimo è 2048 KB"));
        let big = format!(r#"{{"variants":[{}],"context":"{}"}}"#, variant("1.html"), "x".repeat(41 * 1024));
        assert!(with(&big).contains("proposta.json pesa"));
    }

    #[test]
    fn a_page_that_loads_from_the_network_is_refused_with_its_line() {
        let refused = |html: &str| page_problem(html).unwrap_or_else(|| panic!("accettata: {html}"));
        assert!(refused("<p>\n<img src=\"https://x.test/a.png\">").starts_with("riga 2: src="));
        assert!(refused("<link rel=stylesheet href='//cdn.test/a.css'>").contains("href="));
        assert!(refused("<img SRC = HTTP://x.test/a.png>").contains("src="));
        assert!(refused("<img srcset=\"a.png 1x, https://x.test/b.png 2x\">").contains("srcset="));
        assert!(refused("<svg><image xlink:href=\"https://x.test/a.svg\"/></svg>").contains("href="));
        assert!(refused("<style>body{background:url( 'https://x.test/a.png')}</style>").contains("url("));
        assert!(refused("<style>@import 'a.css';</style>").contains("@import"));
        assert!(refused("<script>img.src = \"http://x.test\"</script>").contains("src="));
        assert!(refused("<meta http-equiv=\"refresh\" content=\"0;url=https://x.test\">").contains("meta refresh"));
        assert!(refused("<meta name=\"ade-size\" content=\"100x50\">").contains("ade-size «100x50»"));
        assert!(refused("<meta name=ade-size content=\"360\">").contains("ade-size"));
        // What a page is allowed: inline SVG with its namespace, data: images, links inside the page, its size.
        assert_eq!(page_problem(PAGE), None);
        assert_eq!(page_problem("<meta name=\"ade-size\" content=\"1600×120\"><style>a{background:url(data:image/png;base64,AA)}</style>"), None);
        assert_eq!(page_problem("<p>senza misura</p>"), None);
    }

    #[test]
    fn a_sheet_is_served_with_its_own_policy_and_other_files_are_not() {
        let (_dir, cwd, roots) = sheet_project();
        let csp = |path: &Path| {
            respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), None)
                .headers()
                .get("Content-Security-Policy")
                .map(|value| value.to_str().unwrap_or("").to_string())
        };
        let sheet = csp(&cwd.join(".ade").join("design").join("menu.html")).expect("csp");
        assert!(sheet.starts_with("sandbox allow-scripts allow-forms;"));
        assert!(sheet.contains("default-src 'none'"));
        assert!(sheet.contains("font-src data:"));
        // A form sent out and a <base> pointing out are shut too: default-src does not reach them.
        assert!(sheet.contains("form-action 'none'"));
        assert!(sheet.contains("base-uri 'none'"));
        assert_eq!(csp(&cwd.join("fuori.html")).as_deref(), Some("sandbox allow-scripts allow-forms"));
    }

    #[test]
    fn serves_a_file_inside_an_open_project() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), None);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"0123456789");
        assert_eq!(
            response.headers().get("Content-Range").unwrap(),
            "bytes 0-9/10"
        );
    }

    #[test]
    fn a_file_outside_every_open_project_is_refused() {
        let (dir, path) = fixture(b"segreto");
        // A root that exists but does not contain the file.
        let other = tempdir::Dir::new("ade-media-altro");
        let roots = vec![other.path().canonicalize().expect("radice")];

        let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
        drop(dir);
    }

    #[test]
    fn with_no_project_open_nothing_is_served() {
        let (_dir, path) = fixture(b"x");
        let response = respond(&[], &[], &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_path_that_climbs_out_does_not_escape() {
        let (dir, _path) = fixture(b"x");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let outside = dir.path().join("..").join("..").join("windows");

        let response = respond(&roots, &[], &request(&url_for(&outside.to_string_lossy()), None), None);
        assert_ne!(response.status(), StatusCode::PARTIAL_CONTENT);
    }

    #[test]
    fn honours_a_range_the_element_asked_for() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &[],
            &request(&url_for(&path.to_string_lossy()), Some("bytes=3-5")),
            None,
        );

        assert_eq!(response.body(), b"345");
        assert_eq!(
            response.headers().get("Content-Range").unwrap(),
            "bytes 3-5/10"
        );
    }

    #[test]
    fn honours_a_suffix_range_which_is_how_mp4_metadata_is_read() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &[],
            &request(&url_for(&path.to_string_lossy()), Some("bytes=-3")),
            None,
        );
        assert_eq!(response.body(), b"789");
    }

    #[test]
    fn an_open_ended_range_is_answered_from_the_start_requested() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(
            &roots,
            &[],
            &request(&url_for(&path.to_string_lossy()), Some("bytes=7-")),
            None,
        );
        assert_eq!(response.body(), b"789");
    }

    #[test]
    fn a_path_with_spaces_and_accents_survives_the_url() {
        let dir = tempdir::Dir::new("ade-media-acc");
        let path = dir.path().join("clip finale è.mp4");
        std::fs::write(&path, b"ok").expect("scrittura");
        let roots = vec![dir.path().canonicalize().expect("radice")];

        let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), None);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"ok");
    }

    #[test]
    fn the_content_type_follows_the_extension() {
        assert_eq!(mime_of(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_of(Path::new("a.WEBM")), "video/webm");
        assert_eq!(mime_of(Path::new("a.mov")), "video/quicktime");
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_of(Path::new("a.png")), "image/png");
        assert_eq!(mime_of(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_of(Path::new("a.JPEG")), "image/jpeg");
        assert_eq!(mime_of(Path::new("a.gif")), "image/gif");
        assert_eq!(mime_of(Path::new("a.webp")), "image/webp");
        assert_eq!(mime_of(Path::new("a.ico")), "image/x-icon");
        assert_eq!(mime_of(Path::new("a.bmp")), "image/bmp");
        assert_eq!(mime_of(Path::new("a.avif")), "image/avif");
        assert_eq!(mime_of(Path::new("a.aac")), "audio/aac");
        assert_eq!(mime_of(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_of(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_of(Path::new("a.wav")), "audio/wav");
        assert_eq!(mime_of(Path::new("a.oga")), "audio/ogg");
        assert_eq!(mime_of(Path::new("a.opus")), "audio/ogg");
        assert_eq!(mime_of(Path::new("a.txt")), "application/octet-stream");
    }

    // Full review 2026-10-06, rust 12: an empty file used to panic the handler (`0 - 1` on a u64).
    #[test]
    fn an_empty_file_is_a_200_with_no_body_not_a_panic() {
        let (dir, path) = fixture(b"");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        for range in [None, Some("bytes=0-"), Some("bytes=-3")] {
            let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), range), None);
            assert_eq!(response.status(), StatusCode::OK, "range {range:?}");
            assert!(response.body().is_empty());
            assert_eq!(response.headers().get("Content-Length").unwrap(), "0");
        }
    }

    #[test]
    fn a_suffix_range_is_capped_to_one_chunk() {
        let length = 100 * 1024 * 1024;
        let (start, end) = parse_range("bytes=-99999999", length).expect("intervallo");
        assert_eq!(end, length - 1);
        assert_eq!(end - start + 1, MAX_CHUNK);
        // A small one is untouched.
        assert_eq!(parse_range("bytes=-500", length), Some((length - 500, length - 1)));
    }

    #[test]
    fn a_range_past_the_end_is_not_honoured() {
        assert_eq!(parse_range("bytes=20-30", 10), None);
        assert_eq!(parse_range("bytes=5-3", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("righe=0-1", 10), None);
    }

    #[test]
    fn a_huge_range_is_capped_rather_than_read_whole() {
        let length = 100 * 1024 * 1024;
        let (start, end) = parse_range("bytes=0-", length).expect("intervallo");
        assert_eq!(start, 0);
        assert_eq!(end - start + 1, MAX_CHUNK);
    }

    fn fixture_named(name: &str, bytes: &[u8]) -> (tempdir::Dir, PathBuf) {
        let dir = tempdir::Dir::new("ade-media");
        let path = dir.path().join(name);
        let mut file = File::create(&path).expect("file");
        file.write_all(bytes).expect("scrittura");
        (dir, path)
    }

    fn assert_hardened(response: &Response<Vec<u8>>) {
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        assert_eq!(header("X-Content-Type-Options").as_deref(), Some("nosniff"));
        assert_eq!(
            header("Content-Security-Policy").as_deref(),
            Some("sandbox allow-scripts allow-forms"),
        );
    }

    #[test]
    fn a_page_an_svg_and_any_file_are_served_sandboxed_and_unsniffed() {
        for (name, bytes, mime) in [
            ("variant.html", &b"<script>fetch('/C:/x/.env')</script>"[..], "text/html; charset=utf-8"),
            ("drawing.svg", &b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"[..], "image/svg+xml"),
            ("notes.bin", &b"plain bytes"[..], "application/octet-stream"),
        ] {
            let (dir, path) = fixture_named(name, bytes);
            let roots = vec![dir.path().canonicalize().unwrap()];
            let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), None);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{name}");
            assert_eq!(response.headers().get("Content-Type").unwrap(), mime, "{name}");
            assert_hardened(&response);
        }
    }

    #[test]
    fn a_refusal_is_sandboxed_too() {
        let (dir, _) = fixture(b"x");
        let roots = vec![dir.path().canonicalize().unwrap()];
        let response = respond(&roots, &[], &request("ade-media://localhost/C%3A%2FWindows%2Fwin.ini", None), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_hardened(&response);
    }

    /// A resolver that never touches the disk or the network, and says whether it was asked.
    fn counting() -> (std::cell::Cell<u32>, impl Fn(&std::cell::Cell<u32>, &Path) -> Option<PathBuf>) {
        (std::cell::Cell::new(0), |calls: &std::cell::Cell<u32>, path: &Path| {
            calls.set(calls.get() + 1);
            Some(path.to_path_buf())
        })
    }

    #[test]
    fn a_unc_path_is_refused_before_anything_resolves_it() {
        let roots = vec![PathBuf::from(r"\\?\C:\Users\me\project")];
        for raw in [
            r"%5C%5Chost%5Cx",
            r"//host/x",
            r"%2F%2Fhost%2Fshare%2Fx",
            r"%5C/host/x",
            r"%5C%5C%3F%5CC:%5CUsers%5Cme%5Cproject%5Ca.png",
            r"%5C%5C.%5Cpipe%5Cx",
        ] {
            let (calls, resolve) = counting();
            let path = PathBuf::from(urldecode(raw));
            assert!(!within_with(&roots, &[], &path, |p| resolve(&calls, p)), "{raw} was let through");
            assert_eq!(calls.get(), 0, "{raw} was resolved");
        }
    }

    #[test]
    fn a_unc_path_in_a_request_is_a_403() {
        let (dir, _) = fixture(b"x");
        let roots = vec![dir.path().canonicalize().unwrap()];
        for uri in ["ade-media://localhost/%5C%5Chost%5Cx", "ade-media://localhost///host/x"] {
            let response = respond(&roots, &[], &request(uri, None), None);
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
        }
    }

    // Windows spellings: on unix a backslash is part of a name, not a separator.
    #[cfg(windows)]
    #[test]
    fn only_a_path_that_begins_with_a_root_is_resolved() {
        let roots = vec![PathBuf::from(r"\\?\C:\Users\me\project")];
        let (calls, resolve) = counting();
        // Another folder, and one that only shares the root's first letters.
        for raw in [r"C:/Windows/win.ini", r"C:/Users/me/projector/a.png", r"relative/a.png"] {
            assert!(!within_with(&roots, &[], Path::new(raw), |p| resolve(&calls, p)), "{raw}");
        }
        assert_eq!(calls.get(), 0);
        // Inside, in either spelling and any case: resolved, then checked as before.
        for raw in [r"C:/Users/me/project/a.png", r"c:\users\ME\Project\a.png", r"C:/Users/me/project"] {
            let resolve_to_root = |_: &Path| Some(PathBuf::from(r"\\?\C:\Users\me\project\a.png"));
            assert!(within_with(&roots, &[], Path::new(raw), resolve_to_root), "{raw}");
        }
        // Inside as text, outside once `..` is resolved: the old check still refuses it.
        let climbs = |_: &Path| Some(PathBuf::from(r"\\?\C:\Windows\win.ini"));
        assert!(!within_with(&roots, &[], Path::new(r"C:/Users/me/project/../../../Windows/win.ini"), climbs));
    }

    // A project opened through a junction: opened as `C:/dev/app`, canonical `D:\src\app`.
    #[cfg(windows)]
    #[test]
    fn a_root_opened_through_a_link_matches_in_either_form() {
        let roots = vec![PathBuf::from(r"\\?\D:\src\app")];
        let opened = vec!["C:/dev/app".to_owned()];
        let resolved = |_: &Path| Some(PathBuf::from(r"\\?\D:\src\app\a.png"));
        for raw in [r"C:/dev/app/a.png", r"D:/src/app/a.png"] {
            let calls = std::cell::Cell::new(0);
            let resolve = |p: &Path| {
                calls.set(calls.get() + 1);
                resolved(p)
            };
            assert!(within_with(&roots, &opened, Path::new(raw), resolve), "{raw}");
            assert_eq!(calls.get(), 1, "{raw}");
        }
    }

    // A mapped drive: opened as `Z:/proj`, canonical a share.
    #[cfg(windows)]
    #[test]
    fn a_root_on_a_mapped_drive_matches_as_opened() {
        let roots = vec![PathBuf::from(r"\\?\UNC\server\share\proj")];
        let opened = vec!["Z:/proj".to_owned()];
        let resolve = |_: &Path| Some(PathBuf::from(r"\\?\UNC\server\share\proj\a.png"));
        assert!(within_with(&roots, &opened, Path::new(r"Z:/proj/a.png"), resolve));
        // The share itself, asked for directly, is still refused unresolved.
        for raw in [r"//server/share/proj/a.png", r"\\server\share\proj\a.png", r"\\?\UNC\server\share\proj\a.png"] {
            let (calls, resolve) = counting();
            assert!(!within_with(&roots, &opened, Path::new(raw), |p| resolve(&calls, p)), "{raw}");
            assert_eq!(calls.get(), 0, "{raw} was resolved");
        }
    }

    #[test]
    fn an_empty_path_is_a_bad_request() {
        let response = respond(&[], &[], &request("ade-media://localhost/", None), None);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    fn with_origin(uri: &str, origin: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(uri)
            .header("origin", origin)
            .body(Vec::new())
            .expect("richiesta")
    }

    #[test]
    fn the_window_itself_is_allowed_by_its_own_origin() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        let response = respond(&roots, &[], &with_origin(&url, "http://tauri.localhost"), Some("http://tauri.localhost"));
        assert_eq!(
            response.headers().get("Access-Control-Allow-Origin").unwrap(),
            "http://tauri.localhost"
        );
    }

    #[test]
    fn another_origin_is_not_allowed_to_read() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        let response = respond(&roots, &[], &with_origin(&url, "https://example.com"), Some("http://tauri.localhost"));
        assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
    }

    #[test]
    fn a_null_origin_is_not_allowed_to_read() {
        // A sandbox without allow-same-origin sends `Origin: null`; answering
        // `null` would let those pages in. Kept refused after S52.
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        for app in [Some("http://tauri.localhost"), Some("null"), None] {
            let response = respond(&roots, &[], &with_origin(&url, "null"), app);
            assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
        }
    }

    #[test]
    fn a_same_origin_browser_pane_is_not_allowed_to_read() {
        // With allow-same-origin the pane sends the site's origin, not null.
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let url = url_for(&path.to_string_lossy());
        let response = respond(
            &roots,
            &[],
            &with_origin(&url, "https://bastelli-cmp.vercel.app"),
            Some("http://tauri.localhost"),
        );
        assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
    }

    #[test]
    fn a_request_without_origin_gets_no_cors_header() {
        let (dir, path) = fixture(b"0123456789");
        let roots = vec![dir.path().canonicalize().expect("radice")];
        let response = respond(&roots, &[], &request(&url_for(&path.to_string_lossy()), None), Some("http://tauri.localhost"));
        assert!(response.headers().get("Access-Control-Allow-Origin").is_none());
    }
}
