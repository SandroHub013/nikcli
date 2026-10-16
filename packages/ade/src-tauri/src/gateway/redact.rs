//! Known secrets out of anything that leaves ADE through a gateway.
//!
//! A bot can read a file with a key in it, or echo an error that quotes one;
//! its reply then goes to a phone, a chat server and its history. Before any
//! send or edit, every value ADE knows to be secret — the gateway tokens and
//! the keys in the keychain — is replaced, and so is anything with the shape of
//! a key of the usual services (S6). Errors shown in the panel and log lines go
//! through the same function.

/// What a secret becomes.
pub const HIDDEN: &str = "[nascosto]";

/// Values shorter than this are not treated as secrets: replacing a
/// three-letter "key" would mangle ordinary words.
const MIN_SECRET: usize = 8;

/// Secrets of at least this length also hide by their head and tail (`FRAGMENT` characters each): a key split over
/// two lines, or cut by a chunker, still shows one of them whole.
const FRAGMENT_FROM: usize = 32;
const FRAGMENT: usize = 16;

/// `text` with every occurrence of each of `secrets` replaced by `[nascosto]`, then whatever has the shape of a key
/// (review of the bots, S6). The longest first, so a secret that contains another goes whole.
///
/// The one place a gateway's outgoing text is cleaned: every send, edit and error goes through it. Two layers:
/// - the values ADE knows (`secrets`), as they are, in base64, percent-encoded, and by their head and tail when they
///   are long;
/// - the shapes of the keys of the usual services, which ADE does not know: a `.env` the bot read, `~/.aws`, `.npmrc`,
///   an error that quotes a header (`known_shapes`).
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut known: Vec<String> = Vec::new();
    for secret in secrets.iter().map(|secret| secret.trim()).filter(|secret| secret.chars().count() >= MIN_SECRET) {
        known.push(secret.to_string());
        known.extend(variants(secret));
    }
    known.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    known.dedup();
    let mut out = text.to_string();
    for secret in &known {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), HIDDEN);
        }
    }
    hide_assignments(&hide_url_credentials(&known_shapes(&out)))
}

/// The same secret as it turns up in a log or a URL: base64 (both alphabets, with and without padding),
/// percent-encoded, and, when long, its head and its tail.
fn variants(secret: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = secret.as_bytes();
    for url in [false, true] {
        let padded = base64(bytes, url);
        let bare = padded.trim_end_matches('=').to_string();
        out.push(padded);
        out.push(bare);
    }
    let encoded = percent_encode(secret);
    if encoded != secret {
        out.push(encoded);
    }
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() >= FRAGMENT_FROM {
        out.push(chars[..FRAGMENT].iter().collect());
        out.push(chars[chars.len() - FRAGMENT..].iter().collect());
    }
    out.retain(|variant| variant != secret && variant.chars().count() >= MIN_SECRET);
    out
}

