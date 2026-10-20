//! Which shell runs a terminal: the login shell, `/etc/shells` and, on
//! Windows, PowerShell, Git Bash and cmd.

#[cfg(unix)]
fn login_shell() -> Option<String> {
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*pw).pw_shell)
            .to_string_lossy()
            .into_owned();
        if shell.is_empty() || !std::path::Path::new(&shell).exists() {
            None
        } else {
            Some(shell)
        }
    }
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
    // Search PATH directly instead of shelling out to where.exe: its output is
    // encoded in the console OEM codepage, so any non-ASCII install path
    // (accented usernames, localized "Program Files") breaks UTF-8 decoding
    // and the tool is reported missing.
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
