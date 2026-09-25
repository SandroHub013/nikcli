//! A reply cut into messages a platform accepts, without breaking a code block.
//!
//! Cuts fall between lines where they can, then between words, and only
//! inside a word when a word is longer than a message. A cut inside a fenced code block closes the fence at the end of
//! the piece and opens it again, with its language, at the start of the next,
//! so each message shows its part of the code as code.

/// How a platform counts a message's length: Telegram counts UTF-16 units.
pub type Units = fn(&str) -> usize;

pub fn utf16(text: &str) -> usize {
    text.encode_utf16().count()
}

const FENCE: &str = "```";

/// `text` in pieces of at most `max` units, blank pieces left out.
pub fn split(text: &str, max: usize, units: Units) -> Vec<String> {
    if units(text) <= max {
        return if text.trim().is_empty() { Vec::new() } else { vec![text.to_string()] };
    }
    let close = units("\n```");
    let mut pieces = Vec::new();
    let mut current = String::new();
    // The line that opened the fence we are in, as it must be reopened.
    let mut fence: Option<String> = None;
    for line in text.split_inclusive('\n') {
        let is_fence = line.trim_start().starts_with(FENCE);
        let fence_after = match (&fence, is_fence) {
            (Some(_), true) => None,
            (None, true) => Some(line.trim().to_string()),
            (open, false) => open.clone(),
        };
        // Room for closing the fence if the piece has to end inside one.
        let reserve = if fence.is_some() || fence_after.is_some() { close } else { 0 };
        if units(&current) + units(line) + reserve <= max {
            current.push_str(line);
            fence = fence_after;
            continue;
        }
        // The line does not fit: end this piece, then put the line (in parts if it is too long) in the next.
        flush(&mut pieces, &mut current, fence.as_deref());
        let reopen = fence.as_ref().map(|open| format!("{open}\n")).unwrap_or_default();
        let room = max.saturating_sub(units(&reopen) + reserve).max(1);
        let mut rest = line;
        while units(rest) > room {
            let (head, tail) = cut(rest, room, units);
            current.push_str(head);
            flush(&mut pieces, &mut current, fence.as_deref());
            rest = tail;
        }
        current.push_str(rest);
        fence = fence_after;
    }
    flush(&mut pieces, &mut current, None);
    pieces
}

/// Ends the piece being built, closing `fence` if it is open, and starts the
/// next one reopening it.
fn flush(pieces: &mut Vec<String>, current: &mut String, fence: Option<&str>) {
    let body = current.trim_end();
    let only_reopen = fence.is_some_and(|open| body == open);
    if !body.trim().is_empty() && !only_reopen {
        let mut piece = body.to_string();
        if fence.is_some() {
            piece.push('\n');
            piece.push_str(FENCE);
        }
        pieces.push(piece);
    }
    current.clear();
    if let Some(open) = fence {
        current.push_str(open);
        current.push('\n');
    }
}

/// `text` split at most `room` units in: after the last space in that span
/// when there is one in its second half, else just at the limit (never inside
/// a character).
fn cut(text: &str, room: usize, units: Units) -> (&str, &str) {
    let mut end = 0;
    let mut space = None;
    for (index, c) in text.char_indices() {
        let next = index + c.len_utf8();
        if units(&text[..next]) > room {
            break;
        }
        end = next;
        if c == ' ' && units(&text[..next]) * 2 > room {
            space = Some(next);
        }
    }
    let at = space.unwrap_or(end).max(text.chars().next().map_or(0, char::len_utf8));
    text.split_at(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> usize {
        text.chars().count()
    }

    #[test]
    fn a_short_text_is_one_piece_and_a_blank_one_none() {
        assert_eq!(split("ciao", 10, chars), vec!["ciao"]);
        assert!(split("  \n ", 10, chars).is_empty());
    }

    #[test]
    fn pieces_end_between_lines_and_respect_the_limit() {
        let text = "prima riga\nseconda riga\nterza riga\n";
        let pieces = split(text, 25, chars);
        assert_eq!(pieces, vec!["prima riga\nseconda riga", "terza riga"]);
        assert!(pieces.iter().all(|piece| chars(piece) <= 25));
    }

    #[test]
    fn a_long_line_is_cut_between_words_and_a_long_word_anywhere() {
        let pieces = split("uno due tre quattro cinque sei sette", 12, chars);
        assert!(pieces.iter().all(|piece| chars(piece) <= 12), "{pieces:?}");
        assert_eq!(pieces.join(" ").split_whitespace().collect::<Vec<_>>().join(" "), "uno due tre quattro cinque sei sette");
        let word = "x".repeat(30);
        let pieces = split(&word, 12, chars);
        assert_eq!(pieces.concat(), word);
        assert!(pieces.iter().all(|piece| chars(piece) <= 12));
    }

    #[test]
    fn a_code_block_cut_in_two_is_closed_and_reopened_with_its_language() {
        let code: String = (1..=12).map(|n| format!("let riga_{n} = {n};\n")).collect();
        let text = format!("Ecco:\n```rust\n{code}```\nFine.");
        let pieces = split(&text, 80, chars);
        assert!(pieces.len() > 2, "{pieces:?}");
        for piece in &pieces {
            assert!(chars(piece) <= 80, "{piece}");
            // Every piece has its fences in pairs.
            assert_eq!(piece.matches("```").count() % 2, 0, "{piece}");
        }
        assert!(pieces[1].starts_with("```rust\n"), "{:?}", pieces[1]);
        assert!(pieces[0].ends_with("\n```"), "{:?}", pieces[0]);
        // No line of code lost or doubled.
        let rebuilt = pieces.join("\n");
        for n in 1..=12 {
            assert_eq!(rebuilt.matches(&format!("let riga_{n} = {n};")).count(), 1);
        }
        assert!(pieces.last().unwrap().ends_with("Fine."));
    }

    #[test]
    fn telegram_counts_utf16_units() {
        assert_eq!(utf16("😀"), 2);
        let pieces = split(&"😀".repeat(10), 8, utf16);
        assert!(pieces.iter().all(|piece| utf16(piece) <= 8), "{pieces:?}");
        assert_eq!(pieces.concat(), "😀".repeat(10));
    }
}
