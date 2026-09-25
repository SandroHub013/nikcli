//! Known secrets out of anything that leaves ADE through a gateway.
//!
//! A bot can read a file with a key in it, or echo an error that quotes one;
//! its reply then goes to a phone, a chat server and its history. Before any
//! send or edit, every value ADE knows to be secret — the gateway tokens and
//! the keys in the keychain — is replaced. Errors shown in the panel and log
//! lines go through the same function.

/// What a secret becomes.
pub const HIDDEN: &str = "[nascosto]";

/// Values shorter than this are not treated as secrets: replacing a
/// three-letter "key" would mangle ordinary words.
const MIN_SECRET: usize = 8;

/// `text` with every occurrence of each of `secrets` replaced by `[nascosto]`.
/// The longest first, so a secret that contains another goes whole.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut known: Vec<&str> = secrets
        .iter()
        .map(|secret| secret.trim())
        .filter(|secret| secret.chars().count() >= MIN_SECRET)
        .collect();
    known.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    known.dedup();
    let mut out = text.to_string();
    for secret in known {
        if out.contains(secret) {
            out = out.replace(secret, HIDDEN);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_secret_is_replaced_wherever_it_appears() {
        let token = "123456789:FINTO-token-di-prova_AbCdEfGhIjKlMn".to_string();
        let key = "sk-finta-chiave-0123456789".to_string();
        let text = format!("il token è {token}, la chiave {key}; di nuovo {token}.");
        let out = redact(&text, &[token.clone(), key.clone()]);
        assert!(!out.contains(&token), "{out}");
        assert!(!out.contains(&key), "{out}");
        assert_eq!(out.matches(HIDDEN).count(), 3, "{out}");
    }

    #[test]
    fn the_longer_secret_goes_whole_when_it_contains_a_shorter_one() {
        let short = "abcdefgh12".to_string();
        let long = "prefisso-abcdefgh12-suffisso".to_string();
        assert_eq!(redact(&format!("x {long} y"), &[short, long]), format!("x {HIDDEN} y"));
    }

    #[test]
    fn short_values_and_blanks_are_not_secrets() {
        assert_eq!(redact("la chiave abc è corta", &["abc".into(), "   ".into(), String::new()]), "la chiave abc è corta");
    }
}
