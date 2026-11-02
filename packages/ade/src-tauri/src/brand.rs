//! The product name as `brand.json` says it, for the few native strings that
//! name the app: the window title's fallback and the hook dialogs. Read at
//! compile time from the same file `bun run brand` and the frontend use, so
//! a rename is one edit there and none here.

use std::sync::OnceLock;

pub fn name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../brand.json"))
            .ok()
            .and_then(|brand| brand["name"].as_str().map(str::to_owned))
            .unwrap_or_default()
    })
}

/// The name people read: the window title, the tray, the dialogs. `name` is
/// productName (the installer, the install folder and the updater hang off
/// it) and stays «ADE»; this one is «Ragù Code ADE». Falls back to `name`.
pub fn title() -> &'static str {
    static TITLE: OnceLock<String> = OnceLock::new();
    TITLE.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../brand.json"))
            .ok()
            .and_then(|brand| brand["title"].as_str().map(str::to_owned))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| name().to_owned())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_title_is_the_visible_name_and_the_product_name_is_untouched() {
        assert_eq!(super::title(), "Ragù Code ADE");
        assert_eq!(super::name(), "ADE");
    }

    #[test]
    fn brand_json_names_the_product() {
        assert!(!super::name().is_empty());
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["productName"].as_str(), Some(super::name()), "run `bun run brand`");
    }
}
