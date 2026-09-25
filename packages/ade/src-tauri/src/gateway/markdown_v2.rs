//! A reply's Markdown as Telegram's MarkdownV2.
//!
//! MarkdownV2 wants every one of `_*[]()~`>#+-=|{}.!\` escaped outside its
//! entities, and only `` ` `` and `\` inside code. What an agent writes is
//! ordinary Markdown, so this keeps what Telegram can show — bold, italic,
//! inline code, code blocks with their language, links, headings as bold —
//! and escapes the rest. Anything it gets wrong Telegram refuses, and the
//! adapter sends the piece again as plain text: a reply is never lost to
//! formatting.

const SPECIAL: &str = "_*[]()~`>#+-=|{}.!\\";

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if SPECIAL.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn escape_code(text: &str) -> String {
    text.replace('\\', "\\\\").replace('`', "\\`")
}

fn escape_url(text: &str) -> String {
    text.replace('\\', "\\\\").replace(')', "\\)")
}

pub fn to_markdown_v2(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let mut in_fence = false;
    for line in text.split_inclusive('\n') {
        let (body, end) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        let trimmed = body.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            if in_fence {
                out.push_str("```");
            } else {
                // Only a plain language name: anything else would have to be escaped.
                let language: String = info.trim().chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-')).collect();
                out.push_str("```");
                out.push_str(&language);
            }
            in_fence = !in_fence;
        } else if in_fence {
            out.push_str(&escape_code(body));
        } else if let Some(title) = heading(body) {
            out.push('*');
            out.push_str(&escape(title));
            out.push('*');
        } else {
            out.push_str(&inline(body));
        }
        out.push_str(end);
    }
    if in_fence {
        // An unclosed block: closed, or Telegram refuses the whole message.
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("```");
    }
    out
}

/// `# Title` … `###### Title`: the title.
fn heading(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    let title = rest.strip_prefix(' ')?.trim();
    (!title.is_empty()).then_some(title)
}

/// One line outside code blocks.
fn inline(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // `code`
        if c == '`' {
            if let Some(end) = find(&chars, i + 1, &['`']) {
                let inner: String = chars[i + 1..end].iter().collect();
                if !inner.is_empty() {
                    out.push('`');
                    out.push_str(&escape_code(&inner));
                    out.push('`');
                    i = end + 1;
                    continue;
                }
            }
        }
        // **bold**
        if c == '*' && chars.get(i + 1) == Some(&'*') {
            if let Some(end) = find(&chars, i + 2, &['*', '*']) {
                let inner: String = chars[i + 2..end].iter().collect();
                if tight(&inner) {
                    out.push('*');
                    out.push_str(&escape(&inner));
                    out.push('*');
                    i = end + 2;
                    continue;
                }
            }
        }
        // *italic* or _italic_, not inside a word (snake_case stays as it is)
        if (c == '*' || c == '_') && !word_before(&chars, i) {
            if let Some(end) = find(&chars, i + 1, &[c]) {
                let inner: String = chars[i + 1..end].iter().collect();
                let after_is_word = chars.get(end + 1).is_some_and(|next| next.is_alphanumeric());
                if tight(&inner) && !after_is_word {
                    out.push('_');
                    out.push_str(&escape(&inner));
                    out.push('_');
                    i = end + 1;
                    continue;
                }
            }
        }
        // [text](https://…)
        if c == '[' {
            if let Some(close) = find(&chars, i + 1, &[']', '(']) {
                if let Some(end) = find(&chars, close + 2, &[')']) {
                    let label: String = chars[i + 1..close].iter().collect();
                    let url: String = chars[close + 2..end].iter().collect();
                    if !label.is_empty() && (url.starts_with("https://") || url.starts_with("http://")) && !url.contains(' ') {
                        out.push('[');
                        out.push_str(&escape(&label));
                        out.push_str("](");
                        out.push_str(&escape_url(&url));
                        out.push(')');
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        if SPECIAL.contains(c) {
            out.push('\\');
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Where `pattern` next starts, from `from`.
fn find(chars: &[char], from: usize, pattern: &[char]) -> Option<usize> {
    (from..chars.len().saturating_sub(pattern.len() - 1)).find(|&at| chars[at..at + pattern.len()] == *pattern)
}

/// Emphasis only around text that does not start or end with a space.
fn tight(inner: &str) -> bool {
    !inner.is_empty() && !inner.starts_with(char::is_whitespace) && !inner.ends_with(char::is_whitespace)
}

fn word_before(chars: &[char], at: usize) -> bool {
    at > 0 && chars[at - 1].is_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_has_every_special_character_escaped() {
        assert_eq!(to_markdown_v2("Fatto. 3+4=7 (ok)! #1 a-b"), "Fatto\\. 3\\+4\\=7 \\(ok\\)\\! \\#1 a\\-b");
        assert_eq!(to_markdown_v2("un \\ solo"), "un \\\\ solo");
    }

    #[test]
    fn bold_italic_code_links_and_headings() {
        assert_eq!(to_markdown_v2("**forte** e *corsivo* e _anche_"), "*forte* e _corsivo_ e _anche_");
        assert_eq!(to_markdown_v2("usa `a_b.c()` qui"), "usa `a_b.c()` qui");
        assert_eq!(to_markdown_v2("[la guida](https://esempio.it/a_b?x=1)."), "[la guida](https://esempio.it/a_b?x=1)\\.");
        assert_eq!(to_markdown_v2("## Il piano."), "*Il piano\\.*");
    }

    #[test]
    fn what_only_looks_like_markdown_is_escaped() {
        assert_eq!(to_markdown_v2("snake_case_name"), "snake\\_case\\_name");
        assert_eq!(to_markdown_v2("2 * 3 * 4"), "2 \\* 3 \\* 4");
        assert_eq!(to_markdown_v2("un ` solo"), "un \\` solo");
        assert_eq!(to_markdown_v2("[non](un link)"), "\\[non\\]\\(un link\\)");
    }

    #[test]
    fn a_code_block_keeps_its_language_and_escapes_only_backticks_and_backslashes() {
        let text = "Ecco:\n```rust\nlet s = \"a\\n\"; // `x`\n```\nFine.";
        assert_eq!(to_markdown_v2(text), "Ecco:\n```rust\nlet s = \"a\\\\n\"; // \\`x\\`\n```\nFine\\.");
        // One left open is closed.
        assert_eq!(to_markdown_v2("```\ncodice"), "```\ncodice\n```");
    }
}
