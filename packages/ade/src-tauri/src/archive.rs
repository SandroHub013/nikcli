//! What a ZIP, APK, JAR or AAB holds, for the binary file pane.
//!
//! Read from the archive's central directory: nothing is extracted to disk and
//! nothing in it is run. For an APK the pane also shows who it is — package,
//! version, SDK levels — read from its `AndroidManifest.xml`, which inside an
//! APK is not XML but Android's binary form of it (AXML). Parsed here, with no
//! aapt and no Android SDK; when the parse fails the listing simply has no
//! manifest.
//!
//! Everything here reads a file the user downloaded, so every number taken
//! from it is a claim to check: sizes and offsets are confined to their chunk,
//! with checked arithmetic, and the work has a budget. A manifest that breaks
//! a rule loses its fields, never the list of files.

use std::io::Read;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The most entries one listing carries. The pane sorts and shows its first
/// 2000; an archive with more says how many it has (`total`).
pub const MAX_ENTRIES: usize = 50_000;

/// How long one listing may read entries before it returns what it has. A
/// blocking thread cannot be stopped when the pane closes, so it stops itself.
const LISTING_TIME: Duration = Duration::from_secs(5);

/// The longest entry name sent to the page; a ZIP allows 64 KB per name.
pub const MAX_NAME_BYTES: usize = 1024;

/// The largest manifest inflated. A real one is a few kilobytes; a bigger
/// entry by that name is not something to decompress into memory.
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct ArchiveEntry {
    pub path: String,
    /// Uncompressed size.
    pub size: u64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidManifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_sdk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_sdk: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ArchiveListing {
    /// The files read within the budget, in the archive's own order.
    pub entries: Vec<ArchiveEntry>,
    /// How many files the archive holds, listed or not.
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub android: Option<AndroidManifest>,
}

/// How much one listing may do: entries read, and until when.
pub struct Budget {
    pub max_entries: usize,
    pub deadline: Instant,
}

impl Budget {
    fn standard() -> Self {
        Budget { max_entries: MAX_ENTRIES, deadline: Instant::now() + LISTING_TIME }
    }

    fn spent(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

/// Lists the files of the archive at `path`.
#[tauri::command]
pub async fn list_archive(path: String) -> Result<ArchiveListing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&path, &Budget::standard()))
        .await
        .map_err(|e| e.to_string())?
}

pub fn list(path: &str, budget: &Budget) -> Result<ArchiveListing, String> {
    crate::refuse_network_path(path)?;
    if crate::is_credential_path(std::path::Path::new(path), dirs::home_dir().as_deref()) {
        return Err(format!("credenziali dell'utente: lettura non consentita: {path}"));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("{path}: {e}"))?;

    // Counted from the central directory already in memory: no seek per entry.
    let total = archive.file_names().filter(|name| !name.ends_with('/')).count();
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        if entries.len() >= budget.max_entries || budget.spent() {
            break;
        }
        // A folder is skipped by its name, before the seek to its local header.
        if archive.name_for_index(index).map_or(true, |name| name.ends_with('/')) {
            continue;
        }
        let Ok(entry) = archive.by_index_raw(index) else { continue };
        entries.push(ArchiveEntry { path: shortened(entry.name()), size: entry.size() });
    }

    let android = if budget.spent() {
        None
    } else {
        /*
         * A parse that panics anyway costs the manifest, not the listing: the
         * rules below should make that impossible, and this keeps the promise
         * if one of them is ever wrong.
         */
        manifest_bytes(&mut archive)
            .and_then(|bytes| std::panic::catch_unwind(|| parse_manifest(&bytes)).ok().flatten())
    };
    Ok(ArchiveListing { entries, total, android })
}

/// A name cut to `MAX_NAME_BYTES` on a character boundary, marked as cut.
fn shortened(name: &str) -> String {
    if name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let mut end = MAX_NAME_BYTES;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &name[..end])
}