fn base64(bytes: &[u8], url: bool) -> String {
    let alphabet: &[u8] = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(alphabet[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn is_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn is_alnum(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

fn is_alnum_dash(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

/// How many bytes at the start of `rest` are `class`.
fn run(rest: &[u8], class: fn(u8) -> bool) -> usize {
    rest.iter().take_while(|byte| class(**byte)).count()
}

/// Prefix, then at least `min` characters of the class: the keys of Anthropic, OpenRouter, OpenAI, xAI, GitHub,
/// Slack and Google.
const PREFIXED: &[(&str, usize, fn(u8) -> bool)] = &[
    ("sk-ant-", 20, is_token),
    ("sk-or-", 20, is_token),
    ("sk-", 20, is_token),
    ("xai-", 20, is_token),
    ("github_pat_", 20, is_token),
    ("ghp_", 20, is_alnum),
    ("gho_", 20, is_alnum),
    ("ghu_", 20, is_alnum),
    ("ghs_", 20, is_alnum),
    ("ghr_", 20, is_alnum),
    ("xoxb-", 10, is_alnum_dash),
    ("xoxa-", 10, is_alnum_dash),
    ("xoxp-", 10, is_alnum_dash),
    ("xoxr-", 10, is_alnum_dash),
    ("xoxs-", 10, is_alnum_dash),
    ("xapp-", 10, is_alnum_dash),
    ("AIza", 35, is_token),
    // Stripe (with an underscore, not a dash), Hugging Face, Google OAuth, SendGrid, GitLab (N3).
    ("sk_live_", 16, is_token),
    ("rk_live_", 16, is_token),
    ("sk_test_", 16, is_token),
    ("whsec_", 16, is_token),
    ("hf_", 30, is_alnum),
    ("ya29.", 20, is_token_dot),
    ("SG.", 30, is_token_dot),
    ("glpat-", 20, is_token),
];

fn is_token_dot(byte: u8) -> bool {
    is_token(byte) || byte == b'.'
}

/// The length of the key that starts at the beginning of `rest`, if one does. The caller has checked that nothing
/// word-like comes before it, so `risk-assessment-of-the-whole-plan` is not a key.
fn key_at(rest: &[u8]) -> Option<usize> {
    for (prefix, min, class) in PREFIXED {
        if rest.starts_with(prefix.as_bytes()) {
            let tail = run(&rest[prefix.len()..], *class);
            if tail >= *min {
                return Some(prefix.len() + tail);
            }
        }
    }
    // AWS access key id: four letters and sixteen capitals or digits, whole.
    if (rest.starts_with(b"AKIA") || rest.starts_with(b"ASIA"))
        && run(&rest[4..], |b| b.is_ascii_uppercase() || b.is_ascii_digit()) == 16
    {
        return Some(20);
    }
    // JWT: three base64url parts, the first from `eyJ`.
    if rest.starts_with(b"eyJ") {
        let first = run(rest, is_token);
        if first >= 10 && rest.get(first) == Some(&b'.') {
            let second = run(&rest[first + 1..], is_token);
            if second >= 8 && rest.get(first + 1 + second) == Some(&b'.') {
                let third = run(&rest[first + second + 2..], is_token);
                if third >= 8 {
                    return Some(first + second + 2 + third);
                }
            }
        }
    }
    // Telegram: eight to ten digits, a colon, thirty-five or more of the token class.
    let digits = run(rest, |b| b.is_ascii_digit());
    if (8..=10).contains(&digits) && rest.get(digits) == Some(&b':') {
        let tail = run(&rest[digits + 1..], is_token);
        if tail >= 35 {
            return Some(digits + 1 + tail);
        }
    }
    // An Authorization header's value.
    if rest.starts_with(b"Bearer ") {
        let tail = run(&rest[7..], |b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b));
        if tail >= 20 {
            return Some(7 + tail);
        }
    }
    None
}

/// `text` with the keys of the usual services and private-key blocks hidden.
fn known_shapes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut previous_word = false;
    while at < text.len() {
        if text[at..].starts_with("-----BEGIN ") {
            let header_end = text[at..].find("-----\n").or_else(|| text[at..].find("-----\r")).map(|i| at + i + 5);
            if header_end.is_some_and(|end| text[at..end].contains("PRIVATE KEY")) {
                // To the matching END line, or to the end of the text: a key cut short is still a key.
                let end = text[at..]
                    .find("-----END ")
                    .and_then(|i| text[at + i + 9..].find("-----").map(|j| at + i + 9 + j + 5));
                out.push_str(HIDDEN);
                at = end.unwrap_or(text.len());
                previous_word = false;
                continue;
            }
        }
        if !previous_word {
            if let Some(len) = key_at(&bytes[at..]) {
                out.push_str(HIDDEN);
                at += len;
                previous_word = true;
                continue;
            }
        }
        let ch = text[at..].chars().next().expect("a char at a boundary");
        previous_word = ch.is_ascii_alphanumeric() || ch == '_';
        out.push(ch);
        at += ch.len_utf8();
    }
    out
}

/// The words of a variable's name that say its value is a secret.
const SECRET_WORDS: &[&str] = &["key", "token", "secret", "password", "passwd", "pwd", "credential", "credentials", "apikey", "auth", "authorization"];
/// And the endings that say it when the name is in camel case or run together (`apiKey`, `accesstoken`).
const SECRET_ENDINGS: &[&str] = &["apikey", "accesskey", "privatekey", "token", "secret", "password", "passwd"];

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.split(['_', '-', '.']).any(|word| SECRET_WORDS.contains(&word)) || SECRET_ENDINGS.iter().any(|end| lower.ends_with(end))
}

/// Whether `at` is the first word of its line: only blanks, and a YAML `- `, before it.
fn starts_a_line(text: &str, at: usize) -> bool {
    let before = &text[..at];
    let line = &before[before.rfind('\n').map_or(0, |i| i + 1)..];
    matches!(line.trim_matches([' ', '\t']), "" | "-")
}

/// `NAME=value` where the name says secret (`DB_PASSWORD`, `api_key`, `AWS_SECRET_ACCESS_KEY`, `?pwd=`), and
/// `"password": "value"` in JSON, `password: value` in YAML or INI and `X-Api-Key: value` or `Authorization: Basic
/// value` as headers: the value is hidden, the name stays. A colon counts only after a quoted name, as the first
/// word of a line or right after an opening quote, so «the token: expired» is left alone. A bare value ends at an
/// `&` only inside a query string. A value of under four characters, or one that is another variable
/// (`$OTHER`), is not hidden (N3).
fn hide_assignments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut last, mut at) = (0, 0);
    while at < bytes.len() {
        let separator = bytes[at];
        if separator == b'=' || separator == b':' {
            let mut end = at;
            while end > 0 && bytes[end - 1] == b' ' {
                end -= 1;
            }
            let quoted = end > 0 && matches!(bytes[end - 1], b'"' | b'\'');
            if quoted {
                end -= 1;
            }
            let mut begin = end;
            while begin > 0 && is_name_byte(bytes[begin - 1]) {
                begin -= 1;
            }
            // A colon counts after a quoted name (JSON), as the first word of a line (YAML, INI, a header) and right
            // after an opening quote (`curl -H "Authorization: …"`); `=` counts anywhere.
            let colon_ok = quoted || starts_a_line(text, begin) || (begin > 0 && matches!(bytes[begin - 1], b'"' | b'\''));
            if (separator == b'=' || colon_ok) && begin < end && secret_name(&text[begin..end]) {
                let query = begin > 0 && matches!(bytes[begin - 1], b'?' | b'&');
                let mut start = at + 1;
                while start < bytes.len() && bytes[start] == b' ' {
                    start += 1;
                }
                // `Authorization: Basic dXNlcjpw`: the secret is what follows the scheme, which stays readable.
                if text[begin..end].to_ascii_lowercase().ends_with("authorization") {
                    let mut after = start;
                    while after < bytes.len() && !bytes[after].is_ascii_whitespace() {
                        after += 1;
                    }
                    let scheme_end = after;
                    while after < bytes.len() && matches!(bytes[after], b' ' | b'\t') {
                        after += 1;
                    }
                    if scheme_end > start && after > scheme_end && after < bytes.len() && !matches!(bytes[after], b'\n' | b'\r') {
                        start = after;
                    }
                }
                // A quoted value runs to its closing quote (it may hold spaces); a bare one, to the next blank.
                let opening = bytes.get(start).copied().filter(|b| matches!(b, b'"' | b'\''));
                if opening.is_some() {
                    start += 1;
                }
                let mut stop = start;
                while stop < bytes.len() && bytes[stop] != b'\n' {
                    let ends = match opening {
                        Some(quote) => bytes[stop] == quote,
                        // `&` ends a bare value only in a query string (`?pwd=abc&x=1`), whose next field is not the
                        // secret; in a `.env` it is part of the password.
                        None => bytes[stop].is_ascii_whitespace() || matches!(bytes[stop], b'"' | b'\'') || (query && bytes[stop] == b'&'),
                    };
                    if ends {
                        break;
                    }
                    stop += 1;
                }
                let value = &text[start..stop];
                if value.chars().count() >= 4 && !value.starts_with(HIDDEN) && !value.starts_with('$') {
                    out.push_str(&text[last..start]);
                    out.push_str(HIDDEN);
                    last = stop;
                    at = stop;
                    continue;
                }
            }
        }
        at += 1;
    }
    out.push_str(&text[last..]);
    out
}

