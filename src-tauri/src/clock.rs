use std::time::{SystemTime, UNIX_EPOCH};

pub fn epoch_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
}

pub fn now_epoch_millis() -> u64 {
    epoch_millis(SystemTime::now()).unwrap_or(0)
}

pub fn now_millis() -> i64 {
    i64::try_from(now_epoch_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const LATER_MILLIS: u64 = 1_500;

    #[test]
    fn given_a_time_after_the_epoch_when_converting_then_it_returns_its_milliseconds() {
        let time = UNIX_EPOCH + Duration::from_millis(LATER_MILLIS);

        assert_eq!(epoch_millis(time), Some(LATER_MILLIS));
    }

    #[test]
    fn given_a_time_before_the_epoch_when_converting_then_it_returns_none() {
        let time = UNIX_EPOCH - Duration::from_millis(LATER_MILLIS);

        assert_eq!(epoch_millis(time), None);
    }

    #[test]
    fn given_the_current_time_when_reading_both_clocks_then_they_agree() {
        let signed = now_millis();
        let unsigned = now_epoch_millis();

        assert!(signed > 0);
        assert!(unsigned >= signed.unsigned_abs());
    }
}
