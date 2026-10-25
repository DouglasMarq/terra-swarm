//! Side-channel readers over raw terminal output: attention signals (BEL,
//! OSC 9/99/777), window titles (OSC 0/1/2), ANSI stripping, context-window
//! usage shown by agent CLIs, and UTF-8 chunking of the PTY stream.

use std::ops::RangeInclusive;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// Longest notification message kept, in characters.
const MAX_NOTIFICATION_CHARS: usize = 200;
/// An unterminated title sequence longer than this is skipped as malformed.
const MAX_TITLE_SEQUENCE_BYTES: usize = 4096;
/// Text read on each side of "context" when looking for its percentage.
const CONTEXT_WINDOW_BYTES: usize = 48;
/// Text read before "token" when looking for an `a / b` ratio.
const TOKEN_LOOKBEHIND_BYTES: usize = 90;
/// Widest `(NN%)` footer accepted, from the `(` to the `%`.
const MAX_FOOTER_PERCENT_BYTES: usize = 5;
const OSC_NOTIFY: u32 = 9;
const OSC_KITTY_NOTIFY: u32 = 99;
const OSC_URXVT_NOTIFY: u32 = 777;
const DECIMAL_BASE: u32 = 10;
const BEL_BYTES: usize = 1;
const ST_BYTES: usize = 2;
const CSI_FINAL_BYTES: RangeInclusive<u8> = 0x40..=0x7e;
const CHARSET_SELECT_BYTES: usize = 3;
const KILO: f64 = 1_000.0;
const MEGA: f64 = 1_000_000.0;
const FULL_PERCENT: f64 = 100.0;
const FALLBACK_NOTIFICATION: &str = "Terminal notification";

struct ContextReading {
    position: usize,
    used: f64,
}

/// Counts attention signals in a terminal output chunk and extracts a
/// human-readable message for each: BEL characters and OSC 9 / 99 / 777
/// notification sequences (ESC ] N ; ... terminated by BEL or ST). OSC bodies
/// carry the text; for bare BELs the last non-empty line of recent output
/// (`tail`) is used as the message. A BEL burst yields a single fallback
/// message even though every BEL counts.
pub(super) fn extract_notifications(data: &[u8], tail: &[u8]) -> (usize, Vec<String>) {
    let mut count = 0;
    let mut messages: Vec<String> = Vec::new();
    let mut bels = 0;
    let mut i = 0;
    while i < data.len() {
        if !starts_osc(data, i) {
            if data[i] == BEL {
                count += 1;
                bels += 1;
            }
            i += 1;
            continue;
        }
        let Some((code, body_start)) = osc_code(data, i + 2) else {
            i += 2;
            continue;
        };
        let (body_end, next) = match find_string_terminator(data, body_start) {
            Some((end, terminator_len)) => (end, end + terminator_len),
            None => (data.len(), data.len()),
        };
        i = next;
        if !is_notification_code(code) {
            continue;
        }
        count += 1;
        let body = String::from_utf8_lossy(&data[body_start..body_end])
            .trim()
            .to_string();
        let message = notification_message(code, body);
        if !message.is_empty() {
            messages.push(truncate_notification(&message));
        }
    }
    if bels > 0 && messages.is_empty() {
        messages.push(fallback_notification(tail));
    }
    (count, messages)
}

fn starts_osc(data: &[u8], position: usize) -> bool {
    data[position] == ESC && data.get(position + 1) == Some(&b']')
}

