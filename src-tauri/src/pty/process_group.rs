use crate::sync::LockExt;
use std::sync::Mutex;

pub(super) struct ProcessGroup {
    leader: libc::id_t,
    pgid: libc::pid_t,
    is_sealed: Mutex<bool>,
}

impl ProcessGroup {
    pub(super) fn of_leader(pid: u32) -> Option<Self> {
        let leader_pid = libc::pid_t::try_from(pid).ok()?;
        // SAFETY: `getpgid` only reads the process table; a failure is
        // reported as a negative value and handled below.
        let pgid = unsafe { libc::getpgid(leader_pid) };
        Some(Self {
            leader: pid,
            pgid: if pgid > 0 { pgid } else { leader_pid },
            is_sealed: Mutex::new(false),
        })
    }

    pub(super) fn kill(&self) {
        let is_sealed = self.is_sealed.lock_or_recover();
        if *is_sealed {
            return;
        }
        self.signal_group();
    }

    pub(super) fn wait_for_exit(&self) {
        loop {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: `info` is writable storage owned by this frame and
            // `WNOWAIT` leaves the child unreaped, so its pid stays reserved.
            let status = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.leader,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            let is_interrupted =
                status != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR);
            if !is_interrupted {
                return;
            }
        }
    }

    pub(super) fn kill_and_seal(&self) {
        let mut is_sealed = self.is_sealed.lock_or_recover();
        if !*is_sealed {
            self.signal_group();
        }
        *is_sealed = true;
    }

    fn signal_group(&self) {
        // SAFETY: `kill` has no memory preconditions; the group is only
        // signalled before it is sealed, while its unreaped leader keeps the
        // pgid from being reused.
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProcessGroup;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    const EXIT_CODE: i32 = 3;
    const DEADLINE: Duration = Duration::from_secs(3);
    const POLL: Duration = Duration::from_millis(20);

    fn spawn_in_own_group(script: &str) -> Child {
        Command::new("/bin/sh")
            .args(["-c", script])
            .process_group(0)
            .spawn()
            .expect("spawn shell")
    }

    fn is_alive(pid: u32) -> bool {
        let pid = libc::pid_t::try_from(pid).expect("pid fits");
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn has_exited_within_deadline(child: &mut Child) -> bool {
        let started = Instant::now();
        while started.elapsed() < DEADLINE {
            if child.try_wait().expect("poll child").is_some() {
                return true;
            }
            std::thread::sleep(POLL);
        }
        false
    }

    #[test]
    fn given_an_exited_leader_when_waiting_for_exit_then_it_stays_reapable_with_its_code() {
        let mut child = spawn_in_own_group(&format!("exit {EXIT_CODE}"));
        let group = ProcessGroup::of_leader(child.id()).expect("group");

        group.wait_for_exit();

        let status = child.wait().expect("reap child");
        assert_eq!(status.code(), Some(EXIT_CODE));
    }

    #[test]
    fn given_a_live_group_when_killing_then_the_leader_dies() {
        let mut child = spawn_in_own_group("sleep 30");
        let group = ProcessGroup::of_leader(child.id()).expect("group");

        group.kill();

        assert!(has_exited_within_deadline(&mut child));
    }

    #[test]
    fn given_a_sealed_group_when_killing_then_no_signal_is_sent() {
        let mut child = spawn_in_own_group("sleep 30");
        let group = ProcessGroup::of_leader(child.id()).expect("group");
        *group.is_sealed.lock().expect("seal") = true;

        group.kill();

        std::thread::sleep(POLL);
        assert!(is_alive(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn given_an_exited_leader_with_a_lingering_descendant_when_sealing_then_the_descendant_dies() {
        let pid_file = std::env::temp_dir().join(format!(
            "terra-pgroup-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        let mut child = spawn_in_own_group(&format!(
            "sleep 30 & echo $! > {}; exit 0",
            pid_file.display()
        ));
        let group = ProcessGroup::of_leader(child.id()).expect("group");
        group.wait_for_exit();
        let descendant: u32 = std::fs::read_to_string(&pid_file)
            .expect("descendant pid")
            .trim()
            .parse()
            .expect("numeric pid");

        group.kill_and_seal();
        let _ = child.wait();

        let started = Instant::now();
        while is_alive(descendant) && started.elapsed() < DEADLINE {
            std::thread::sleep(POLL);
        }
        assert!(!is_alive(descendant));
        let _ = std::fs::remove_file(pid_file);
    }
}
