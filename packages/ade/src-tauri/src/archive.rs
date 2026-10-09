//! What a ZIP, APK, JAR or AAB holds, for the binary file pane.
//!
//! Read from the archive's central directory: nothing is extracted to disk and
//! nothing in it is run. For an APK the pane also shows who it is — package,
//! version, SDK levels — read from its `AndroidManifest.xml`, which inside an
//! APK is not XML but Android's binary form of it (AXML). Parsed here, with no
//! aapt and no Android SDK; when the parse fails the listing simply has no
//! manifest.

use std::io::Read;

use serde::Serialize;

/// The most entries one listing carries. The pane sorts and shows its first
/// 2000; an archive with more says how many it has (`total`).
pub const MAX_ENTRIES: usize = 50_000;

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
    /// The files, at most `MAX_ENTRIES`, in the archive's own order.
    pub entries: Vec<ArchiveEntry>,
    /// How many files the archive holds, listed or not.
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub android: Option<AndroidManifest>,
}

/// Lists the files of the archive at `path`.
#[tauri::command]
pub async fn list_archive(path: String) -> Result<ArchiveListing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&path))
        .await
        .map_err(|e| e.to_string())?
}

pub fn list(path: &str) -> Result<ArchiveListing, String> {
    crate::refuse_network_path(path)?;
    if crate::is_credential_path(std::path::Path::new(path), dirs::home_dir().as_deref()) {
        return Err(format!("credenziali dell'utente: lettura non consentita: {path}"));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("{path}: {e}"))?;

    let mut entries = Vec::new();
    let mut total = 0;
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(index) else { continue };
        if entry.is_dir() {
            continue;
        }
        total += 1;
        if entries.len() < MAX_ENTRIES {
            entries.push(ArchiveEntry { path: entry.name().to_string(), size: entry.size() });
        }
    }

    let android = manifest_bytes(&mut archive).and_then(|bytes| parse_manifest(&bytes));
    Ok(ArchiveListing { entries, total, android })
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

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// The string pool chunk starting at `start`.
fn string_pool(bytes: &[u8], start: usize) -> Option<Vec<String>> {
    let header_size = u16_at(bytes, start + 2)? as usize;
    let count = u32_at(bytes, start + 8)? as usize;
    let flags = u32_at(bytes, start + 16)?;
    let strings_start = start + u32_at(bytes, start + 20)? as usize;
    let utf8 = flags & UTF8_FLAG != 0;
    let offsets = start + header_size;
    let mut strings = Vec::with_capacity(count.min(65_536));
    for i in 0..count {
        let at = strings_start + u32_at(bytes, offsets + i * 4)? as usize;
        strings.push(if utf8 { utf8_string(bytes, at) } else { utf16_string(bytes, at) }.unwrap_or_default());
    }
    Some(strings)
}

/// A UTF-8 pool string: its length in UTF-16 units, its length in bytes, the bytes.
fn utf8_string(bytes: &[u8], at: usize) -> Option<String> {
    let skip_len = |at: usize| -> Option<(usize, usize)> {
        let first = *bytes.get(at)? as usize;
        if first & 0x80 != 0 {
            Some((((first & 0x7f) << 8) | *bytes.get(at + 1)? as usize, at + 2))
        } else {
            Some((first, at + 1))
        }
    };
    let (_, at) = skip_len(at)?;
    let (len, at) = skip_len(at)?;
    Some(String::from_utf8_lossy(bytes.get(at..at + len)?).into_owned())
}

/// A UTF-16 pool string: its length in units (one or two of them), the units.
fn utf16_string(bytes: &[u8], at: usize) -> Option<String> {
    let first = u16_at(bytes, at)? as usize;
    let (len, at) = if first & 0x8000 != 0 {
        (((first & 0x7fff) << 16) | u16_at(bytes, at + 2)? as usize, at + 4)
    } else {
        (first, at + 2)
    };
    let units: Option<Vec<u16>> = (0..len).map(|i| u16_at(bytes, at + i * 2)).collect();
    Some(String::from_utf16_lossy(&units?))
}

/// Package, version and SDK levels from a binary `AndroidManifest.xml`.
///
/// `None` when the bytes are not AXML at all; fields the manifest does not
/// carry, or carries as a reference into the resources, stay empty.
pub fn parse_manifest(bytes: &[u8]) -> Option<AndroidManifest> {
    if u16_at(bytes, 0)? != RES_XML_TYPE {
        return None;
    }
    let end = (u32_at(bytes, 4)? as usize).min(bytes.len());
    let mut at = u16_at(bytes, 2)? as usize;
    let mut strings: Vec<String> = Vec::new();
    let mut resource_ids: Vec<u32> = Vec::new();
    let mut manifest = AndroidManifest::default();
    let mut seen_element = false;

    while at + 8 <= end {
        let kind = u16_at(bytes, at)?;
        let header_size = u16_at(bytes, at + 2)? as usize;
        let size = u32_at(bytes, at + 4)? as usize;
        if size < 8 || at + size > end {
            break;
        }
        match kind {
            RES_STRING_POOL_TYPE => strings = string_pool(bytes, at)?,
            RES_XML_RESOURCE_MAP_TYPE => {
                resource_ids = (0..(size - header_size) / 4)
                    .filter_map(|i| u32_at(bytes, at + header_size + i * 4))
                    .collect();
            }
            RES_XML_START_ELEMENT_TYPE => {
                seen_element = true;
                let ext = at + header_size;
                let name = strings.get(u32_at(bytes, ext + 4)? as usize).map(String::as_str);
                let attr_start = ext + u16_at(bytes, ext + 8)? as usize;
                let attr_size = u16_at(bytes, ext + 10)? as usize;
                let attr_count = u16_at(bytes, ext + 12)? as usize;
                for i in 0..attr_count {
                    let attr = attr_start + i * attr_size;
                    let name_index = u32_at(bytes, attr + 4)?;
                    let attr_name = strings.get(name_index as usize).map(String::as_str).unwrap_or("");
                    let id = resource_ids.get(name_index as usize).copied();
                    let value = attribute_value(bytes, attr, &strings);
                    let slot = match (name, id, attr_name) {
                        (Some("manifest"), _, "package") => &mut manifest.package,
                        (Some("manifest"), Some(ATTR_VERSION_CODE), _) | (Some("manifest"), _, "versionCode") => {
                            &mut manifest.version_code
                        }
                        (Some("manifest"), Some(ATTR_VERSION_NAME), _) | (Some("manifest"), _, "versionName") => {
                            &mut manifest.version_name
                        }
                        (Some("uses-sdk"), Some(ATTR_MIN_SDK), _) | (Some("uses-sdk"), _, "minSdkVersion") => {
                            &mut manifest.min_sdk
                        }
                        (Some("uses-sdk"), Some(ATTR_TARGET_SDK), _) | (Some("uses-sdk"), _, "targetSdkVersion") => {
                            &mut manifest.target_sdk
                        }
                        _ => continue,
                    };
                    if slot.is_none() {
                        *slot = value;
                    }
                }
            }
            _ => {}
        }
        at += size;
    }
    seen_element.then_some(manifest)
}

