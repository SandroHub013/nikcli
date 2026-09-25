//! Pairing: how a stranger who writes to a bot becomes someone it answers.
//!
//! The stranger gets a code in the chat; the user types it in ADE, and only
//! then is that account authorized. Nobody can approve from a chat: the only
//! way to `approve` is a command of ADE's own window. So a code in the wrong
//! hands is worth nothing without the user's computer.
//!
//! A code is 8 characters from an alphabet without look-alikes (no I, O, 0,
//! 1), kept only as a salted hash and compared in constant time. It lasts an
//! hour; a sender gets at most one every 10 minutes; at most 3 wait at once;
//! 5 wrong codes typed in ADE lock approvals for an hour. Everything here is
//! saved with the link, so a restart forgets none of it.
//!
//! Codes go out only while pairing is open: until the first account is
//! paired, and after that for 10 minutes each time the user asks for it in
//! ADE. The bots answer only the user's own accounts (D92), so once one is in,
//! a stranger writing gets silence rather than a code — no requests to wade
//! through, and nothing that says the bot is there.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LEN: usize = 8;
pub const CODE_TTL_MS: u64 = 60 * 60 * 1000;
pub const REQUEST_EVERY_MS: u64 = 10 * 60 * 1000;
pub const MAX_PENDING: usize = 3;
pub const MAX_FAILURES: u32 = 5;
pub const LOCKOUT_MS: u64 = 60 * 60 * 1000;
/// How long pairing stays open when the user opens it from ADE.
pub const OPEN_MS: u64 = 10 * 60 * 1000;
/// How much of a sender's name is kept: it is untrusted text, for display only.
const NAME_LEN: usize = 64;

/// A link's pairing state, saved with it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    #[serde(default)]
    pub pending: Vec<Pending>,
    /// When each sender last got a code: one every `REQUEST_EVERY_MS`.
    #[serde(default)]
    pub asked: Vec<Asked>,
    /// Wrong codes typed in ADE since the last right one or the last lockout.
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub locked_until_ms: Option<u64>,
    /// Until when the user opened pairing from ADE, with someone already paired.
    #[serde(default)]
    pub open_until_ms: Option<u64>,
}

/// A request waiting for the user. Holds the code's hash, never the code.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// Its own id, for refusing it from the panel; unrelated to the code.
    pub request: String,
    pub sender: String,
    pub name: String,
    /// The chat the code went to, answered once the sender is approved.
    pub chat: String,
    pub salt: String,
    pub code_hash: String,
    pub created_ms: u64,
    pub expires_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub sender: String,
    pub at_ms: u64,
}

/// What became of a stranger's message.
#[derive(Debug, PartialEq)]
pub enum Request {
    /// A new code, to send to the chat. The request keeps only its hash.
    Code { code: String, pending: Pending },
    /// They already got one less than 10 minutes ago: nothing is sent.
    Waiting,
    /// Pairing is not open, three requests already wait, or approvals are locked.
    Closed,
}

/// Where the random bytes come from: the OS, or a fixed sequence in the tests.
pub type Random<'a> = &'a mut dyn FnMut(&mut [u8]) -> Result<(), String>;

pub fn os_random(buffer: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buffer).map_err(|e| format!("generatore casuale del sistema: {e}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn code_hash(salt: &str, code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(code.as_bytes());
    hex(&hasher.finalize())
}

/// Equal without saying, by how long it took, how much of it was.
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// `ABCD-EFGH`: easier to read off a phone and type.
pub fn show(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

/// What was typed, as a code: upper case, without spaces or dashes. `None` if
/// it cannot be one, which is a typo and not a guess, so it does not count.
fn normalize(typed: &str) -> Option<String> {
    let code: String = typed.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
    (code.len() == CODE_LEN && code.bytes().all(|b| ALPHABET.contains(&b))).then_some(code)
}

/// Characters that turn the text after them around, so «Ale» could read as another name.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// A sender's name as the panel may show it: no control or direction
/// characters, not too long.
pub fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control() && !is_bidi_control(*c)).collect();
    let name = name.trim();
    if name.chars().count() > NAME_LEN {
        format!("{}…", name.chars().take(NAME_LEN).collect::<String>())
    } else {
        name.to_string()
    }
}

