#[cfg(unix)]
const PASSWD_BUFFER_FALLBACK_BYTES: usize = 1024;
#[cfg(unix)]
const PASSWD_BUFFER_MAX_BYTES: usize = 1024 * 1024;

#[cfg(unix)]
fn login_shell() -> Option<String> {
    let shell = passwd_shell()?;
    if shell.is_empty() || !std::path::Path::new(&shell).exists() {
        None
    } else {
        Some(shell)
    }
}

#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    let mut size = initial_passwd_buffer_size();
    loop {
        let mut buffer: Vec<libc::c_char> = vec![0; size];
        match read_passwd_shell(&mut buffer) {
            Err(libc::ERANGE) if size < PASSWD_BUFFER_MAX_BYTES => size *= 2,
            Err(_) => return None,
            Ok(shell) => return shell,
        }
    }
}

#[cfg(unix)]
fn initial_passwd_buffer_size() -> usize {
    // SAFETY: `sysconf` only reads a system limit and has no preconditions.
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    usize::try_from(suggested)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(PASSWD_BUFFER_FALLBACK_BYTES)
}

#[cfg(unix)]
fn read_passwd_shell(buffer: &mut [libc::c_char]) -> Result<Option<String>, libc::c_int> {
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer refers to storage owned by this frame, `buffer`'s
    // length is passed alongside it, and `getpwuid_r` writes only into them.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 {
        return Err(status);
    }
    if found.is_null() {
        return Ok(None);
    }
    // SAFETY: a non-null `found` points at `entry`, which `getpwuid_r` filled.
    let shell = unsafe { (*found).pw_shell };
    if shell.is_null() {
        return Ok(None);
    }
    // SAFETY: `pw_shell` is a NUL-terminated string stored in `buffer`, which
    // outlives this borrow.
    let text = unsafe { std::ffi::CStr::from_ptr(shell) };
    Ok(Some(text.to_string_lossy().into_owned()))
}

#[cfg(unix)]
fn valid_shell(shell: &str) -> bool {
    shell.starts_with('/') && std::path::Path::new(shell).exists()
}

#[cfg(windows)]
fn valid_shell(shell: &str) -> bool {
    let path = std::path::Path::new(shell);
    path.is_absolute() && path.exists()
}

#[cfg(windows)]
pub(super) fn find_on_path(exe: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    let pathext: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    for dir in std::env::split_paths(&paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let exact = dir.join(exe);
        if exact.is_file() {
            return Some(exact.to_string_lossy().into_owned());
        }
        for ext in &pathext {
            let candidate = dir.join(format!("{}{}", exe, ext));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    if let Some(git) = find_on_path("git.exe") {
        let path = std::path::Path::new(&git);
        if let Some(root) = path.parent().and_then(|p| p.parent()) {
            let bash = root.join("bin").join("bash.exe");
            if bash.exists() {
                return Some(bash.to_string_lossy().into_owned());
            }
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        std::path::PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            std::path::Path::new(&local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellFlavor {
    PowerShell,
    Cmd,
    Posix,
}

#[cfg(windows)]
pub(super) fn shell_flavor(shell: &str) -> ShellFlavor {
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_lowercase();
    if name.starts_with("pwsh") || name.starts_with("powershell") {
        ShellFlavor::PowerShell
    } else if name.starts_with("cmd") {
        ShellFlavor::Cmd
    } else {
        ShellFlavor::Posix
    }
}

#[cfg(unix)]
pub(super) fn user_shell() -> String {
    if let Some(shell) = login_shell() {
        return shell;
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if valid_shell(&shell) {
            return shell;
        }
    }
    "/bin/zsh".to_string()
}

#[cfg(windows)]
pub(super) fn user_shell() -> String {
    if let Some(pwsh) = find_on_path("pwsh.exe") {
        return pwsh;
    }
    if let Some(ps) = find_on_path("powershell.exe") {
        return ps;
    }
    if let Ok(comspec) = std::env::var("COMSPEC") {
        if valid_shell(&comspec) {
            return comspec;
        }
    }
    r"C:\Windows\System32\cmd.exe".to_string()
}

pub(super) fn resolve_shell(preferred: Option<&str>) -> String {
    match preferred.map(str::trim) {
        Some(shell) if valid_shell(shell) => shell.to_string(),
        _ => user_shell(),
    }
}

#[tauri::command(async)]
pub fn list_available_shells() -> Vec<String> {
    let mut shells: Vec<String> = Vec::new();
    let mut add = |shell: String| {
        if valid_shell(&shell) && !shells.contains(&shell) {
            shells.push(shell);
        }
    };
    #[cfg(unix)]
    {
        if let Some(shell) = login_shell() {
            add(shell);
        }
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let line = line.trim();
                if line.starts_with('#') {
                    continue;
                }
                add(line.to_string());
            }
        }
        if let Ok(shell) = std::env::var("SHELL") {
            add(shell);
        }
    }
    #[cfg(windows)]
    {
        if let Some(pwsh) = find_on_path("pwsh.exe") {
            add(pwsh);
        }
        if let Some(ps) = find_on_path("powershell.exe") {
            add(ps);
        }
        if let Some(bash) = find_git_bash() {
            add(bash);
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            add(comspec);
        }
        add(r"C:\Windows\System32\cmd.exe".to_string());
    }
    shells
}

#[cfg(all(test, unix))]
mod tests {
    use super::{list_available_shells, login_shell, read_passwd_shell, resolve_shell};

    const CONCURRENT_CALLERS: usize = 16;

    #[test]
    fn given_concurrent_callers_when_reading_the_login_shell_then_they_all_agree() {
        let expected = login_shell();

        let results: Vec<Option<String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..CONCURRENT_CALLERS)
                .map(|_| scope.spawn(login_shell))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("login shell thread"))
                .collect()
        });

        assert!(results.iter().all(|shell| *shell == expected));
    }

    #[test]
    fn given_a_buffer_too_small_for_the_entry_when_reading_then_it_asks_for_a_larger_one() {
        let mut buffer: Vec<libc::c_char> = vec![0; 1];

        assert_eq!(read_passwd_shell(&mut buffer), Err(libc::ERANGE));
    }

    #[test]
    fn given_an_invalid_preferred_shell_when_resolving_then_it_falls_back_to_a_real_shell() {
        let shell = resolve_shell(Some("relative/sh"));

        assert!(shell.starts_with('/'));
        assert_eq!(resolve_shell(Some(" /bin/sh ")), "/bin/sh");
    }

    #[test]
    fn given_the_system_shells_when_listing_them_then_each_is_absolute_and_listed_once() {
        let shells = list_available_shells();

        let mut unique = shells.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), shells.len());
        assert!(shells.iter().all(|shell| shell.starts_with('/')));
    }
}