/// An attribute's value as text: its raw string, or its typed string or integer.
fn attribute_value(bytes: &[u8], attr: usize, strings: &[String]) -> Option<String> {
    let raw = u32_at(bytes, attr + 8)?;
    if raw != NO_INDEX {
        return strings.get(raw as usize).cloned();
    }
    let data_type = *bytes.get(attr + 15)?;
    let data = u32_at(bytes, attr + 16)?;
    match data_type {
        TYPE_STRING => strings.get(data as usize).cloned(),
        TYPE_INT_DEC | TYPE_INT_HEX => Some((data as i32).to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

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

    enum Value {
        Str(u32),
        Int(u32),
    }

    /// A minimal binary manifest, as aapt2 writes one: a UTF-16 string pool,
    /// the resource ids of the `android:` attributes, `<manifest>` and `<uses-sdk>`.
    fn axml(strings: &[&str], ids: &[u32], elements: &[(u32, Vec<(u32, Value)>)]) -> Vec<u8> {
        let mut offsets = Vec::new();
        let mut data = Vec::new();
        for s in strings {
            offsets.extend((data.len() as u32).to_le_bytes());
            let units: Vec<u16> = s.encode_utf16().collect();
            data.extend((units.len() as u16).to_le_bytes());
            for unit in units {
                data.extend(unit.to_le_bytes());
            }
            data.extend(0u16.to_le_bytes());
        }
        while data.len() % 4 != 0 {
            data.push(0);
        }
        let mut pool_header = Vec::new();
        pool_header.extend((strings.len() as u32).to_le_bytes());
        pool_header.extend(0u32.to_le_bytes()); // styles
        pool_header.extend(0u32.to_le_bytes()); // flags: UTF-16
        pool_header.extend((28 + offsets.len() as u32).to_le_bytes()); // strings start
        pool_header.extend(0u32.to_le_bytes()); // styles start
        let mut pool_body = offsets.clone();
        pool_body.extend(&data);
        let mut body = chunk(RES_STRING_POOL_TYPE, &pool_header, &pool_body);

        let id_bytes: Vec<u8> = ids.iter().flat_map(|id| id.to_le_bytes()).collect();
        body.extend(chunk(RES_XML_RESOURCE_MAP_TYPE, &[], &id_bytes));

        for (name, attrs) in elements {
            let mut header = Vec::new();
            header.extend(1u32.to_le_bytes()); // line
            header.extend(NO_INDEX.to_le_bytes()); // comment
            let mut ext = Vec::new();
            ext.extend(NO_INDEX.to_le_bytes()); // namespace
            ext.extend(name.to_le_bytes());
            ext.extend(20u16.to_le_bytes()); // attributes start
            ext.extend(20u16.to_le_bytes()); // attribute size
            ext.extend((attrs.len() as u16).to_le_bytes());
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
            body.extend(chunk(RES_XML_START_ELEMENT_TYPE, &header, &ext));
        }
        chunk(RES_XML_TYPE, &[], &body)
    }

    /// The manifest of a small app: the attribute names are empty, as in an
    /// optimised APK, so only their resource ids say which is which.
    fn fixture_manifest() -> Vec<u8> {
        let strings = ["", "", "", "", "package", "manifest", "uses-sdk", "it.fabioland.app", "0.1.1-preview"];
        let ids = [ATTR_VERSION_CODE, ATTR_VERSION_NAME, ATTR_MIN_SDK, ATTR_TARGET_SDK];
        axml(
            &strings,
            &ids,
            &[
                (5, vec![(0, Value::Int(11)), (1, Value::Str(8)), (4, Value::Str(7))]),
                (6, vec![(2, Value::Int(24)), (3, Value::Int(35))]),
            ],
        )
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

        let listing = list(&path.to_string_lossy()).expect("a zip is listed");
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

        let listing = list(&path.to_string_lossy()).expect("an apk is listed");
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
        let manifest = axml(
            &strings,
            &[],
            &[(3, vec![(0, Value::Int(7)), (1, Value::Str(6)), (2, Value::Str(5))])],
        );
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
        let listing = list(&path.to_string_lossy()).expect("still listed");
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
        assert!(list(&path.to_string_lossy()).is_err());
        assert!(list(r"\\server\share\app.apk").is_err_and(|e| e.contains("percorso di rete")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