/// The `AndroidManifest.xml` at the archive's root, inflated, or `None`.
fn manifest_bytes<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Option<Vec<u8>> {
    let index = archive.index_for_name("AndroidManifest.xml")?;
    let entry = archive.by_index_raw(index).ok()?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return None;
    }
    /*
     * Stored, or else deflate: the only two methods an APK's manifest comes in.
     * The `zip` crate is built without its compression features, which also
     * hides the name of the deflate method, so anything else is tried as
     * deflate and fails to inflate rather than being misread.
     */
    let stored = entry.compression() == zip::CompressionMethod::Stored;
    let mut bytes = Vec::new();
    if stored {
        entry.take(MAX_MANIFEST_BYTES).read_to_end(&mut bytes).ok()?;
    } else {
        flate2::read::DeflateDecoder::new(entry)
            .take(MAX_MANIFEST_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
    }
    Some(bytes)
}

// AXML: Android's binary XML. Chunks of { type: u16, header size: u16, size: u32 }.
const RES_XML_TYPE: u16 = 0x0003;
const RES_STRING_POOL_TYPE: u16 = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE: u16 = 0x0180;
const RES_XML_START_ELEMENT_TYPE: u16 = 0x0102;
const UTF8_FLAG: u32 = 1 << 8;
const NO_INDEX: u32 = 0xffff_ffff;

// The `android:` attributes, by resource id: an optimised APK may drop their names.
const ATTR_VERSION_CODE: u32 = 0x0101_021b;
const ATTR_VERSION_NAME: u32 = 0x0101_021c;
const ATTR_MIN_SDK: u32 = 0x0101_020c;
const ATTR_TARGET_SDK: u32 = 0x0101_0270;

// Typed values that can be shown: a string, or an integer in either notation.
const TYPE_STRING: u8 = 0x03;
const TYPE_INT_DEC: u8 = 0x10;
const TYPE_INT_HEX: u8 = 0x11;

// The parser's budget. `<manifest>` is the first element of a real manifest
// and `<uses-sdk>` one of its first children: nothing past these is needed.
/// Chunks walked, of any kind.
const MAX_CHUNKS: usize = 4096;
/// Start elements looked at.
const MAX_ELEMENTS: usize = 64;
/// Attributes looked at on one element.
const MAX_ATTRIBUTES: usize = 64;
/// The longest value kept: a package name or a version is far shorter.
const MAX_VALUE_BYTES: usize = 4096;
/// The longest element or attribute name compared.
const MAX_NAME_COMPARED: usize = 64;
/// The smallest attribute record: namespace, name, raw value, typed value.
const ATTRIBUTE_BYTES: usize = 20;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    bytes.get(at..at.checked_add(2)?).map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at.checked_add(4)?).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// The string pool, read on demand and only inside its own chunk.
///
/// It used to be decoded whole, each offset into a new `String`: thousands
/// of offsets pointing at one long string turned 208 KB into 200 MB. Now a
/// string is decoded only when the parser asks for it, up to a length.
struct Pool<'a> {
    chunk: &'a [u8],
    offsets: usize,
    count: usize,
    strings: usize,
    utf8: bool,
}