fn osc_code(data: &[u8], digits_start: usize) -> Option<(u32, usize)> {
    let digit_count = data[digits_start..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let separator = digits_start + digit_count;
    if digit_count == 0 || data.get(separator) != Some(&b';') {
        return None;
    }
    let code = data[digits_start..separator]
        .iter()
        .fold(0u32, |code, digit| {
            code.saturating_mul(DECIMAL_BASE)
                .saturating_add(u32::from(digit - b'0'))
        });
    Some((code, separator + 1))
}

fn find_string_terminator(data: &[u8], from: usize) -> Option<(usize, usize)> {
    (from..data.len()).find_map(|position| {
        if data[position] == BEL {
            return Some((position, BEL_BYTES));
        }
        if data[position] == ESC && data.get(position + 1) == Some(&b'\\') {
            return Some((position, ST_BYTES));
        }
        None
    })
}

fn is_notification_code(code: u32) -> bool {
    matches!(code, OSC_NOTIFY | OSC_KITTY_NOTIFY | OSC_URXVT_NOTIFY)
}

fn notification_message(code: u32, body: String) -> String {
    match code {
        OSC_URXVT_NOTIFY => urxvt_message(&body),
        OSC_KITTY_NOTIFY => kitty_message(&body),
        _ => body,
    }
}

// urxvt: OSC 777 ; notify ; title ; body
fn urxvt_message(body: &str) -> String {
    let mut parts = body.splitn(3, ';');
    let _proto = parts.next();
    let title = parts.next().unwrap_or("").trim();
    let text = parts.next().unwrap_or("").trim();
    if !title.is_empty() && !text.is_empty() {
        format!("{}: {}", title, text)
    } else {
        text.to_string()
    }
}

// kitty: OSC 99 ; metadata ; payload
fn kitty_message(body: &str) -> String {
    match body.split_once(';') {
        Some((_, payload)) => payload.trim().to_string(),
        None => String::new(),
    }
}

fn truncate_notification(message: &str) -> String {
    message.chars().take(MAX_NOTIFICATION_CHARS).collect()
}

fn fallback_notification(tail: &[u8]) -> String {
    let plain = strip_ansi(&String::from_utf8_lossy(tail));
    plain
        .lines()
        .rev()
        .map(|l| l.chars().filter(|c| !c.is_control()).collect::<String>())
        .map(|l| l.trim().to_string())
        .find(|l| !l.is_empty())
        .map(|l| truncate_notification(&l))
        .unwrap_or_else(|| FALLBACK_NOTIFICATION.to_string())
}

/// Scans `buf` for OSC 0/1/2 window-title sequences (ESC ] N ; text, ended by
/// BEL or ST) and pushes any titles found onto `out`. Consumed bytes are
/// drained; a trailing partial sequence is kept for the next chunk. Sequences
/// that grow past 4 KB without a terminator are assumed malformed and skipped.
pub(super) fn scan_titles(buf: &mut Vec<u8>, out: &mut Vec<String>) {
    let mut i = 0;
    while i < buf.len() {
        if starts_osc(buf, i) {
            let Some((end, tlen)) = find_string_terminator(buf, i + 2) else {
                if buf.len() - i > MAX_TITLE_SEQUENCE_BYTES {
                    i += 2;
                    continue;
                }
                break;
            };
            let content = &buf[i + 2..end];
            if let Some(sep) = content.iter().position(|&b| b == b';') {
                let code = &content[..sep];
                if code == b"0" || code == b"1" || code == b"2" {
                    let text = String::from_utf8_lossy(&content[sep + 1..])
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        out.push(text);
                    }
                }
            }
            i = end + tlen;
        } else {
            i += 1;
        }
    }
    buf.drain(..i);
}

