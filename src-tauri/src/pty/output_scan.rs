use std::ops::RangeInclusive;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const MAX_NOTIFICATION_CHARS: usize = 200;
const MAX_TITLE_SEQUENCE_BYTES: usize = 4096;
const CONTEXT_WINDOW_BYTES: usize = 48;
const TOKEN_LOOKBEHIND_BYTES: usize = 90;
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

pub(super) fn extract_notifications(data: &[u8], tail: &[u8]) -> (usize, Vec<String>) {
    let mut count = 0;
    let mut messages: Vec<String> = Vec::new();
    let mut bels = 0;
    let mut position = 0;
    while position < data.len() {
        if !starts_osc(data, position) {
            if data[position] == BEL {
                count += 1;
                bels += 1;
            }
            position += 1;
            continue;
        }
        let Some((code, body_start)) = osc_code(data, position + 2) else {
            position += 2;
            continue;
        };
        let (body_end, next) = match find_string_terminator(data, body_start) {
            Some((end, terminator_len)) => (end, end + terminator_len),
            None => (data.len(), data.len()),
        };
        position = next;
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
        .map(|line| {
            line.chars()
                .filter(|character| !character.is_control())
                .collect::<String>()
        })
        .map(|line| line.trim().to_string())
        .find(|line| !line.is_empty())
        .map(|line| truncate_notification(&line))
        .unwrap_or_else(|| FALLBACK_NOTIFICATION.to_string())
}

pub(super) fn scan_titles(pending: &mut Vec<u8>, titles: &mut Vec<String>) {
    let mut position = 0;
    while position < pending.len() {
        if starts_osc(pending, position) {
            let Some((end, terminator_len)) = find_string_terminator(pending, position + 2) else {
                if pending.len() - position > MAX_TITLE_SEQUENCE_BYTES {
                    position += 2;
                    continue;
                }
                break;
            };
            let content = &pending[position + 2..end];
            if let Some(separator) = content.iter().position(|&byte| byte == b';') {
                let code = &content[..separator];
                if code == b"0" || code == b"1" || code == b"2" {
                    let text = String::from_utf8_lossy(&content[separator + 1..])
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        titles.push(text);
                    }
                }
            }
            position = end + terminator_len;
        } else {
            position += 1;
        }
    }
    pending.drain(..position);
}

pub(super) fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut plain = Vec::with_capacity(bytes.len());
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] == ESC && position + 1 < bytes.len() {
            match bytes[position + 1] {
                b'[' => {
                    position += 2;
                    while position < bytes.len() {
                        let byte = bytes[position];
                        position += 1;
                        if CSI_FINAL_BYTES.contains(&byte) {
                            break;
                        }
                    }
                }
                b']' => {
                    position = find_string_terminator(bytes, position + 2)
                        .map_or(bytes.len(), |(end, terminator_len)| end + terminator_len);
                }
                b'(' | b')' | b'#' => {
                    position = (position + CHARSET_SELECT_BYTES).min(bytes.len());
                }
                _ => {
                    position = (position + 2).min(bytes.len());
                }
            }
        } else {
            plain.push(bytes[position]);
            position += 1;
        }
    }
    String::from_utf8_lossy(&plain).into_owned()
}

fn parse_trailing_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_end();
    let bytes = trimmed.as_bytes();
    let mut end = bytes.len();
    let mut scale = 1.0;
    if let Some(multiplier) = end
        .checked_sub(1)
        .and_then(|last| suffix_multiplier(bytes[last]))
    {
        scale = multiplier;
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
    let cleaned: String = trimmed[start..end]
        .chars()
        .filter(|character| *character != ',')
        .collect();
    cleaned.parse::<f64>().ok().map(|value| value * scale)
}

