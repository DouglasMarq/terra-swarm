use serde::{Deserialize, Serialize};

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_LABELS: usize = 16;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_NOTE_KEY_CHARS: usize = 80;
pub const DEFAULT_INBOX_LIMIT: usize = 50;
pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 200;
pub const TASK_EVENTS_SHOWN: usize = 50;
const MIN_LIMIT: usize = 1;
const BYTES_PER_KIB: usize = 1024;
const TASK_ID_PREFIX: &str = "T-";

pub struct Actor<'a> {
    pub workspace_id: &'a str,
    pub name: &'a str,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Review,
    Done,
    Blocked,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 5] = [
        TaskStatus::Todo,
        TaskStatus::InProgress,
        TaskStatus::Review,
        TaskStatus::Done,
        TaskStatus::Blocked,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Review => "review",
            TaskStatus::Done => "done",
            TaskStatus::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
}

impl TaskPriority {
    pub const ALL: [TaskPriority; 4] = [
        TaskPriority::Urgent,
        TaskPriority::High,
        TaskPriority::Medium,
        TaskPriority::Low,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskPriority::Urgent => "urgent",
            TaskPriority::High => "high",
            TaskPriority::Medium => "medium",
            TaskPriority::Low => "low",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|priority| priority.as_str() == value)
    }

    pub fn rank(self) -> i64 {
        self as i64
    }

    pub fn from_rank(rank: i64) -> Self {
        let rank = rank.clamp(TaskPriority::Urgent.rank(), TaskPriority::Low.rank());
        usize::try_from(rank)
            .ok()
            .and_then(|index| Self::ALL.get(index))
            .copied()
            .unwrap_or(TaskPriority::Medium)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TaskEvent {
    pub actor: String,
    pub kind: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub assignee: Option<String>,
    pub created_by: String,
    pub labels: Vec<String>,
    pub position: f64,
    pub depends_on: Vec<String>,
    pub blocked_by: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<TaskEvent>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub id: i64,
    pub workspace_id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    pub created_at: i64,
    pub read_by: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub id: i64,
    pub workspace_id: String,
    pub key: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Working,
    Idle,
    NeedsInput,
    Blocked,
}

impl AgentState {
    pub const ALL: [AgentState; 4] = [
        AgentState::Working,
        AgentState::Idle,
        AgentState::NeedsInput,
        AgentState::Blocked,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Idle => "idle",
            AgentState::NeedsInput => "needs_input",
            AgentState::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == value)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentStatus {
    pub terminal_id: String,
    pub workspace_id: String,
    pub state: AgentState,
    pub summary: String,
    pub updated_at: i64,
}

#[derive(Default, Clone, Debug)]
pub struct NewTask {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<TaskPriority>,
    pub labels: Vec<String>,
    pub depends_on: Vec<String>,
    pub assignee: Option<String>,
}

#[derive(Default, Clone, Debug)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub assignee: Option<Option<String>>,
    pub position: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    NotFound(String),
    Invalid(String),
    Conflict(String),
    Unavailable(String),
    Database(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(message)
            | StoreError::Invalid(message)
            | StoreError::Conflict(message) => f.write_str(message),
            StoreError::Unavailable(_) => f.write_str("the Terra MCP database is unavailable"),
            StoreError::Database(_) => f.write_str("database error"),
        }
    }
}

impl StoreError {
    pub fn log_internal(&self, context: &str) {
        if let StoreError::Unavailable(detail) | StoreError::Database(detail) = self {
            eprintln!("{}: {}", context, detail);
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Database(error.to_string())
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

pub fn normalize_task_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let digits = raw
        .strip_prefix('T')
        .or_else(|| raw.strip_prefix('t'))
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(raw);
    digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| format!("T-{}", n))
}

pub fn task_not_found(raw: &str) -> StoreError {
    StoreError::NotFound(format!("task {} not found in this workspace", raw.trim()))
}

pub fn clean_title(raw: &str) -> StoreResult<String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(StoreError::Invalid("title cannot be empty".into()));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(StoreError::Invalid(format!(
            "title is longer than {} characters",
            MAX_TITLE_CHARS
        )));
    }
    Ok(title.to_string())
}

pub fn clean_body(raw: &str, what: &str, allow_empty: bool) -> StoreResult<String> {
    let body = raw.trim();
    if body.is_empty() && !allow_empty {
        return Err(StoreError::Invalid(format!("{} cannot be empty", what)));
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(StoreError::Invalid(format!(
            "{} is larger than {} KiB",
            what,
            MAX_BODY_BYTES / BYTES_PER_KIB
        )));
    }
    Ok(body.to_string())
}

pub fn clean_labels(raw: &[String]) -> StoreResult<Vec<String>> {
    let mut labels: Vec<String> = Vec::new();
    for label in raw {
        let label = label.trim();
        if label.is_empty() || labels.iter().any(|existing| existing == label) {
            continue;
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            return Err(StoreError::Invalid(format!(
                "label `{}` is too long",
                label
            )));
        }
        labels.push(label.to_string());
    }
    if labels.len() > MAX_LABELS {
        return Err(StoreError::Invalid(format!(
            "at most {} labels",
            MAX_LABELS
        )));
    }
    Ok(labels)
}

pub fn clamp_limit(limit: Option<usize>, default: usize) -> usize {
    limit.unwrap_or(default).clamp(MIN_LIMIT, MAX_LIMIT)
}

pub fn task_id_of(number: i64) -> String {
    format!("{}{}", TASK_ID_PREFIX, number)
}
