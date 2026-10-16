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
//! Codes go out only while pairing is open: for two hours from the first
//! stranger's message while nobody is paired, and after that for 10 minutes
//! each time the user asks for it in ADE (S12). The bots answer only the
//! user's own accounts (D92), so once one is in, a stranger writing gets
//! silence rather than a code — no requests to wade through, and nothing that
//! says the bot is there.
//!
//! A link or QR (scelta 3) is the second way in, from ADE to the owner's own phone: ADE makes a token, shows it as a
//! `t.me/<bot>?start=<token>` link and a QR, and the owner's account that opens it is paired without typing a code. The
//! token is 192 random bits in the characters a link takes, kept only as a salted hash, good for 10 minutes and once, one
//! per link (a new one replaces the old). A wrong or expired one counts for nothing and touches no limit: 192 bits are not
//! guessed, so counting the failures would protect nothing and would hand a stranger who knows the bot's name a way to shut
//! the owner's link out (and the codes' count is not theirs to move either). The stranger is told the link no longer holds,
//! and gets the way of a plain `/start`, the code. Where the token never was: in a log, in a thread, in a chat.
//!
//! Hygiene (S12): an account the user refused gets no code for a day; a
//! request whose code could not be sent is taken back (`undo`); when the
//! waiting requests are all taken, a new one replaces the oldest instead of
//! shutting the owner out, so a handful of throwaway accounts cannot hold
//! every place.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LEN: usize = 8;
pub const CODE_TTL_MS: u64 = 60 * 60 * 1000;
pub const REQUEST_EVERY_MS: u64 = 10 * 60 * 1000;
pub const MAX_PENDING: usize = 5;
/// While nobody is paired, how long pairing stays open from the first stranger's message.
pub const FIRST_WINDOW_MS: u64 = 2 * 60 * 60 * 1000;
/// How long an account the user refused gets no code, counted from its request.
pub const REJECT_BLOCK_MS: u64 = 24 * 60 * 60 * 1000;
/// How many refused accounts are remembered: the oldest go first.
const MAX_REJECTED: usize = 100;
/// A refusal pressed by mistake is taken back by opening pairing within this long (N6).
pub const REJECT_UNDO_MS: u64 = 10 * 60 * 1000;
/// How many pushed-out requests are remembered, to tell their owner so (N5).
pub const MAX_EVICTED: usize = 50;
pub const MAX_FAILURES: u32 = 5;
/// How long a link's token (the QR) lasts, once.
pub const LINK_TTL_MS: u64 = 10 * 60 * 1000;
/// How long after a link was made a stranger who opens a dead one is told it no longer holds. Past it, and with no link
/// ever made, the bot is as silent as for any stranger: nothing that says it is there.
pub const LINK_STALE_MS: u64 = 60 * 60 * 1000;
/// Random bytes in a link's token (192 bits) and its length in characters: 24 bytes make exactly 32 of the 64.
const LINK_TOKEN_BYTES: usize = 24;
pub const LINK_TOKEN_LEN: usize = 32;
/// What a link may carry: Telegram's `start` parameter takes `A-Z a-z 0-9 _ -`, up to 64.
const LINK_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
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
    /// When the first stranger wrote with nobody paired: the first window runs from here.
    #[serde(default)]
    pub first_since_ms: Option<u64>,
    /// Accounts the user refused, who get no code until `until_ms`.
    #[serde(default)]
    pub rejected: Vec<Rejected>,
    /// Requests pushed out by newer ones, kept as hashes for the hour their code lasts: a code typed for one of them
    /// is not a wrong code, it is the answer «this request was replaced» (N5).
    #[serde(default)]
    pub evicted: Vec<Evicted>,
    /// The token of the link or QR ADE is showing: one at a time, as a hash.
    #[serde(default)]
    pub link: Option<LinkToken>,
    /// When ADE last made a link: the dead ones are told so only for an hour after.
    #[serde(default)]
    pub link_made_ms: Option<u64>,
    /// Who was told a link no longer holds, and when: once each ten minutes, like a request for a code.
    #[serde(default)]
    pub stale_told: Vec<Asked>,
    /// The account the last link paired (its id): what the panel names, instead of guessing from who appeared.
    #[serde(default)]
    pub linked_by: Option<String>,
}

