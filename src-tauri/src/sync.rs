use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::LockExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn given_a_poisoned_lock_when_locking_or_recovering_then_the_value_is_recovered() {
        let shared = Arc::new(Mutex::new(1));
        let clone = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(shared.is_poisoned());
        *shared.lock_or_recover() += 1;
        assert_eq!(*shared.lock_or_recover(), 2);
    }
}