impl<'a> Pool<'a> {
    fn parse(chunk: &'a [u8], header_size: usize) -> Option<Pool<'a>> {
        let count = u32_at(chunk, 8)? as usize;
        let flags = u32_at(chunk, 16)?;
        let strings = u32_at(chunk, 20)? as usize;
        let table_end = header_size.checked_add(count.checked_mul(4)?)?;
        if header_size < 28 || table_end > chunk.len() || strings > chunk.len() {
            return None;
        }
        Some(Pool { chunk, offsets: header_size, count, strings, utf8: flags & UTF8_FLAG != 0 })
    }

    /// String `index`, or `None` when it is missing, malformed or longer than `limit` bytes.
    fn get(&self, index: u32, limit: usize) -> Option<String> {
        let index = index as usize;
        if index >= self.count {
            return None;
        }
        let offset = u32_at(self.chunk, self.offsets + index * 4)? as usize;
        let at = self.strings.checked_add(offset)?;
        if self.utf8 {
            utf8_string(self.chunk, at, limit)
        } else {
            utf16_string(self.chunk, at, limit)
        }
    }

    fn is(&self, index: u32, expected: &str) -> bool {
        self.get(index, MAX_NAME_COMPARED).as_deref() == Some(expected)
    }
}

/// A UTF-8 pool string: its length in UTF-16 units, its length in bytes, the bytes.
fn utf8_string(bytes: &[u8], at: usize, limit: usize) -> Option<String> {
    let length = |at: usize| -> Option<(usize, usize)> {
        let first = *bytes.get(at)? as usize;
        if first & 0x80 != 0 {
            Some((((first & 0x7f) << 8) | *bytes.get(at.checked_add(1)?)? as usize, at.checked_add(2)?))
        } else {
            Some((first, at.checked_add(1)?))
        }
    };
    let (_, at) = length(at)?;
    let (len, at) = length(at)?;
    if len > limit {
        return None;
    }
    Some(String::from_utf8_lossy(bytes.get(at..at.checked_add(len)?)?).into_owned())
}

/// A UTF-16 pool string: its length in units (one or two of them), the units.
fn utf16_string(bytes: &[u8], at: usize, limit: usize) -> Option<String> {
    let first = u16_at(bytes, at)? as usize;
    let (len, at) = if first & 0x8000 != 0 {
        (((first & 0x7fff) << 16) | u16_at(bytes, at.checked_add(2)?)? as usize, at.checked_add(4)?)
    } else {
        (first, at.checked_add(2)?)
    };
    let byte_len = len.checked_mul(2)?;
    if byte_len > limit {
        return None;
    }
    let raw = bytes.get(at..at.checked_add(byte_len)?)?;
    let units: Vec<u16> = raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    Some(String::from_utf16_lossy(&units))
}

#[derive(Clone, Copy, PartialEq)]
enum Element {
    Manifest,
    UsesSdk,
}

/// Package, version and SDK levels from a binary `AndroidManifest.xml`.
///
/// `None` when the bytes are not AXML at all or hold no element; fields the
/// manifest does not carry, carries as a reference into the resources, or
/// carries in a way that breaks the format's own sizes, stay empty.
pub fn parse_manifest(bytes: &[u8]) -> Option<AndroidManifest> {
    if u16_at(bytes, 0)? != RES_XML_TYPE {
        return None;
    }
    let end = (u32_at(bytes, 4)? as usize).min(bytes.len());
    let first = u16_at(bytes, 2)? as usize;
    if first < 8 || first > end {
        return None;
    }
    let bytes = &bytes[..end];

    let mut at = first;
    let mut pool: Option<Pool> = None;
    let mut ids: &[u8] = &[];
    let mut manifest = AndroidManifest::default();
    let mut elements = 0;
    let mut seen: Vec<Element> = Vec::new();

    for _ in 0..MAX_CHUNKS {
        // Every chunk must hold its own header, and fit in the document.
        let (Some(kind), Some(header_size), Some(size)) = (u16_at(bytes, at), u16_at(bytes, at + 2), u32_at(bytes, at + 4))
        else {
            break;
        };
        let (header_size, size) = (header_size as usize, size as usize);
        let Some(chunk_end) = at.checked_add(size) else { break };
        if header_size < 8 || header_size > size || chunk_end > bytes.len() {
            break;
        }
        let chunk = &bytes[at..chunk_end];
        match kind {
            RES_STRING_POOL_TYPE => pool = Pool::parse(chunk, header_size),
            RES_XML_RESOURCE_MAP_TYPE => ids = &chunk[header_size..],
            RES_XML_START_ELEMENT_TYPE => {
                elements += 1;
                if let Some(pool) = &pool {
                    if let Some(element) = read_element(chunk, header_size, pool, ids, &mut manifest) {
                        seen.push(element);
                    }
                }
                let done = seen.contains(&Element::Manifest) && seen.contains(&Element::UsesSdk);
                if done || elements >= MAX_ELEMENTS {
                    break;
                }
            }
            _ => {}
        }
        at = chunk_end;
    }
    (elements > 0).then_some(manifest)
}

/// The fields one start element gives, if it is `<manifest>` or `<uses-sdk>`.
fn read_element(
    chunk: &[u8],
    header_size: usize,
    pool: &Pool,
    ids: &[u8],
    manifest: &mut AndroidManifest,
) -> Option<Element> {
    let ext = header_size;
    let name = u32_at(chunk, ext.checked_add(4)?)?;
    let element = if pool.is(name, "manifest") {
        Element::Manifest
    } else if pool.is(name, "uses-sdk") {
        Element::UsesSdk
    } else {
        return None;
    };
    let attr_start = ext.checked_add(u16_at(chunk, ext + 8)? as usize)?;
    let attr_size = u16_at(chunk, ext + 10)? as usize;
    let attr_count = u16_at(chunk, ext + 12)? as usize;
    // Records that overlap, or run past the element, are not attributes of it.
    let attrs_end = attr_start.checked_add(attr_count.checked_mul(attr_size)?)?;
    if attr_size < ATTRIBUTE_BYTES || attrs_end > chunk.len() {
        return Some(element);
    }
    for i in 0..attr_count.min(MAX_ATTRIBUTES) {
        let attr = attr_start + i * attr_size;
        let Some(name_index) = u32_at(chunk, attr + 4) else { break };
        let id = (name_index as usize).checked_mul(4).and_then(|at| u32_at(ids, at));
        let named = |expected: &str| pool.is(name_index, expected);
        let slot = match element {
            Element::Manifest if named("package") => &mut manifest.package,
            Element::Manifest if id == Some(ATTR_VERSION_CODE) || named("versionCode") => &mut manifest.version_code,
            Element::Manifest if id == Some(ATTR_VERSION_NAME) || named("versionName") => &mut manifest.version_name,
            Element::UsesSdk if id == Some(ATTR_MIN_SDK) || named("minSdkVersion") => &mut manifest.min_sdk,
            Element::UsesSdk if id == Some(ATTR_TARGET_SDK) || named("targetSdkVersion") => &mut manifest.target_sdk,
            _ => continue,
        };
        // Decoded only once it is known to be wanted.
        if slot.is_none() {
            *slot = attribute_value(chunk, attr, pool);
        }
    }
    Some(element)
}

/// An attribute's value as text: its raw string, or its typed string or integer.
fn attribute_value(chunk: &[u8], attr: usize, pool: &Pool) -> Option<String> {
    let raw = u32_at(chunk, attr + 8)?;
    if raw != NO_INDEX {
        return pool.get(raw, MAX_VALUE_BYTES);
    }
    let data_type = *chunk.get(attr + 15)?;
    let data = u32_at(chunk, attr + 16)?;
    match data_type {
        TYPE_STRING => pool.get(data, MAX_VALUE_BYTES),
        TYPE_INT_DEC | TYPE_INT_HEX => Some((data as i32).to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, UNIX_EPOCH};

    fn temp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{nanos}"));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn generous() -> Budget {
        Budget { max_entries: MAX_ENTRIES, deadline: Instant::now() + Duration::from_secs(60) }
    }

    /// A ZIP written by hand: stored or deflated entries, a central directory,
    /// the end record. The `zip` crate here is built without compression.
    fn zip_bytes(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in entries {
            let mut crc = flate2::Crc::new();
            crc.update(data);
            let body = if *deflate {
                let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(data).expect("deflate");
                encoder.finish().expect("deflate")
            } else {
                data.to_vec()
            };
            let method: u16 = if *deflate { 8 } else { 0 };
            let offset = out.len() as u32;
            let common = |buf: &mut Vec<u8>| {
                buf.extend(20u16.to_le_bytes()); // version needed
                buf.extend(0u16.to_le_bytes()); // flags
                buf.extend(method.to_le_bytes());
                buf.extend(0u32.to_le_bytes()); // time and date
                buf.extend(crc.sum().to_le_bytes());
                buf.extend((body.len() as u32).to_le_bytes());
                buf.extend((data.len() as u32).to_le_bytes());
                buf.extend((name.len() as u16).to_le_bytes());
                buf.extend(0u16.to_le_bytes()); // extra
            };
            out.extend(0x0403_4b50u32.to_le_bytes());
            common(&mut out);
            out.extend(name.as_bytes());
            out.extend(&body);

            central.extend(0x0201_4b50u32.to_le_bytes());
            central.extend(20u16.to_le_bytes()); // version made by
            common(&mut central);
            central.extend(0u16.to_le_bytes()); // comment
            central.extend(0u16.to_le_bytes()); // disk
            central.extend(0u16.to_le_bytes()); // internal attributes
            central.extend(0u32.to_le_bytes()); // external attributes
            central.extend(offset.to_le_bytes());
            central.extend(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        out.extend(&central);
        out.extend(0x0605_4b50u32.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((central.len() as u32).to_le_bytes());
        out.extend(central_offset.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out
    }

    /// A chunk: type, header size, total size, then the header's rest and the body.
    fn chunk(kind: u16, header: &[u8], body: &[u8]) -> Vec<u8> {
        let header_size = 8 + header.len();
        let mut out = Vec::new();
        out.extend(kind.to_le_bytes());
        out.extend((header_size as u16).to_le_bytes());
        out.extend(((header_size + body.len()) as u32).to_le_bytes());
        out.extend(header);
        out.extend(body);
        out
    }

    /// A UTF-16 string pool; `repeat_last` more offsets all point at the last string.
    fn pool(strings: &[&str], repeat_last: usize) -> Vec<u8> {
        let mut offsets = Vec::new();
        let mut data = Vec::new();
        let mut last = 0u32;
        for s in strings {
            last = data.len() as u32;
            offsets.extend(last.to_le_bytes());
            let units: Vec<u16> = s.encode_utf16().collect();
            data.extend((units.len() as u16).to_le_bytes());
            for unit in units {
                data.extend(unit.to_le_bytes());
            }
            data.extend(0u16.to_le_bytes());
        }
        for _ in 0..repeat_last {
            offsets.extend(last.to_le_bytes());
        }
        while data.len() % 4 != 0 {
            data.push(0);
        }
        let count = strings.len() + repeat_last;
        let mut header = Vec::new();
        header.extend((count as u32).to_le_bytes());
        header.extend(0u32.to_le_bytes()); // styles
        header.extend(0u32.to_le_bytes()); // flags: UTF-16
        header.extend((28 + offsets.len() as u32).to_le_bytes()); // strings start
        header.extend(0u32.to_le_bytes()); // styles start
        let mut body = offsets;
        body.extend(&data);
        chunk(RES_STRING_POOL_TYPE, &header, &body)
    }

    fn resource_map(ids: &[u32]) -> Vec<u8> {
        let bytes: Vec<u8> = ids.iter().flat_map(|id| id.to_le_bytes()).collect();
        chunk(RES_XML_RESOURCE_MAP_TYPE, &[], &bytes)
    }

    enum Value {
        Str(u32),
        Int(u32),
    }

    /// A start element. `attr_size` and `declared` are what the header says;
    /// the attributes themselves are always written 20 bytes each.
    fn element_with(name: u32, attr_size: u16, declared: u16, attrs: &[(u32, Value)]) -> Vec<u8> {
        let mut header = Vec::new();
        header.extend(1u32.to_le_bytes()); // line
        header.extend(NO_INDEX.to_le_bytes()); // comment
        let mut ext = Vec::new();
        ext.extend(NO_INDEX.to_le_bytes()); // namespace
        ext.extend(name.to_le_bytes());
        ext.extend(20u16.to_le_bytes()); // attributes start
        ext.extend(attr_size.to_le_bytes());
        ext.extend(declared.to_le_bytes());
        ext.extend([0u8; 6]); // id, class, style
        for (attr_name, value) in attrs {
            ext.extend(NO_INDEX.to_le_bytes()); // namespace
            ext.extend(attr_name.to_le_bytes());
            let (raw, data_type, data) = match value {
                Value::Str(index) => (*index, TYPE_STRING, *index),
                Value::Int(n) => (NO_INDEX, TYPE_INT_DEC, *n),
            };
            ext.extend(raw.to_le_bytes());
            ext.extend(8u16.to_le_bytes());
            ext.push(0);
            ext.push(data_type);
            ext.extend(data.to_le_bytes());
        }
        chunk(RES_XML_START_ELEMENT_TYPE, &header, &ext)
    }

    fn element(name: u32, attrs: &[(u32, Value)]) -> Vec<u8> {
        element_with(name, 20, attrs.len() as u16, attrs)
    }

    /// The document chunk around the parts.
    fn xml(parts: &[Vec<u8>]) -> Vec<u8> {
        chunk(RES_XML_TYPE, &[], &parts.concat())
    }

    /// The manifest of a small app: the attribute names are empty, as in an
    /// optimised APK, so only their resource ids say which is which.
    fn fixture_manifest() -> Vec<u8> {
        let strings = ["", "", "", "", "package", "manifest", "uses-sdk", "it.fabioland.app", "0.1.1-preview"];
        let ids = [ATTR_VERSION_CODE, ATTR_VERSION_NAME, ATTR_MIN_SDK, ATTR_TARGET_SDK];
        xml(&[
            pool(&strings, 0),
            resource_map(&ids),
            element(5, &[(0, Value::Int(11)), (1, Value::Str(8)), (4, Value::Str(7))]),
            element(6, &[(2, Value::Int(24)), (3, Value::Int(35))]),
        ])
    }

    #[test]
    fn a_zip_lists_its_files_with_their_sizes_and_no_folders() {
        let dir = temp("archive");
        let path = dir.join("photos.zip");
        std::fs::write(
            &path,
            zip_bytes(&[("a.txt", b"hello", false), ("dir/", b"", false), ("dir/b.bin", &[7u8; 300], true)]),
        )
        .expect("write");

        let listing = list(&path.to_string_lossy(), &generous()).expect("a zip is listed");
        let files: Vec<(&str, u64)> = listing.entries.iter().map(|e| (e.path.as_str(), e.size)).collect();
        assert_eq!(files, vec![("a.txt", 5), ("dir/b.bin", 300)]);
        assert_eq!(listing.total, 2);
        assert!(listing.android.is_none(), "not an APK");
        // Listing extracted nothing next to the archive.
        assert_eq!(std::fs::read_dir(&dir).expect("dir").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_apk_says_its_package_version_and_sdk_levels() {
        let dir = temp("apk");
        let path = dir.join("app.apk");
        let manifest = fixture_manifest();
        std::fs::write(&path, zip_bytes(&[("AndroidManifest.xml", &manifest, true), ("classes.dex", b"dex\n035", false)]))
            .expect("write");

        let listing = list(&path.to_string_lossy(), &generous()).expect("an apk is listed");
        assert_eq!(listing.total, 2);
        assert_eq!(
            listing.android,
            Some(AndroidManifest {
                package: Some("it.fabioland.app".into()),
                version_name: Some("0.1.1-preview".into()),
                version_code: Some("11".into()),
                min_sdk: Some("24".into()),
                target_sdk: Some("35".into()),
            })
        );
        let json = serde_json::to_value(&listing).expect("serialize");
        assert_eq!(json["android"]["versionName"], "0.1.1-preview");
        assert_eq!(json["android"]["minSdk"], "24");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn named_attributes_are_read_too() {
        let strings = ["versionCode", "versionName", "package", "manifest", "7", "com.example", "1.0"];
        let manifest = xml(&[
            pool(&strings, 0),
            element(3, &[(0, Value::Int(7)), (1, Value::Str(6)), (2, Value::Str(5))]),
        ]);
        let parsed = parse_manifest(&manifest).expect("parsed");
        assert_eq!(parsed.package.as_deref(), Some("com.example"));
        assert_eq!(parsed.version_code.as_deref(), Some("7"));
        assert_eq!(parsed.version_name.as_deref(), Some("1.0"));
        assert_eq!(parsed.min_sdk, None);
    }

    #[test]
    fn a_broken_manifest_leaves_the_listing_without_one() {
        let dir = temp("apkbroken");
        let path = dir.join("broken.apk");
        let mut manifest = fixture_manifest();
        manifest.truncate(40);
        std::fs::write(&path, zip_bytes(&[("AndroidManifest.xml", &manifest, false), ("res/x.png", b"png", false)]))
            .expect("write");
        let listing = list(&path.to_string_lossy(), &generous()).expect("still listed");
        assert_eq!(listing.total, 2);
        assert!(listing.android.is_none());
        // Not AXML at all, and nothing.
        assert_eq!(parse_manifest(b"<manifest/>"), None);
        assert_eq!(parse_manifest(&[]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn not_an_archive_or_not_local_is_an_error() {
        let dir = temp("notzip");
        let path = dir.join("fake.zip");
        std::fs::write(&path, b"not a zip at all").expect("write");
        assert!(list(&path.to_string_lossy(), &generous()).is_err());
        assert!(list(r"\\server\share\app.apk", &generous()).is_err_and(|e| e.contains("percorso di rete")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /*
     * Review of the binary pane (H2): a chunk whose header claims more than the
     * chunk holds. `size - header_size` wrapped in release and spun for ever,
     * and panicked in debug, which took the whole listing down with it.
     */
    #[test]
    fn a_header_larger_than_its_chunk_ends_the_parse() {
        let mut map = Vec::new();
        map.extend(RES_XML_RESOURCE_MAP_TYPE.to_le_bytes());
        map.extend(0xffffu16.to_le_bytes());
        map.extend(8u32.to_le_bytes());
        assert_eq!(parse_manifest(&xml(&[map])), None);

        // A header of zero bytes and a document header past its own end.
        let mut empty = Vec::new();
        empty.extend(RES_STRING_POOL_TYPE.to_le_bytes());
        empty.extend(0u16.to_le_bytes());
        empty.extend(8u32.to_le_bytes());
        assert_eq!(parse_manifest(&xml(&[empty])), None);
        let mut document = xml(&[]);
        document[2] = 0xff;
        document[3] = 0xff;
        assert_eq!(parse_manifest(&document), None);
    }

    #[test]
    fn a_manifest_that_breaks_the_parser_still_lists_the_files() {
        let dir = temp("apkpanic");
        let path = dir.join("bad.apk");
        let mut map = Vec::new();
        map.extend(RES_XML_RESOURCE_MAP_TYPE.to_le_bytes());
        map.extend(0xffffu16.to_le_bytes());
        map.extend(8u32.to_le_bytes());
        std::fs::write(&path, zip_bytes(&[("AndroidManifest.xml", &xml(&[map]), true), ("classes.dex", b"dex", false)]))
            .expect("write");
        let listing = list(&path.to_string_lossy(), &generous()).expect("still listed");
        assert_eq!(listing.total, 2);
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.android.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /*
     * H1: thirty thousand names for one long string. Decoding the whole pool
     * made each of them a fresh copy (208 KB in, 200 MB out); only the names
     * and values the parser looks at are decoded now.
     */
    #[test]
    fn many_names_for_one_long_string_are_not_decoded() {
        let long = "a".repeat(4000);
        let strings = ["manifest", "package", "com.example", long.as_str()];
        let manifest = xml(&[pool(&strings, 30_000), element(0, &[(1, Value::Str(2))])]);
        let started = Instant::now();
        let parsed = parse_manifest(&manifest).expect("parsed");
        assert!(started.elapsed() < Duration::from_millis(500), "took {:?}", started.elapsed());
        assert_eq!(parsed.package.as_deref(), Some("com.example"));
    }

    #[test]
    fn a_value_too_long_to_be_a_package_is_left_out() {
        let long = "x".repeat(10_000);
        let strings = ["manifest", "package", long.as_str()];
        let parsed = parse_manifest(&xml(&[pool(&strings, 0), element(0, &[(1, Value::Str(2))])])).expect("parsed");
        assert_eq!(parsed.package, None);
    }

    /*
     * M1: attribute records come from the file. Size zero read the same bytes
     * over and over; a count larger than the chunk read the next chunk.
     */
    #[test]
    fn attributes_that_overlap_or_leave_their_element_are_ignored() {
        let strings = ["versionCode", "package", "manifest", "com.example"];
        let zero = xml(&[pool(&strings, 0), element_with(2, 0, 3, &[(0, Value::Int(11))])]);
        assert_eq!(parse_manifest(&zero).expect("parsed").version_code, None);

        let overflowing = xml(&[pool(&strings, 0), element_with(2, 20, 2, &[(1, Value::Str(3))])]);
        assert_eq!(parse_manifest(&overflowing).expect("parsed").package, None);
    }

    #[test]
    fn only_the_first_elements_are_looked_at() {
        let strings = ["x", "manifest", "package", "com.example"];
        let mut parts = vec![pool(&strings, 0)];
        parts.extend((0..100).map(|_| element(0, &[])));
        parts.push(element(1, &[(2, Value::Str(3))]));
        let parsed = parse_manifest(&xml(&parts)).expect("elements were seen");
        assert_eq!(parsed.package, None, "the manifest element comes first in a real APK");
    }

    /*
     * M2: a listing has a budget of entries and of time. What it did not get
     * to is still counted, from the central directory already in memory.
     */
    #[test]
    fn a_listing_stops_at_its_budget_and_still_counts_every_file() {
        let dir = temp("budget");
        let path = dir.join("app.apk");
        let manifest = fixture_manifest();
        std::fs::write(
            &path,
            zip_bytes(&[("AndroidManifest.xml", &manifest, true), ("a", b"1", false), ("b", b"22", false)]),
        )
        .expect("write");
        let path = path.to_string_lossy();

        let two = Budget { max_entries: 2, deadline: Instant::now() + Duration::from_secs(60) };
        let listing = list(&path, &two).expect("listed");
        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.total, 3);

        let spent = Budget { max_entries: MAX_ENTRIES, deadline: Instant::now() };
        let listing = list(&path, &spent).expect("listed");
        assert_eq!(listing.entries.len(), 0);
        assert_eq!(listing.total, 3);
        assert!(listing.android.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_entry_name_is_shortened_for_the_page() {
        let dir = temp("longname");
        let path = dir.join("long.zip");
        let name = format!("dir/{}", "è".repeat(1500));
        std::fs::write(&path, zip_bytes(&[(name.as_str(), b"x", false)])).expect("write");
        let listing = list(&path.to_string_lossy(), &generous()).expect("listed");
        let shown = &listing.entries[0].path;
        assert!(shown.len() <= MAX_NAME_BYTES + '…'.len_utf8(), "{} bytes", shown.len());
        assert!(shown.ends_with('…'));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