/// Strips ANSI escape sequences (CSI, OSC, charset selects) from a chunk so
/// that status text printed by agent TUIs becomes plain searchable text.
pub(super) fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == ESC && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    i += 2;
                    while i < bytes.len() {
                        let b = bytes[i];
                        i += 1;
                        if CSI_FINAL_BYTES.contains(&b) {
                            break;
                        }
                    }
                }
                b']' => {
                    i = find_string_terminator(bytes, i + 2)
                        .map_or(bytes.len(), |(end, terminator_len)| end + terminator_len);
                }
                b'(' | b')' | b'#' => {
                    i = (i + CHARSET_SELECT_BYTES).min(bytes.len());
                }
                _ => {
                    i = (i + 2).min(bytes.len());
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_trailing_number(s: &str) -> Option<f64> {
    let t = s.trim_end();
    let bytes = t.as_bytes();
    let mut end = bytes.len();
    let mut mult = 1.0;
    if let Some(multiplier) = end
        .checked_sub(1)
        .and_then(|last| suffix_multiplier(bytes[last]))
    {
        mult = multiplier;
        end -= 1;
    }
    let mut start = end;
    while start > 0
        && (bytes[start - 1].is_ascii_digit()
            || bytes[start - 1] == b'.'
            || bytes[start - 1] == b',')
    {
        start -= 1;
    }
    if start == end {
        return None;
    }
    let cleaned: String = t[start..end].chars().filter(|c| *c != ',').collect();
    cleaned.parse::<f64>().ok().map(|v| v * mult)
}

fn parse_leading_number(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.' || bytes[i] == b',') {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let cleaned: String = t[..i].chars().filter(|c| *c != ',').collect();
    let v = cleaned.parse::<f64>().ok()?;
    let multiplier = bytes.get(i).copied().and_then(suffix_multiplier);
    Some(v * multiplier.unwrap_or(1.0))
}

fn suffix_multiplier(suffix: u8) -> Option<f64> {
    match suffix {
        b'k' | b'K' => Some(KILO),
        b'm' | b'M' => Some(MEGA),
        _ => None,
    }
}

/// Largest index <= i that lies on a char boundary (clamped to s.len()).
fn floor_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest index >= i that lies on a char boundary (clamped to s.len()).
fn ceil_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Best-effort detection of context-window usage in agent output. Understands
/// "N% context left/remaining" (Claude), "N% (of) context used/full",
/// "a / b tokens" ratios (Codex), and "12.3K (42%)" footer counts (OpenCode).
/// Returns percent *used* (0-100). When several indicators are present, the
/// most recent one wins.
pub(super) fn detect_context_used(text: &str) -> Option<u8> {
    let lower = text.to_lowercase();
    let context_readings = lower
        .match_indices("context")
        .filter_map(|(idx, _)| context_percent_reading(&lower, idx));
    let token_readings = lower
        .match_indices("token")
        .filter_map(|(idx, _)| token_ratio_reading(&lower, idx));
    let footer_readings = lower
        .match_indices("%)")
        .filter_map(|(pct, _)| footer_percent_reading(&lower, pct));
    context_readings
        .chain(token_readings)
        .chain(footer_readings)
        .filter(|reading| is_valid_percent(reading.used))
        .max_by_key(|reading| reading.position)
        .map(|reading| rounded_percent(reading.used))
}

fn context_percent_reading(lower: &str, idx: usize) -> Option<ContextReading> {
    let lo = floor_boundary(lower, idx.saturating_sub(CONTEXT_WINDOW_BYTES));
    let hi = ceil_boundary(lower, idx + CONTEXT_WINDOW_BYTES);
    let window = &lower[lo..hi];
    // The percent belongs to the keyword, so take the one closest before
    // it; an earlier '%' in the window may belong to a stale indicator.
    let koff = idx - lo;
    let pct = window[..koff].rfind('%')?;
    let v = parse_trailing_number(&window[..pct])?;
    let is_remaining =
        window.contains("left") || window.contains("remain") || window.contains("free");
    let used = if is_remaining { FULL_PERCENT - v } else { v };
    Some(ContextReading {
        position: idx,
        used,
    })
}

fn token_ratio_reading(lower: &str, idx: usize) -> Option<ContextReading> {
    let lo = floor_boundary(lower, idx.saturating_sub(TOKEN_LOOKBEHIND_BYTES));
    let window = &lower[lo..idx];
    let slash = window.rfind('/')?;
    let a = parse_trailing_number(&window[..slash])?;
    let b = parse_leading_number(&window[slash + 1..])?;
    if b <= 0.0 {
        return None;
    }
    Some(ContextReading {
        position: idx,
        used: a / b * FULL_PERCENT,
    })
}

// OpenCode footer: "12.3K (42%)" - a bare parenthesized percent right
// after a token count, with no "context"/"token" keyword nearby.
fn footer_percent_reading(lower: &str, pct: usize) -> Option<ContextReading> {
    let open = lower[..pct].rfind('(')?;
    if pct - open > MAX_FOOTER_PERCENT_BYTES {
        return None;
    }
    let inside = &lower[open + 1..pct];
    if inside.is_empty() || !inside.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    parse_trailing_number(lower[..open].trim_end())?;
    let used = inside.parse::<f64>().ok()?;
    Some(ContextReading {
        position: pct,
        used,
    })
}

fn is_valid_percent(used: f64) -> bool {
    used.is_finite() && (0.0..=FULL_PERCENT).contains(&used)
}

fn rounded_percent(used: f64) -> u8 {
    // `used` was checked to lie in 0..=100, so the rounded value always fits in a u8.
    used.round() as u8
}

/// Drains one decodable chunk from `pending`, replacing invalid bytes with
/// U+FFFD so a single bad byte can never wedge the output pipeline. Returns
/// None when the buffer holds only an incomplete trailing sequence (wait for
/// more bytes) or is empty.
pub(super) fn take_decodable(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(_) => String::from_utf8(std::mem::take(pending)).ok(),
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                Some(bad) => {
                    let head: Vec<u8> = pending.drain(..valid).collect();
                    pending.drain(..bad);
                    let mut s = String::from_utf8(head).unwrap_or_default();
                    s.push('\u{FFFD}');
                    Some(s)
                }
                None => {
                    if valid == 0 {
                        None
                    } else {
                        String::from_utf8(pending.drain(..valid).collect()).ok()
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod notif_tests {
    use super::extract_notifications;

    #[test]
    fn bel_uses_last_output_line() {
        let (count, messages) = extract_notifications(b"\x07", b"12 passed, 0 failed\r\n\x07");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["12 passed, 0 failed".to_string()]);
    }

    #[test]
    fn bel_burst_yields_single_message() {
        let (count, messages) = extract_notifications(b"\x07\x07\x07", b"done\r\n");
        assert_eq!(count, 3);
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn osc9_carries_message() {
        let (count, messages) = extract_notifications(b"\x1b]9;Build finished\x07", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Build finished".to_string()]);
    }

    #[test]
    fn osc777_splits_title_and_body() {
        let (count, messages) =
            extract_notifications(b"\x1b]777;notify;Tests;12 passed\x1b\\", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Tests: 12 passed".to_string()]);
    }

    #[test]
    fn osc99_uses_payload_after_metadata() {
        let (count, messages) = extract_notifications(b"\x1b]99;i=1:d=0;Hello\x07", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Hello".to_string()]);
    }

    #[test]
    fn title_osc_terminator_bel_is_not_counted() {
        let (count, messages) = extract_notifications(b"\x1b]0;my title\x07", b"");
        assert_eq!(count, 0);
        assert!(messages.is_empty());
    }

    #[test]
    fn empty_tail_falls_back_to_generic_text() {
        let (count, messages) = extract_notifications(b"\x07", b"\r\n");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Terminal notification".to_string()]);
    }
}

#[cfg(test)]
mod ctx_tests {
    use super::detect_context_used;

    #[test]
    fn opencode_footer() {
        assert_eq!(
            detect_context_used("some output 12.3K (42%) $0.05"),
            Some(42)
        );
        assert_eq!(detect_context_used("999 (100%)"), Some(100));
        assert_eq!(detect_context_used("0 (0%)"), Some(0));
        assert_eq!(detect_context_used("hello (95%) no number"), None);
        assert_eq!(detect_context_used("42% context left"), Some(58));
        assert_eq!(detect_context_used("12.0k / 200k tokens"), Some(6));
        assert_eq!(detect_context_used("random 50% nothing"), None);
        // most recent indicator wins
        assert_eq!(
            detect_context_used("10% context left then 5K (33%)"),
            Some(33)
        );
        assert_eq!(
            detect_context_used("5K (33%) then 10% context left"),
            Some(90)
        );
    }

    #[test]
    fn unicode_near_keywords_does_not_panic() {
        // Box-drawing / emoji / CJK around the keyword must not panic on
        // char-boundary slicing.
        assert_eq!(
            detect_context_used("╭─░▒▓ 42% context left ▓▒░─╮"),
            Some(58)
        );
        assert_eq!(detect_context_used("🚀🚀 12.0k / 200k tokens 🚀"), Some(6));
        assert_eq!(
            detect_context_used("コンテキスト 30% context used"),
            Some(30)
        );
        assert_eq!(detect_context_used("│ 88% context left │"), Some(12));
        assert_eq!(detect_context_used("no indicators ░░░"), None);
    }
}

#[cfg(test)]
mod scan_tests {
    use super::{detect_context_used, extract_notifications, scan_titles, strip_ansi};

    #[test]
    fn given_an_unterminated_osc9_when_extracting_then_the_rest_of_the_chunk_is_its_message() {
        let (count, messages) = extract_notifications(b"\x1b]9;Half a message", b"");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["Half a message".to_string()]);
    }

    #[test]
    fn given_an_osc_without_digits_when_extracting_then_a_later_bel_still_counts() {
        let (count, messages) = extract_notifications(b"\x1b];x\x07", b"prompt> ");
        assert_eq!(count, 1);
        assert_eq!(messages, vec!["prompt>".to_string()]);
    }

    #[test]
    fn given_titles_ended_by_bel_and_st_when_scanning_then_both_are_read_and_drained() {
        let mut buf = b"\x1b]0;first\x07text\x1b]2;second\x1b\\\x1b]1;partial".to_vec();
        let mut titles = Vec::new();
        scan_titles(&mut buf, &mut titles);
        assert_eq!(titles, vec!["first".to_string(), "second".to_string()]);
        assert_eq!(buf, b"\x1b]1;partial".to_vec());
    }

    #[test]
    fn given_csi_osc_and_charset_sequences_when_stripping_then_only_text_remains() {
        let stripped = strip_ansi("\x1b[1;32mgreen\x1b[0m \x1b]0;title\x07\x1b(Bdone\x1b=");
        assert_eq!(stripped, "green done");
    }

    #[test]
    fn given_a_ratio_in_millions_or_a_zero_total_when_detecting_then_only_the_valid_one_counts() {
        assert_eq!(detect_context_used("0.5M / 1M tokens"), Some(50));
        assert_eq!(detect_context_used("5 / 0 tokens"), None);
    }
}