impl Pairing {
    /// Forgets what expired: old requests, old rate limits, a past lockout.
    pub fn prune(&mut self, now: u64) {
        self.pending.retain(|pending| pending.expires_ms > now);
        self.asked.retain(|asked| asked.at_ms + REQUEST_EVERY_MS > now);
        if self.locked_until_ms.is_some_and(|until| until <= now) {
            self.locked_until_ms = None;
        }
        if self.open_until_ms.is_some_and(|until| until <= now) {
            self.open_until_ms = None;
        }
    }

    /// Whether a stranger writing gets a code: always while nobody is paired,
    /// otherwise only while the user has pairing open.
    pub fn is_open(&self, anyone_paired: bool, now: u64) -> bool {
        !anyone_paired || self.open_until_ms.is_some_and(|until| until > now)
    }

    /// The user asked, from ADE, to pair one more account.
    pub fn open(&mut self, now: u64) -> u64 {
        let until = now + OPEN_MS;
        self.open_until_ms = Some(until);
        until
    }

    pub fn locked(&self, now: u64) -> bool {
        self.locked_until_ms.is_some_and(|until| until > now)
    }

    /// A stranger wrote from `chat`: a code for them, unless pairing is not
    /// open, they just got one or no more requests may wait. A new code
    /// replaces their previous one.
    pub fn request(&mut self, sender: &str, name: &str, chat: &str, anyone_paired: bool, now: u64, random: Random) -> Result<Request, String> {
        self.prune(now);
        if !self.is_open(anyone_paired, now) {
            return Ok(Request::Closed);
        }
        if self.asked.iter().any(|asked| asked.sender == sender) {
            return Ok(Request::Waiting);
        }
        let others = self.pending.iter().filter(|pending| pending.sender != sender).count();
        if self.locked(now) || others >= MAX_PENDING {
            return Ok(Request::Closed);
        }
        let mut bytes = [0u8; CODE_LEN + 16 + 16];
        random(&mut bytes)?;
        // 256 is a multiple of 32: every character is equally likely.
        let code: String = bytes[..CODE_LEN].iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect();
        let salt = hex(&bytes[CODE_LEN..CODE_LEN + 16]);
        let pending = Pending {
            request: hex(&bytes[CODE_LEN + 16..]),
            sender: sender.to_string(),
            name: clean_name(name),
            chat: chat.to_string(),
            code_hash: code_hash(&salt, &code),
            salt,
            created_ms: now,
            expires_ms: now + CODE_TTL_MS,
        };
        self.pending.retain(|old| old.sender != sender);
        self.pending.push(pending.clone());
        self.asked.push(Asked { sender: sender.to_string(), at_ms: now });
        Ok(Request::Code { code, pending })
    }

    /// The user typed `typed` in ADE: the request it belongs to, taken out of
    /// the waiting ones. A wrong code counts; the fifth locks approvals for an
    /// hour. On `Err` the state still changed (a failure counted) and must be saved.
    pub fn approve(&mut self, typed: &str, now: u64) -> Result<Pending, String> {
        self.prune(now);
        if let Some(until) = self.locked_until_ms.filter(|until| *until > now) {
            let minutes = (until - now).div_ceil(60_000);
            return Err(format!("troppi codici sbagliati: l'abbinamento riapre tra {minutes} minuti"));
        }
        let Some(code) = normalize(typed) else {
            return Err(format!("il codice ha {CODE_LEN} caratteri, lettere e cifre come arriva in chat"));
        };
        // Every request is checked, so how long it takes says nothing of which matched.
        let mut found = None;
        for (index, pending) in self.pending.iter().enumerate() {
            if same(code_hash(&pending.salt, &code).as_bytes(), pending.code_hash.as_bytes()) {
                found = Some(index);
            }
        }
        match found {
            Some(index) => {
                self.failures = 0;
                // One account per opening: the next one needs asking again.
                self.open_until_ms = None;
                Ok(self.pending.remove(index))
            }
            None => {
                self.failures += 1;
                if self.failures >= MAX_FAILURES {
                    self.failures = 0;
                    self.locked_until_ms = Some(now + LOCKOUT_MS);
                    return Err("codice sbagliato: troppi tentativi, l'abbinamento resta chiuso per un'ora".into());
                }
                Err(format!("codice sbagliato o scaduto: restano {} tentativi", MAX_FAILURES - self.failures))
            }
        }
    }