/// A link's token, kept as the codes are: a salt and a hash, never the token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkToken {
    pub salt: String,
    pub token_hash: String,
    pub expires_ms: u64,
}

/// What became of a link token that arrived in a private chat.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkUse {
    /// The token was right: its sender is the owner's account, to be authorized now.
    Paired,
    /// Not shaped like a token: a plain `/start` text, which counts for nothing.
    NotAToken,
    /// Shaped like one, and wrong, expired or already used: nothing is counted, and the stranger is told.
    Wrong,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evicted {
    pub salt: String,
    pub code_hash: String,
    pub expires_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    pub sender: String,
    pub until_ms: u64,
    /// When the refusal was pressed (the request's own time if the caller did not say): `open` takes back the recent ones.
    #[serde(default)]
    pub at_ms: u64,
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

/// 24 bytes as 32 characters of `LINK_ALPHABET`: base64 for a URL, without the padding a whole number of groups does not need.
fn link_text(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() / 3 * 4);
    for group in bytes.chunks_exact(3) {
        let n = (u32::from(group[0]) << 16) | (u32::from(group[1]) << 8) | u32::from(group[2]);
        for shift in [18, 12, 6, 0] {
            out.push(LINK_ALPHABET[((n >> shift) & 63) as usize] as char);
        }
    }
    out
}