/// `scheme://user:password@host`: the password is hidden, the rest of the address is not (N3). A user with no
/// password (`mail://utente@host`) is left alone.
fn hide_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find("://") {
        let after = found + 3;
        out.push_str(&rest[..after]);
        rest = &rest[after..];
        let authority_end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\'' | '<' | '>'))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        match (authority.rfind('@'), authority.find(':')) {
            (Some(at), Some(colon)) if colon < at && at > colon + 1 && !authority[colon + 1..at].starts_with(HIDDEN) => {
                out.push_str(&authority[..=colon]);
                out.push_str(HIDDEN);
                out.push_str(&authority[at..]);
                rest = &rest[authority_end..];
            }
            _ => {}
        }
    }
    out.push_str(rest);
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

    /* S6: the layer of shapes, for keys ADE does not know. */
    const SAMPLES: &[(&str, &str)] = &[
        ("anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf"),
        ("openrouter", "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef"),
        ("openai", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
        ("xai", "xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
        ("github classic", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
        ("github oauth", "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
        ("github fine-grained", "github_pat_11ABCDEFG0AbCdEfGhIjKl_mNoPqRsTuVwXyZ0123456789"),
        ("slack bot", "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx"),
        ("slack app", "xapp-1-A0123456789-1234567890123-0123456789abcdef"),
        ("aws", "AKIAIOSFODNN7EXAMPLE"),
        ("google", "AIzaSyA-AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
        ("jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
        ("telegram", "123456789:AAFabcdefghijklmnopqrstuvwxyz0123456"),
        ("bearer", "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.-_~+/="),
    ];

    #[test]
    fn the_keys_of_the_usual_services_are_hidden_without_being_known() {
        for (name, key) in SAMPLES {
            let out = redact(&format!("errore: la richiesta con {key} è stata rifiutata"), &[]);
            assert_eq!(out, format!("errore: la richiesta con {HIDDEN} è stata rifiutata"), "{name}");
        }
    }

    #[test]
    fn a_dotenv_and_an_aws_credentials_file_read_by_a_bot_lose_their_values() {
        let text = "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\nGITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n";
        let out = redact(text, &[]);
        assert_eq!(
            out,
            format!("ANTHROPIC_API_KEY={HIDDEN}\nGITHUB_TOKEN={HIDDEN}\n[default]\naws_access_key_id = {HIDDEN}\n")
        );
    }

    #[test]
    fn a_private_key_block_goes_whole_and_one_cut_short_goes_to_the_end() {
        let block = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAB3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(redact(&format!("prima\n{block}\ndopo"), &[]), format!("prima\n{HIDDEN}\ndopo"));
        let cut = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecondariga";
        assert_eq!(redact(&format!("ecco\n{cut}"), &[]), format!("ecco\n{HIDDEN}"));
        // A public key or a certificate is not a secret.
        let public = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----";
        assert_eq!(redact(public, &[]), public);
    }

    #[test]
    fn ordinary_words_and_ids_are_left_alone() {
        for text in [
            "risk-assessment-of-the-whole-plan-for-next-year",
            "task-sk-non-una-chiave",
            "disk-abcdefghijklmnopqrstuvwxyz",
            "ghp_corto",
            "xoxb-1",
            "AKIA corta",
            "il numero 1234567890 e 12:30:45 e 123456789:corto",
            "eyJ non è un token",
            "Bearer corto",
            "https://example.com/a/b?c=d",
            "commit 4f9c2d1e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e",
            "ciao, com'è? àèìòù — tutto in ordine",
        ] {
            assert_eq!(redact(text, &[]), text, "{text}");
        }
    }

    #[test]
    fn a_key_after_punctuation_or_in_a_url_is_found() {
        let key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        for text in [format!("({key})"), format!("key={key}&x=1"), format!("\"{key}\""), format!("https://x.y/?token={key}")] {
            assert!(!redact(&text, &[]).contains("AbCdEfGhIjKl"), "{text}");
        }
    }

    #[test]
    fn a_known_secret_is_also_hidden_in_base64_percent_encoded_and_cut_in_two() {
        let secret = "chiave/segreta+di test=0123456789-ABCDEFGHIJKLMNOP".to_string();
        let b64 = base64(secret.as_bytes(), false);
        let b64_bare = b64.trim_end_matches('=').to_string();
        let b64_url = base64(secret.as_bytes(), true);
        let pct = percent_encode(&secret);
        for variant in [&b64, &b64_bare, &b64_url, &pct] {
            let out = redact(&format!("header: {variant} fine"), &[secret.clone()]);
            assert!(!out.contains(variant.trim_end_matches('=')), "{variant} -> {out}");
        }
        // Split over two lines: its head and its tail still show whole.
        let head: String = secret.chars().take(FRAGMENT).collect();
        let tail: String = secret.chars().skip(secret.chars().count() - FRAGMENT).collect();
        let out = redact(&format!("{head}\n{tail}"), &[secret.clone()]);
        assert_eq!(out, format!("{HIDDEN}\n{HIDDEN}"));
    }

    /* N3: the shapes a `.env` has besides the known keys. */
    #[test]
    fn the_value_of_a_name_that_says_secret_is_hidden() {
        let text = "DB_PASSWORD=hunter2hunter2\nSTRIPE_SECRET=abcd1234\napi_key = \"zzzz-1111\"\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n{\"password\": \"correct horse\", \"token\":\"t0k3n-valore\"}\nfoo?pwd=abc12345&x=1";
        let out = redact(text, &[]);
        for leaked in ["hunter2", "abcd1234", "zzzz-1111", "wJalrXUtnFEMI", "correct", "t0k3n-valore", "abc12345"] {
            assert!(!out.contains(leaked), "{leaked} in {out}");
        }
        assert!(out.contains("DB_PASSWORD=[nascosto]\n"), "{out}");
        assert!(out.contains("&x=1"), "{out}");
    }

    #[test]
    fn the_password_in_a_url_is_hidden_and_the_rest_of_it_is_not() {
        let out = redact("DATABASE_URL: postgres://utente:p4ss%40word@db.example.com:5432/app e https://example.com/a", &[]);
        assert!(!out.contains("p4ss"), "{out}");
        assert!(out.contains("postgres://utente:[nascosto]@db.example.com:5432/app"), "{out}");
        assert!(out.contains("https://example.com/a"), "{out}");
        assert_eq!(redact("mail://solo-utente@host/x", &[]), "mail://solo-utente@host/x");
    }

    #[test]
    fn more_shapes_of_keys() {
        for key in [
            "sk_live_AbCdEfGhIjKlMnOpQrStUvWx",
            "rk_live_AbCdEfGhIjKlMnOpQrStUvWx",
            "sk_test_AbCdEfGhIjKlMnOpQrStUvWx",
            "hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
            "ya29.a0AfH6SMBAbCdEfGhIjKlMnOpQrStUvWx",
            "SG.AbCdEfGhIjKlMnOpQrStUv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg",
            "glpat-AbCdEfGhIjKlMnOpQrSt",
        ] {
            assert_eq!(redact(&format!("errore con {key} fine"), &[]), format!("errore con {HIDDEN} fine"), "{key}");
        }
    }

    #[test]
    fn names_that_only_look_like_secrets_are_left_alone() {
        for text in [
            "monkey=banana",
            "keyboard=us",
            "max_tokens=4096",
            "author=ale",
            "tokenizer=bpe",
            "the token: expired",
            "password reset needed",
            "key=ab",
            "TOKEN=$OTHER_VARIABLE",
        ] {
            assert_eq!(redact(text, &[]), text, "{text}");
        }
    }

    /* N3, second round: YAML and INI with a colon, headers, a bare value with an `&`. */
    #[test]
    fn yaml_and_ini_with_a_colon_and_headers_lose_their_values() {
        let text = "services:\n  db:\n    password: s3cret-value\n  - token: abcd1234efgh\nX-Api-Key: k3y-v4lue-9999\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\ncurl -H \"Authorization: Basic QWxhZGRpbjpvcGVu\" https://x.y/z\nproxy-authorization: Digest abcdef123456\n";
        let out = redact(text, &[]);
        for leaked in ["s3cret-value", "abcd1234efgh", "k3y-v4lue", "dXNlcjpw", "QWxhZGRpbjpvcGVu", "abcdef123456"] {
            assert!(!out.contains(leaked), "{leaked} in {out}");
        }
        assert!(out.contains("password: [nascosto]"), "{out}");
        assert!(out.contains("Authorization: Basic [nascosto]"), "{out}");
        assert!(out.contains("services:\n  db:\n"), "{out}");
        assert!(out.contains("https://x.y/z"), "{out}");
        // A Bearer value goes whole through the first layer (the word too), and is not hidden twice.
        assert_eq!(
            redact("Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", &[]),
            format!("Authorization: {HIDDEN}")
        );
    }

    #[test]
    fn a_bare_value_is_cut_at_an_ampersand_only_inside_a_query_string() {
        let out = redact("DB_PASSWORD=p4ss&w0rd\nurl?pwd=abc12345&x=1&token=zzzz9999&y=2", &[]);
        assert!(!out.contains("w0rd") && !out.contains("abc12345") && !out.contains("zzzz9999"), "{out}");
        assert!(out.contains("DB_PASSWORD=[nascosto]\n"), "{out}");
        assert!(out.contains("&x=1&") && out.ends_with("&y=2"), "{out}");
    }

    #[test]
    fn a_colon_after_an_ordinary_word_is_still_left_alone() {
        for text in ["monkey: banana", "Note: key rotation planned", "token: ab", "il token: scaduto ieri", "a: b: c"] {
            assert_eq!(redact(text, &[]), text, "{text}");
        }
    }

    #[test]
    fn base64_is_the_real_one() {
        assert_eq!(base64(b"Man", false), "TWFu");
        assert_eq!(base64(b"Ma", false), "TWE=");
        assert_eq!(base64(b"M", false), "TQ==");
        assert_eq!(base64(&[0xfb, 0xff], true), "-_8=");
        assert_eq!(base64(&[0xfb, 0xff], false), "+/8=");
        assert_eq!(percent_encode("a b/c+d=é"), "a%20b%2Fc%2Bd%3D%C3%A9");
    }
}
