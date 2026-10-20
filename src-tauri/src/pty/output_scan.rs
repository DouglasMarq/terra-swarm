//! Side-channel readers over raw terminal output: attention signals (BEL,
//! OSC 9/99/777), window titles (OSC 0/1/2), ANSI stripping, context-window
//! usage shown by agent CLIs, and UTF-8 chunking of the PTY stream.

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
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b']' {
            let mut j = i + 2;
            let mut num: u32 = 0;
            let mut digits = 0;
            while j < data.len() && data[j].is_ascii_digit() {
                num = num
                    .saturating_mul(10)
                    .saturating_add((data[j] - b'0') as u32);
                digits += 1;
                j += 1;
            }
            if j < data.len() && data[j] == b';' && digits > 0 {
                let body_start = j + 1;
                let mut end = data.len();
                let mut k = body_start;
                while k < data.len() {
                    if data[k] == 0x07 {
                        end = k;
                        k += 1;
                        break;
                    }
                    if data[k] == 0x1b && k + 1 < data.len() && data[k + 1] == b'\\' {
                        end = k;
                        k += 2;
                        break;
                    }
                    k += 1;
                }
                if num == 9 || num == 99 || num == 777 {
                    count += 1;
                    let body = String::from_utf8_lossy(&data[body_start..end])
                        .trim()
                        .to_string();
                    let msg = match num {
                        // urxvt: OSC 777 ; notify ; title ; body
                        777 => {
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
                        99 => match body.split_once(';') {
                            Some((_, payload)) => payload.trim().to_string(),
                            None => String::new(),
                        },
                        _ => body,
                    };
                    if !msg.is_empty() {
                        messages.push(msg.chars().take(200).collect());
                    }
                }
                i = k;
                continue;
            }
            i += 2;
        } else {
            if data[i] == 0x07 {
                count += 1;
                bels += 1;
            }
            i += 1;
        }
    }
    if bels > 0 && messages.is_empty() {
        let plain = strip_ansi(&String::from_utf8_lossy(tail));
        let fallback = plain
            .lines()
            .rev()
            .map(|l| l.chars().filter(|c| !c.is_control()).collect::<String>())
            .map(|l| l.trim().to_string())
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(200).collect::<String>())
            .unwrap_or_else(|| "Terminal notification".to_string());
        messages.push(fallback);
    }
    (count, messages)
}

/// Scans `buf` for OSC 0/1/2 window-title sequences (ESC ] N ; text, ended by
/// BEL or ST) and pushes any titles found onto `out`. Consumed bytes are
/// drained; a trailing partial sequence is kept for the next chunk. Sequences
/// that grow past 4 KB without a terminator are assumed malformed and skipped.
pub(super) fn scan_titles(buf: &mut Vec<u8>, out: &mut Vec<String>) {
    let mut i = 0;
    while i < buf.len() {
        if buf[i] == 0x1b && i + 1 < buf.len() && buf[i + 1] == b']' {
            let mut j = i + 2;
            let mut term: Option<(usize, usize)> = None;
            while j < buf.len() {
                if buf[j] == 0x07 {
                    term = Some((j, 1));
                    break;
                }
                if buf[j] == 0x1b && j + 1 < buf.len() && buf[j + 1] == b'\\' {
                    term = Some((j, 2));
                    break;
                }
                j += 1;
            }
            let Some((end, tlen)) = term else {
                if buf.len() - i > 4096 {
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
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    i += 2;
                    while i < bytes.len() {
                        let b = bytes[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&b) {
                            break;
                        }
                    }
                }
                b']' => {
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'(' | b')' | b'#' => {
                    i = (i + 3).min(bytes.len());
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
    if end > 0 {
        match bytes[end - 1] {
            b'k' | b'K' => {
                mult = 1_000.0;
                end -= 1;
            }
            b'm' | b'M' => {
                mult = 1_000_000.0;
                end -= 1;
            }
            _ => {}
        }
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
    let mut v = cleaned.parse::<f64>().ok()?;
    if i < bytes.len() {
        match bytes[i] {
            b'k' | b'K' => v *= 1_000.0,
            b'm' | b'M' => v *= 1_000_000.0,
            _ => {}
        }
    }
    Some(v)
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
    let mut best: Option<(usize, f64)> = None;
    let consider = |pos: usize, used: f64, best: &mut Option<(usize, f64)>| {
        if used.is_finite() && (0.0..=100.0).contains(&used) {
            if best.map_or(true, |(p, _)| pos >= p) {
                *best = Some((pos, used));
            }
        }
    };

    let mut start = 0;
    while let Some(off) = lower[start..].find("context") {
        let idx = start + off;
        let lo = floor_boundary(&lower, idx.saturating_sub(48));
        let hi = ceil_boundary(&lower, idx + 48);
        let window = &lower[lo..hi];
        // The percent belongs to the keyword, so take the one closest before
        // it; an earlier '%' in the window may belong to a stale indicator.
        let koff = idx - lo;
        if let Some(pct) = window[..koff].rfind('%') {
            if let Some(v) = parse_trailing_number(&window[..pct]) {
                let used = if window.contains("left")
                    || window.contains("remain")
                    || window.contains("free")
                {
                    100.0 - v
                } else {
                    v
                };
                consider(idx, used, &mut best);
            }
        }
        start = idx + 7;
    }

    let mut start = 0;
    while let Some(off) = lower[start..].find("token") {
        let idx = start + off;
        let lo = floor_boundary(&lower, idx.saturating_sub(90));
        let window = &lower[lo..idx];
        if let Some(slash) = window.rfind('/') {
            if let (Some(a), Some(b)) = (
                parse_trailing_number(&window[..slash]),
                parse_leading_number(&window[slash + 1..]),
            ) {
                if b > 0.0 {
                    consider(idx, a / b * 100.0, &mut best);
                }
            }
        }
        start = idx + 5;
    }

    // OpenCode footer: "12.3K (42%)" - a bare parenthesized percent right
    // after a token count, with no "context"/"token" keyword nearby.
    let mut start = 0;
    while let Some(off) = lower[start..].find("%)") {
        let pct = start + off;
        if let Some(open) = lower[..pct].rfind('(') {
            if pct - open <= 5 {
                let inside = &lower[open + 1..pct];
                if !inside.is_empty() && inside.bytes().all(|b| b.is_ascii_digit()) {
                    let before = lower[..open].trim_end();
                    if parse_trailing_number(before).is_some() {
                        consider(pct, inside.parse::<f64>().unwrap(), &mut best);
                    }
                }
            }
        }
        start = pct + 2;
    }

    best.map(|(_, v)| v.round() as u8)
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