    /// The user refused a request from the panel. Not a wrong code: nothing counts.
    pub fn reject(&mut self, request: &str) -> Result<Pending, String> {
        let index = self
            .pending
            .iter()
            .position(|pending| pending.request == request)
            .ok_or_else(|| "questa richiesta di abbinamento non c'è più".to_string())?;
        Ok(self.pending.remove(index))
    }

    pub fn attempts_left(&self, now: u64) -> u32 {
        if self.locked(now) {
            0
        } else {
            MAX_FAILURES - self.failures.min(MAX_FAILURES)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A counter as random bytes: each call gives different, known values.
    fn counter() -> impl FnMut(&mut [u8]) -> Result<(), String> {
        let mut next = 0u8;
        move |buffer: &mut [u8]| {
            for byte in buffer.iter_mut() {
                *byte = next;
                next = next.wrapping_add(7);
            }
            Ok(())
        }
    }

    fn code_of(request: Request) -> (String, Pending) {
        match request {
            Request::Code { code, pending } => (code, pending),
            other => panic!("nessun codice: {other:?}"),
        }
    }

    #[test]
    fn a_code_is_kept_only_as_a_salted_hash_and_opens_its_own_request() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (code, pending) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        assert_eq!(code.len(), CODE_LEN);
        assert!(code.bytes().all(|b| ALPHABET.contains(&b)));
        let saved = serde_json::to_string(&pairing).unwrap();
        assert!(!saved.contains(&code), "{saved}");
        assert_ne!(pending.request, code.to_lowercase());
        // The same code under another salt hashes differently.
        assert_ne!(code_hash("aa", &code), code_hash("bb", &code));
        let (other, _) = code_of(pairing.request("7", "Altro", "c7", false, 0, &mut random).unwrap());
        assert_ne!(code, other);
        // Typed as read off a phone: lower case, with the dash.
        let approved = pairing.approve(&show(&code).to_lowercase(), 1).unwrap();
        assert_eq!((approved.sender.as_str(), approved.chat.as_str()), ("42", "c42"));
        assert_eq!(pairing.pending.len(), 1);
        // Used once only.
        assert!(pairing.approve(&code, 2).is_err());
        assert_eq!(pairing.approve(&other, 3).unwrap().sender, "7");
    }

    #[test]
    fn a_code_expires_after_an_hour() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (code, _) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        let late = pairing.approve(&code, CODE_TTL_MS).unwrap_err();
        assert!(late.contains("scaduto"), "{late}");
        assert!(pairing.pending.is_empty());
    }