fn parse_leading_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let bytes = trimmed.as_bytes();
    let mut digits_end = 0;
    while digits_end < bytes.len()
        && (bytes[digits_end].is_ascii_digit()
            || bytes[digits_end] == b'.'
            || bytes[digits_end] == b',')
    {
        digits_end += 1;
    }
    if digits_end == 0 {
        return None;
    }
    let cleaned: String = trimmed[..digits_end]
        .chars()
        .filter(|character| *character != ',')
        .collect();
    let value = cleaned.parse::<f64>().ok()?;
    let multiplier = bytes.get(digits_end).copied().and_then(suffix_multiplier);
    Some(value * multiplier.unwrap_or(1.0))
}

fn suffix_multiplier(suffix: u8) -> Option<f64> {
    match suffix {
        b'k' | b'K' => Some(KILO),
        b'm' | b'M' => Some(MEGA),
        _ => None,
    }
}

fn floor_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub(super) fn detect_context_used(text: &str) -> Option<u8> {
    let lower = text.to_lowercase();
    let context_readings = lower
        .match_indices("context")
        .filter_map(|(keyword_index, _)| context_percent_reading(&lower, keyword_index));
    let token_readings = lower
        .match_indices("token")
        .filter_map(|(keyword_index, _)| token_ratio_reading(&lower, keyword_index));
    let footer_readings = lower
        .match_indices("%)")
        .filter_map(|(percent_index, _)| footer_percent_reading(&lower, percent_index));
    context_readings
        .chain(token_readings)
        .chain(footer_readings)
        .filter(|reading| is_valid_percent(reading.used))
        .max_by_key(|reading| reading.position)
        .map(|reading| rounded_percent(reading.used))
}

fn context_percent_reading(lower: &str, keyword_index: usize) -> Option<ContextReading> {
    let window_start = floor_boundary(lower, keyword_index.saturating_sub(CONTEXT_WINDOW_BYTES));
    let window_end = ceil_boundary(lower, keyword_index + CONTEXT_WINDOW_BYTES);
    let window = &lower[window_start..window_end];
    let keyword_offset = keyword_index - window_start;
    let percent_index = window[..keyword_offset].rfind('%')?;
    let percent = parse_trailing_number(&window[..percent_index])?;
    let is_remaining =
        window.contains("left") || window.contains("remain") || window.contains("free");
    let used = if is_remaining {
        FULL_PERCENT - percent
    } else {
        percent
    };
    Some(ContextReading {
        position: keyword_index,
        used,
    })
}

fn token_ratio_reading(lower: &str, keyword_index: usize) -> Option<ContextReading> {
    let window_start = floor_boundary(lower, keyword_index.saturating_sub(TOKEN_LOOKBEHIND_BYTES));
    let window = &lower[window_start..keyword_index];
    let slash = window.rfind('/')?;
    let used_tokens = parse_trailing_number(&window[..slash])?;
    let total_tokens = parse_leading_number(&window[slash + 1..])?;
    if total_tokens <= 0.0 {
        return None;
    }
    Some(ContextReading {
        position: keyword_index,
        used: used_tokens / total_tokens * FULL_PERCENT,
    })
}

fn footer_percent_reading(lower: &str, percent_index: usize) -> Option<ContextReading> {
    let open = lower[..percent_index].rfind('(')?;
    if percent_index - open > MAX_FOOTER_PERCENT_BYTES {
        return None;
    }
    let inside = &lower[open + 1..percent_index];
    if inside.is_empty() || !inside.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    parse_trailing_number(lower[..open].trim_end())?;
    let used = inside.parse::<f64>().ok()?;
    Some(ContextReading {
        position: percent_index,
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

pub(super) fn take_decodable(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(_) => String::from_utf8(std::mem::take(pending)).ok(),
        Err(error) => {
            let valid = error.valid_up_to();
            match error.error_len() {
                Some(invalid_len) => {
                    let head: Vec<u8> = pending.drain(..valid).collect();
                    pending.drain(..invalid_len);
                    let mut decoded = String::from_utf8(head).unwrap_or_default();
                    decoded.push('\u{FFFD}');
                    Some(decoded)
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