/// Whether `text` has the shape of a link's token, which is all that makes it worth checking.
pub fn is_link_token(text: &str) -> bool {
    text.len() == LINK_TOKEN_LEN && text.bytes().all(|b| LINK_ALPHABET.contains(&b))
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
        self.rejected.retain(|rejected| rejected.until_ms > now);
        self.evicted.retain(|evicted| evicted.expires_ms > now);
        if self.locked_until_ms.is_some_and(|until| until <= now) {
            self.locked_until_ms = None;
        }
        if self.open_until_ms.is_some_and(|until| until <= now) {
            self.open_until_ms = None;
        }
        if self.link.as_ref().is_some_and(|link| link.expires_ms <= now) {
            self.link = None;
        }
        self.stale_told.retain(|told| told.at_ms + REQUEST_EVERY_MS > now);
        if self.link_made_ms.is_some_and(|at| at + LINK_STALE_MS <= now) {
            self.link_made_ms = None;
        }
    }

    /// ADE makes the token of a link or QR: returned once, to be shown, and kept as a hash for ten minutes. A new one
    /// replaces the old, so there is one link at a time.
    pub fn issue_link(&mut self, now: u64, random: Random) -> Result<(String, u64), String> {
        self.prune(now);
        let mut bytes = [0u8; LINK_TOKEN_BYTES + 16];
        random(&mut bytes)?;
        let token = link_text(&bytes[..LINK_TOKEN_BYTES]);
        let salt = hex(&bytes[LINK_TOKEN_BYTES..]);
        let expires_ms = now + LINK_TTL_MS;
        self.link = Some(LinkToken { token_hash: code_hash(&salt, &token), salt, expires_ms });
        self.link_made_ms = Some(now);
        // A new link is a new question: who the last one paired is no longer its answer.
        self.linked_by = None;
        Ok((token, expires_ms))
    }

    /// The link or QR is no longer on ADE's screen: its token is cancelled, so a photo of it, or a screen shared, pairs
    /// nobody. True when there was one.
    pub fn cancel_link(&mut self) -> bool {
        self.link.take().is_some()
    }

    /// `typed` arrived as the token of a link, from `sender` in a private chat. Right: the link is used up, the sender's
    /// own request for a code (if they made one) and any refusal of them go, and the caller authorizes them. Wrong or
    /// expired: nothing changes, not even a count: no number of them can touch the live link or the limits of the codes.
    pub fn use_link(&mut self, typed: &str, sender: &str, now: u64) -> LinkUse {
        self.prune(now);
        if !is_link_token(typed) {
            return LinkUse::NotAToken;
        }
        // With no live link the token is still hashed (against nothing real), so the time says nothing of whether one is.
        let matched = match &self.link {
            Some(link) => same(code_hash(&link.salt, typed).as_bytes(), link.token_hash.as_bytes()),
            None => {
                let _ = same(code_hash("0", typed).as_bytes(), b"0");
                false
            }
        };
        if matched {
            self.link = None;
            // The link was the opening: one account per opening, as with a typed code.
            self.open_until_ms = None;
            self.pending.retain(|pending| pending.sender != sender);
            self.asked.retain(|asked| asked.sender != sender);
            self.rejected.retain(|rejected| rejected.sender != sender);
            self.linked_by = Some(sender.to_string());
            return LinkUse::Paired;
        }
        LinkUse::Wrong
    }

    /// Whether a stranger whose link did not hold is told so: only within an hour of a link ADE made (otherwise the bot is
    /// silent, as for any stranger, and the way of a plain `/start` follows) and once each ten minutes. Records the telling.
    pub fn may_say_stale(&mut self, sender: &str, now: u64) -> bool {
        self.prune(now);
        if self.link_made_ms.is_none() || self.stale_told.iter().any(|told| told.sender == sender) {
            return false;
        }
        self.stale_told.push(Asked { sender: sender.to_string(), at_ms: now });
        while self.stale_told.len() > MAX_PENDING * 10 {
            self.stale_told.remove(0);
        }
        true
    }

    /// Whether a stranger writing gets a code: with nobody paired, for two hours
    /// from the first one's message; always while the user has pairing open.
    pub fn is_open(&self, anyone_paired: bool, now: u64) -> bool {
        let first = !anyone_paired && self.first_since_ms.is_none_or(|since| now < since + FIRST_WINDOW_MS);
        first || self.open_until_ms.is_some_and(|until| until > now)
    }

    /// The user asked, from ADE, to pair one more account.
    pub fn open(&mut self, now: u64) -> u64 {
        // A refusal pressed by mistake is taken back by opening pairing soon after (N6); an older one stays.
        self.rejected.retain(|rejected| now.saturating_sub(rejected.at_ms) >= REJECT_UNDO_MS);
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
        if !anyone_paired && self.first_since_ms.is_none() {
            self.first_since_ms = Some(now);
        }
        if !self.is_open(anyone_paired, now) {
            return Ok(Request::Closed);
        }
        // The user refused this account: silence, as for any stranger with pairing shut.
        if self.rejected.iter().any(|rejected| rejected.sender == sender) {
            return Ok(Request::Closed);
        }
        if self.asked.iter().any(|asked| asked.sender == sender) {
            return Ok(Request::Waiting);
        }
        if self.locked(now) {
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
        // All the places taken: the oldest request goes, so throwaway accounts cannot shut the owner out.
        while self.pending.len() >= MAX_PENDING {
            let oldest = self.pending.iter().enumerate().min_by_key(|(_, pending)| pending.created_ms).map(|(index, _)| index);
            match oldest {
                Some(index) => {
                    // Its hash is kept for the hour its code lasts, to tell the owner it was replaced (N5).
                    let gone = self.pending.remove(index);
                    self.evicted.push(Evicted { salt: gone.salt, code_hash: gone.code_hash, expires_ms: gone.expires_ms });
                    while self.evicted.len() > MAX_EVICTED {
                        self.evicted.remove(0);
                    }
                }
                None => break,
            };
        }
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
            None if self.evicted.iter().fold(false, |any, gone| {
                same(code_hash(&gone.salt, &code).as_bytes(), gone.code_hash.as_bytes()) | any
            }) =>
            {
                // A real code, of a request newer ones pushed out: not a wrong code, nothing counts.
                Err("questa richiesta è stata sostituita da altre arrivate dopo: scrivi di nuovo al bot per avere un codice nuovo".into())
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

    /// The user refused a request from the panel. Not a wrong code: nothing
    /// counts. The account gets no new code for a day from its request (S12).
    pub fn reject(&mut self, request: &str) -> Result<Pending, String> {
        let at = self.pending.iter().find(|pending| pending.request == request).map_or(0, |pending| pending.created_ms);
        self.reject_at(request, at)
    }

    /// `reject`, with the moment the user pressed it, which is what `open` counts the ten minutes from.
    pub fn reject_at(&mut self, request: &str, now: u64) -> Result<Pending, String> {
        let index = self
            .pending
            .iter()
            .position(|pending| pending.request == request)
            .ok_or_else(|| "questa richiesta di abbinamento non c'è più".to_string())?;
        let pending = self.pending.remove(index);
        self.rejected.retain(|rejected| rejected.sender != pending.sender);
        self.rejected.push(Rejected { sender: pending.sender.clone(), until_ms: pending.created_ms + REJECT_BLOCK_MS, at_ms: now });
        while self.rejected.len() > MAX_REJECTED {
            self.rejected.remove(0);
        }
        Ok(pending)
    }

    /// The code of `request` could not be sent: the request is taken back as if
    /// it had not been made, and its sender may write again at once (S12).
    pub fn undo(&mut self, request: &str) {
        if let Some(index) = self.pending.iter().position(|pending| pending.request == request) {
            let pending = self.pending.remove(index);
            self.asked.retain(|asked| asked.sender != pending.sender);
        }
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
            // One more per call, so no two requests of a test draw the same code.
            next = next.wrapping_add(1);
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
    fn one_code_every_ten_minutes_and_at_most_five_waiting() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (first, _) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        assert_eq!(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS - 1, &mut random).unwrap(), Request::Waiting);
        // After ten minutes a new code replaces the old one.
        let (second, _) = code_of(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS, &mut random).unwrap());
        assert_eq!(pairing.pending.len(), 1);
        assert!(pairing.approve(&first, REQUEST_EVERY_MS + 1).is_err());
        for other in ["2", "3", "4", "5"] {
            code_of(pairing.request(other, "B", "c", false, REQUEST_EVERY_MS, &mut random).unwrap());
        }
        assert_eq!(pairing.pending.len(), MAX_PENDING);
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

    #[test]
    fn the_window_before_the_first_pairing_closes_two_hours_after_the_first_stranger() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        // Nobody wrote yet: the panel still shows it open, whatever the time.
        assert!(pairing.is_open(false, 5 * FIRST_WINDOW_MS));
        code_of(pairing.request("42", "Ale", "c42", false, 1_000, &mut random).unwrap());
        assert_eq!(pairing.first_since_ms, Some(1_000));
        // Within the hour another stranger still gets a code.
        code_of(pairing.request("7", "B", "c7", false, 1_000 + FIRST_WINDOW_MS - 1, &mut random).unwrap());
        // After it, silence — for the one who had a code too, once the ten minutes passed.
        let late = 1_000 + FIRST_WINDOW_MS;
        assert!(!pairing.is_open(false, late));
        assert_eq!(pairing.request("9", "C", "c9", false, late, &mut random).unwrap(), Request::Closed);
        assert_eq!(pairing.request("42", "Ale", "c42", false, late + REQUEST_EVERY_MS, &mut random).unwrap(), Request::Closed);
        // The user opens it from ADE: codes go out again for ten minutes.
        pairing.open(late + REQUEST_EVERY_MS + 1);
        code_of(pairing.request("9", "C", "c9", false, late + REQUEST_EVERY_MS + 2, &mut random).unwrap());
    }

    #[test]
    fn an_account_the_user_refused_gets_no_new_code_for_a_day() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (_, pending) = code_of(pairing.request("42", "Spam", "c42", false, 0, &mut random).unwrap());
        pairing.reject(&pending.request).unwrap();
        // Past the ten minutes that used to let it ask again: still nothing.
        assert_eq!(pairing.request("42", "Spam", "c42", false, REQUEST_EVERY_MS, &mut random).unwrap(), Request::Closed);
        // Pairing opened by the user a day later still leaves it out, to the last millisecond.
        pairing.open(REJECT_BLOCK_MS - 100);
        assert_eq!(pairing.request("42", "Spam", "c42", false, REJECT_BLOCK_MS - 1, &mut random).unwrap(), Request::Closed);
        // Someone else is not affected.
        code_of(pairing.request("7", "B", "c7", false, REQUEST_EVERY_MS, &mut random).unwrap());
        // The block is saved with the link and ends by itself.
        let saved: Pairing = serde_json::from_str(&serde_json::to_string(&pairing).unwrap()).unwrap();
        assert_eq!(saved.rejected.len(), 1);
        pairing.open(REJECT_BLOCK_MS);
        code_of(pairing.request("42", "Spam", "c42", false, REJECT_BLOCK_MS + 1, &mut random).unwrap());
        assert!(pairing.rejected.is_empty());
    }

    #[test]
    fn the_refused_are_remembered_up_to_a_limit() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        for index in 0..(MAX_REJECTED + 5) {
            let sender = format!("s{index}");
            let (_, pending) = code_of(pairing.request(&sender, "x", "c", false, index as u64, &mut random).unwrap());
            pairing.reject(&pending.request).unwrap();
        }
        assert_eq!(pairing.rejected.len(), MAX_REJECTED);
        assert_eq!(pairing.rejected.first().unwrap().sender, "s5");
    }

    #[test]
    fn a_request_whose_code_could_not_be_sent_is_taken_back() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (code, pending) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        pairing.undo(&pending.request);
        assert!(pairing.pending.is_empty());
        assert!(pairing.approve(&code, 1).is_err());
        // The sender may write again at once, and nothing else was touched.
        code_of(pairing.request("42", "Ale", "c42", false, 2, &mut random).unwrap());
        pairing.undo("sconosciuta");
        assert_eq!(pairing.pending.len(), 1);
    }

    #[test]
    fn throwaway_accounts_cannot_take_every_place_from_the_owner() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (owner_code, _) = code_of(pairing.request("owner", "Ale", "c0", false, 0, &mut random).unwrap());
        // Four more fill the places; a fifth stranger replaces the oldest instead of being shut out.
        for index in 1..=MAX_PENDING {
            code_of(pairing.request(&format!("t{index}"), "x", "c", false, index as u64, &mut random).unwrap());
        }
        assert_eq!(pairing.pending.len(), MAX_PENDING);
        assert!(pairing.pending.iter().all(|pending| pending.sender != "owner"));
        assert!(pairing.approve(&owner_code, 100).is_err());
        // The owner, asking again after ten minutes, gets a place like anyone.
        let (again, _) = code_of(pairing.request("owner", "Ale", "c0", false, REQUEST_EVERY_MS + 10, &mut random).unwrap());
        assert_eq!(pairing.approve(&again, REQUEST_EVERY_MS + 11).unwrap().sender, "owner");
    }

    #[test]
    fn a_state_saved_before_this_loads_with_the_new_fields_empty() {
        let old = r#"{"pending":[],"asked":[],"failures":0}"#;
        let pairing: Pairing = serde_json::from_str(old).unwrap();
        assert_eq!(pairing.first_since_ms, None);
        assert!(pairing.rejected.is_empty());
    }

    /* N5 of the third check: a code of a request pushed out a moment ago is not a wrong code. */
    #[test]
    fn the_code_of_a_request_pushed_out_says_so_and_does_not_count_as_wrong() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (owner_code, _) = code_of(pairing.request("owner", "Ale", "c0", false, 0, &mut random).unwrap());
        for index in 1..=MAX_PENDING {
            code_of(pairing.request(&format!("t{index}"), "x", "c", false, index as u64, &mut random).unwrap());
        }
        assert!(pairing.pending.iter().all(|pending| pending.sender != "owner"));
        let error = pairing.approve(&owner_code, 100).unwrap_err();
        assert!(error.contains("sostituita"), "{error}");
        assert_eq!(pairing.failures, 0);
        assert_eq!(pairing.attempts_left(100), MAX_FAILURES);
        // Said again as many times as it is typed, and never locks approvals.
        for _ in 0..(MAX_FAILURES + 2) {
            assert!(pairing.approve(&owner_code, 101).unwrap_err().contains("sostituita"));
        }
        assert!(!pairing.locked(101));
        // A wrong code is still wrong, and the memory of the pushed-out ones goes with the code's hour.
        let wrong = if owner_code == "AAAAAAAA" { "BBBBBBBB" } else { "AAAAAAAA" };
        assert!(pairing.approve(wrong, 102).unwrap_err().contains("restano"));
        assert_eq!(pairing.failures, 1);
        let late = CODE_TTL_MS + 10;
        assert!(!pairing.approve(&owner_code, late).unwrap_err().contains("sostituita"));
        assert!(pairing.evicted.is_empty());
    }

    #[test]
    fn the_memory_of_pushed_out_requests_has_a_limit() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        for index in 0..(MAX_PENDING + MAX_EVICTED + 20) {
            code_of(pairing.request(&format!("s{index}"), "x", "c", false, index as u64, &mut random).unwrap());
        }
        assert_eq!(pairing.pending.len(), MAX_PENDING);
        assert_eq!(pairing.evicted.len(), MAX_EVICTED);
    }

    /* N6: a refusal pressed by mistake is taken back by opening pairing soon after. */
    #[test]
    fn opening_pairing_soon_after_a_refusal_takes_the_refusal_back() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (_, pending) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        pairing.reject(&pending.request).unwrap();
        assert_eq!(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS, &mut random).unwrap(), Request::Closed);
        pairing.open(5 * 60 * 1000);
        assert!(pairing.rejected.is_empty());
        code_of(pairing.request("42", "Ale", "c42", false, REQUEST_EVERY_MS, &mut random).unwrap());
    }

    #[test]
    fn a_refusal_older_than_ten_minutes_stays_when_pairing_is_opened() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (_, spam) = code_of(pairing.request("spam", "x", "c1", false, 0, &mut random).unwrap());
        pairing.reject(&spam.request).unwrap();
        pairing.open(REJECT_UNDO_MS + 1);
        assert_eq!(pairing.rejected.len(), 1);
        assert_eq!(pairing.request("spam", "x", "c1", false, REJECT_UNDO_MS + 2, &mut random).unwrap(), Request::Closed);
    }

    #[test]
    fn a_refusal_counts_from_the_moment_it_was_pressed_when_the_caller_says_so() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (_, pending) = code_of(pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap());
        // The request waited half an hour; the refusal is pressed now and taken back within ten minutes.
        let pressed = 30 * 60 * 1000;
        pairing.reject_at(&pending.request, pressed).unwrap();
        pairing.open(pressed + 5 * 60 * 1000);
        assert!(pairing.rejected.is_empty());
    }

    /* ── the link or QR (scelta 3) ─────────────────────────────────────── */

    #[test]
    fn a_link_token_is_192_random_bits_in_the_characters_a_link_takes() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (token, expires) = pairing.issue_link(1_000, &mut random).unwrap();
        assert_eq!(token.len(), LINK_TOKEN_LEN);
        assert!(token.len() <= 64, "Telegram takes up to 64 characters");
        assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{token}");
        assert!(is_link_token(&token));
        assert_eq!(LINK_TOKEN_BYTES * 8, 192);
        assert_eq!(expires, 1_000 + LINK_TTL_MS);
        // Every one is different, and none of them is a code.
        let (other, _) = pairing.issue_link(1_000, &mut random).unwrap();
        assert_ne!(token, other);
        assert!(normalize(&token).is_none());
    }

    #[test]
    fn the_token_text_covers_the_whole_alphabet_in_order() {
        // Three bytes make four characters: the first characters of the alphabet are the first values.
        assert_eq!(link_text(&[0, 0, 0]), "AAAA");
        assert_eq!(link_text(&[0xff, 0xff, 0xff]), "____");
        assert_eq!(link_text(&[0, 0, 1]), "AAAB");
        assert_eq!(link_text(&[0xfb, 0xef, 0xbe]), "----");
    }

    #[test]
    fn only_the_hash_of_a_link_token_is_kept() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        let saved = serde_json::to_string(&pairing).unwrap();
        assert!(!saved.contains(&token), "{saved}");
        let link = pairing.link.as_ref().unwrap();
        assert_eq!(link.token_hash, code_hash(&link.salt, &token));
        // And it survives a restart as it was saved.
        let again: Pairing = serde_json::from_str(&saved).unwrap();
        assert_eq!(again, pairing);
    }

    #[test]
    fn a_link_token_pairs_once_and_only_once() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        assert_eq!(pairing.use_link(&token, "42", 1), LinkUse::Paired);
        assert!(pairing.link.is_none());
        // The same token again, from anyone: used up, and a wrong one now.
        assert_eq!(pairing.use_link(&token, "7", 2), LinkUse::Wrong);
    }

    #[test]
    fn a_link_token_lasts_ten_minutes() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        assert_eq!(pairing.use_link(&token, "42", LINK_TTL_MS), LinkUse::Wrong, "at ten minutes it is over");
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        assert_eq!(pairing.use_link(&token, "42", LINK_TTL_MS - 1), LinkUse::Paired);
    }

    #[test]
    fn a_stale_link_is_told_only_within_an_hour_of_a_link_and_once_each_ten_minutes() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        // No link was ever made: silence, as for any stranger.
        assert!(!pairing.may_say_stale("9", 0));
        pairing.issue_link(1_000, &mut random).unwrap();
        assert!(pairing.may_say_stale("9", 2_000), "after a link: told");
        assert!(!pairing.may_say_stale("9", 3_000), "once");
        assert!(pairing.may_say_stale("8", 3_000), "another stranger is told too");
        assert!(pairing.may_say_stale("9", 2_000 + REQUEST_EVERY_MS), "and again ten minutes later");
        // An hour after the link, the bot is silent again.
        assert!(!pairing.may_say_stale("7", 1_000 + LINK_STALE_MS));
        assert!(pairing.link_made_ms.is_none());
    }

    #[test]
    fn the_account_a_link_paired_is_named_by_its_id_and_a_new_link_forgets_it() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        assert_eq!(pairing.linked_by, None);
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        assert_eq!(pairing.use_link(&"a".repeat(LINK_TOKEN_LEN), "9", 1), LinkUse::Wrong);
        assert_eq!(pairing.linked_by, None, "a wrong one pairs nobody");
        assert_eq!(pairing.use_link(&token, "42", 2), LinkUse::Paired);
        assert_eq!(pairing.linked_by.as_deref(), Some("42"));
        pairing.issue_link(3, &mut random).unwrap();
        assert_eq!(pairing.linked_by, None);
    }

    #[test]
    fn a_cancelled_link_token_pairs_nobody() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        assert!(!pairing.cancel_link(), "nothing to cancel");
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        assert!(pairing.cancel_link());
        assert!(pairing.link.is_none());
        assert_eq!(pairing.use_link(&token, "42", 1), LinkUse::Wrong);
        assert!(!pairing.cancel_link(), "cancelling twice is no error");
        // A new one can be made at once.
        let (fresh, _) = pairing.issue_link(2, &mut random).unwrap();
        assert_eq!(pairing.use_link(&fresh, "42", 3), LinkUse::Paired);
    }

    #[test]
    fn a_new_link_token_cancels_the_old_one() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (old, _) = pairing.issue_link(0, &mut random).unwrap();
        let (new, _) = pairing.issue_link(5, &mut random).unwrap();
        assert_eq!(pairing.use_link(&old, "42", 6), LinkUse::Wrong);
        assert_eq!(pairing.use_link(&new, "42", 7), LinkUse::Paired);
    }

    #[test]
    fn a_text_that_is_not_a_token_counts_for_nothing() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        pairing.issue_link(0, &mut random).unwrap();
        let shapes: Vec<String> = vec![
            String::new(),
            "ciao".into(),
            "ABCD-EFGH".into(),
            "a".repeat(31),
            "a".repeat(33),
            format!("{} ", "a".repeat(31)),
            "é".repeat(16),
        ];
        for typed in &shapes {
            assert_eq!(pairing.use_link(typed, "42", 1), LinkUse::NotAToken, "{typed:?}");
        }
    }

    #[test]
    fn no_number_of_wrong_tokens_touches_the_live_link_or_the_limits_of_the_codes() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        let (token, _) = pairing.issue_link(0, &mut random).unwrap();
        let before = pairing.clone();
        for round in 0..50u64 {
            let wrong = format!("{:0>width$}", round, width = LINK_TOKEN_LEN);
            assert_eq!(pairing.use_link(&wrong, "9", 10 + round), LinkUse::Wrong);
        }
        // Nothing moved: the live link is the same, the codes' count and lock are as they were.
        assert_eq!(pairing, before);
        assert_eq!(pairing.failures, 0);
        assert!(!pairing.locked(100));
        assert_eq!(pairing.attempts_left(100), MAX_FAILURES);
        // The owner's token still works, and a new one can be made at once.
        assert_eq!(pairing.use_link(&token, "42", 200), LinkUse::Paired);
        let (fresh, _) = pairing.issue_link(201, &mut random).unwrap();
        assert_eq!(pairing.use_link(&fresh, "7", 202), LinkUse::Paired);
    }

    #[test]
    fn a_right_token_clears_the_sender_requests_and_refusals() {
        let mut random = counter();
        let mut pairing = Pairing::default();
        // 42 had asked for a code and the user had refused 7.
        pairing.request("42", "Ale", "c42", false, 0, &mut random).unwrap();
        pairing.request("7", "Altro", "c7", false, 0, &mut random).unwrap();
        pairing.reject_at(&pairing.pending.iter().find(|p| p.sender == "7").unwrap().request.clone(), 1).unwrap();
        let (token, _) = pairing.issue_link(2, &mut random).unwrap();
        assert_eq!(pairing.use_link(&"b".repeat(LINK_TOKEN_LEN), "9", 3), LinkUse::Wrong);
        assert_eq!(pairing.use_link(&token, "42", 4), LinkUse::Paired);
        assert!(pairing.pending.iter().all(|p| p.sender != "42"), "their code request is moot");
        assert!(pairing.asked.iter().all(|a| a.sender != "42"));
        assert_eq!(pairing.rejected.len(), 1, "another account's refusal stays");
        let (token, _) = pairing.issue_link(5, &mut random).unwrap();
        assert_eq!(pairing.use_link(&token, "7", 6), LinkUse::Paired);
        assert!(pairing.rejected.is_empty(), "the owner showing the link to a refused account decides");
    }

    #[test]
    fn an_old_saved_pairing_without_link_fields_still_loads() {
        let old = r#"{"pending":[],"asked":[],"failures":2}"#;
        let pairing: Pairing = serde_json::from_str(old).unwrap();
        assert!(pairing.link.is_none());
        assert_eq!(pairing.failures, 2);
    }
}
