pub const ENV_URL: &str = "TERRA_MCP_URL";
pub const ENV_TOKEN: &str = "TERRA_MCP_TOKEN";
pub const ENV_PANE_ID: &str = "TERRA_PANE_ID";
pub const ENV_WORKSPACE_ID: &str = "TERRA_WORKSPACE_ID";
pub const ENV_HOOK_URL: &str = "TERRA_HOOK_URL";

/// Name the server is registered under in each CLI.
pub const SERVER_NAME: &str = "terra";

/// How the shell that runs the command expects arguments to be quoted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quoting {
    /// `sh -c`: single quotes.
    Posix,
    /// PowerShell `-Command` / `cmd /C`: double quotes.
    // Constructed only under cfg(windows) in pty::spawn_terminal_inner.
    #[cfg_attr(unix, allow(dead_code))]
    Windows,
}

/// The agent id of a command line: its executable's file name.
pub fn agent_of(command: &str) -> String {
    let executable = command.split_whitespace().next().unwrap_or("");
    if executable.is_empty() || executable == "shell" {
        return "shell".into();
    }
    let name = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd");
    name.to_string()
}

pub(super) fn quote(value: &str, quoting: Quoting) -> String {
    match quoting {
        Quoting::Posix => format!("'{}'", value.replace('\'', r"'\''")),
        Quoting::Windows => format!("\"{}\"", value.replace('"', "")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_is_the_executable_name() {
        assert_eq!(agent_of("claude --continue"), "claude");
        assert_eq!(agent_of("/opt/bin/codex resume --last"), "codex");
        assert_eq!(agent_of(r"C:\tools\codex.exe"), "codex");
        assert_eq!(agent_of(""), "shell");
        assert_eq!(agent_of("shell"), "shell");
    }

    #[test]
    fn posix_quoting_escapes_single_quotes() {
        assert_eq!(quote("it's", Quoting::Posix), r"'it'\''s'");
    }
}
