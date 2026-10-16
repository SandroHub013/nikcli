//! The link and the QR of a pairing (scelta 3): `https://t.me/<bot>?start=<token>`, and the same address as a picture.
//!
//! The token comes from `authz.rs` (`Pairing::issue_link`); here is only how it becomes something to open or scan. The
//! QR is made in Rust (the `qrcode` crate) and goes to the page as an SVG to draw as an image: the page needs no library
//! of its own for it, and the token is in the picture and in the link, never in a log.
//!
//! Only Telegram has a link of this kind: its deep link `t.me/<username>?start=<payload>` hands the payload to the bot
//! as `/start <payload>` in the private chat of whoever opens it. Discord and Slack have no equivalent that carries a
//! secret to the bot from a link (a Discord invite or a Slack app link brings the bot to a server, not a person to the
//! bot), so they keep the code.

use super::adapter::Platform;
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};

/// Telegram's bot usernames: 5 to 32 characters, letters, digits and underscores, ending in `bot`.
fn is_telegram_username(name: &str) -> bool {
    (5..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && name.to_ascii_lowercase().ends_with("bot")
}

/// The username in what Telegram's `getMe` gave (`@mio_bot`, or only a first name for a bot without a username).
pub fn telegram_username(whoami: &str) -> Result<&str, String> {
    let name = whoami.strip_prefix('@').unwrap_or("");
    if is_telegram_username(name) {
        Ok(name)
    } else {
        Err("Telegram non ha detto lo username del bot: senza, il link non si può fare. Usa il codice".into())
    }
}

/// Whether the platform has a link of this kind; if not, what to tell the user.
pub fn has_link(platform: Platform) -> Result<(), String> {
    match platform {
        Platform::Telegram => Ok(()),
        other => Err(format!("il link e il QR ci sono solo per Telegram: per {} resta il codice", other.label())),
    }
}

/// The address a QR carries and a link opens.
pub fn link_url(platform: Platform, whoami: &str, token: &str) -> Result<String, String> {
    has_link(platform)?;
    Ok(format!("https://t.me/{}?start={token}", telegram_username(whoami)?))
}

/// The QR of `text` as a standalone SVG: black on white, with its quiet zone, which a scanner needs on a dark page too.
pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).map_err(|e| format!("QR non creato: {e}"))?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(224, 224)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

    #[test]
    fn the_link_is_the_deep_link_of_the_bot_with_the_token() {
        assert_eq!(
            link_url(Platform::Telegram, "@mio_bot", TOKEN).unwrap(),
            format!("https://t.me/mio_bot?start={TOKEN}")
        );
    }

    #[test]
    fn a_bot_without_a_username_has_no_link_and_says_why() {
        // `getMe` answers the first name when the bot has no username.
        assert!(link_url(Platform::Telegram, "Mio bot", TOKEN).unwrap_err().contains("username"));
        assert!(link_url(Platform::Telegram, "@", TOKEN).is_err());
        assert!(link_url(Platform::Telegram, "@x/../y", TOKEN).is_err());
        assert!(link_url(Platform::Telegram, "@mio_bot?start=zz", TOKEN).is_err(), "nothing of the name can bring in a parameter");
        assert!(link_url(Platform::Telegram, "@troppo_corto", TOKEN).is_err(), "must end in bot");
    }

    #[test]
    fn discord_and_slack_keep_the_code() {
        for platform in [Platform::Discord, Platform::Slack] {
            let error = link_url(platform, "@mio_bot", TOKEN).unwrap_err();
            assert!(error.contains("solo per Telegram") && error.contains("codice"), "{error}");
        }
    }

    #[test]
    fn the_qr_is_an_svg_with_its_quiet_zone_and_no_script() {
        let svg = qr_svg(&format!("https://t.me/mio_bot?start={TOKEN}")).unwrap();
        assert!(svg.contains("<svg") && svg.trim_end().ends_with("</svg>"), "{svg}");
        assert!(svg.contains("#ffffff") && svg.contains("#000000"));
        assert!(!svg.to_lowercase().contains("<script") && !svg.contains("javascript:"));
        // The token is in the QR's modules, not written out in the picture's text.
        assert!(!svg.contains(TOKEN));
        // The same text is the same picture; another token is another one.
        assert_eq!(svg, qr_svg(&format!("https://t.me/mio_bot?start={TOKEN}")).unwrap());
        assert_ne!(svg, qr_svg("https://t.me/mio_bot?start=ZyXwVuTsRqPoNmLkJiHgFeDcBa543210").unwrap());
    }
}