    #[test]
    fn one_code_every_ten_minutes_and_at_most_three_waiting() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (first, _) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        assert_eq!(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS - 1, &mut random).unwrap(), Request::Waiting);
        // After ten minutes a new code replaces the old one.
        let (second, _) = code_of(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS, &mut random).unwrap());
        assert_eq!(pairing.pending.len(), 1);
        assert!(pairing.approve(&first, REQUEST_EVERY_MS + 1).is_err());
        code_of(pairing.request("2", "B", "c2", false, REQUEST_EVERY_MS, &mut random).unwrap());
        code_of(pairing.request("3", "C", "c3", false, REQUEST_EVERY_MS, &mut random).unwrap());
        assert_eq!(pairing.request("4", "D", "c4", false, REQUEST_EVERY_MS, &mut random).unwrap(), Request::Closed);
        assert_eq!(pairing.pending.len(), 3);
        assert_eq!(pairing.approve(&second, REQUEST_EVERY_MS + 2).unwrap().sender, "42");
    }

    #[test]
    fn five_wrong_codes_lock_approvals_for_an_hour_and_a_typo_does_not_count() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (code, _) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        let wrong = if code == "AAAAAAAA" { "BBBBBBBB" } else { "AAAAAAAA" };
        // Not a code at all: an I, too short. Nothing counts.
        assert!(pairing.approve("IIIIIIII", 1).unwrap_err().contains("caratteri"));
        assert!(pairing.approve("ABC", 1).is_err());
        assert_eq!(pairing.attempts_left(1), MAX_FAILURES);
        for left in (1..MAX_FAILURES).rev() {
            let error = pairing.approve(wrong, 1).unwrap_err();
            assert!(error.contains(&format!("restano {left}")), "{error}");
        }
        assert!(pairing.approve(wrong, 1).unwrap_err().contains("un'ora"));
        // Locked: even the right code is refused, and no new code goes out.
        assert!(pairing.approve(&code, 2).unwrap_err().contains("riapre tra 60 minuti"));
        assert_eq!(pairing.attempts_left(2), 0);
        assert_eq!(pairing.request("7", "B", "c7", false, 3, &mut random).unwrap(), Request::Closed);
        // An hour later it reopens, with five tries again.
        let (again, _) = code_of(pairing.request("42", "Ale", "c42", false, LOCKOUT_MS + 1, &mut random).unwrap());
        assert_eq!(pairing.attempts_left(LOCKOUT_MS + 1), MAX_FAILURES);
        assert_eq!(pairing.approve(&again, LOCKOUT_MS + 2).unwrap().sender, "42");
    }

    #[test]
    fn refusing_from_the_panel_is_not_a_wrong_code() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (code, pending) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        assert_eq!(pairing.reject(&pending.request).unwrap().sender, "42");
        assert!(pairing.reject(&pending.request).is_err());
        assert_eq!(pairing.failures, 0);
        assert!(pairing.approve(&code, 1).is_err());
    }

    #[test]
    fn the_comparison_is_whole_and_a_name_is_cleaned() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
        let long = "x".repeat(100);
        assert_eq!(clean_name(&format!("  Ale\u{7}\n{long}")).chars().count(), NAME_LEN + 1);
        assert_eq!(clean_name("Ale\u{202e}nimda"), "Alenimda");
        assert_eq!(clean_name("A\u{0}le"), "Ale");
    }

    #[test]
    fn no_code_without_random_bytes() {
        let mut broken = |_: &mut [u8]| Err::<(), String>("nessuna entropia".into());
        assert!(Pairing::default().request("42", "Ale", "c42", false, 0, &mut broken).is_err());
    }

    #[test]
    fn once_someone_is_paired_a_code_goes_out_only_while_ade_opened_pairing() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        assert_eq!(pairing.request("7", "B", "c7", true, 0, &mut random).unwrap(), Request::Closed);
        // Not rate limited by the refusal: nothing was sent.
        let until = pairing.open(1);
        assert_eq!(until, 1 + OPEN_MS);
        let (code, _) = code_of(pairing.request("7", "B", "c7", true, 2, &mut random).unwrap());
        assert_eq!(pairing.approve(&code, 3).unwrap().sender, "7");
        // Approving closes it again.
        assert_eq!(pairing.request("8", "C", "c8", true, 4, &mut random).unwrap(), Request::Closed);
        // And it closes by itself after ten minutes.
        pairing.open(10);
        assert_eq!(pairing.request("8", "C", "c8", true, 10 + OPEN_MS, &mut random).unwrap(), Request::Closed);
        assert_eq!(pairing.open_until_ms, None);
    }
}
