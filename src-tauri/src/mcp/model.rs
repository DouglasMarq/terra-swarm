use serde::{Deserialize, Serialize};

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

/// Stored as an integer (0 urgent … 3 low), exposed by name.
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
        Self::ALL
            .get(rank.clamp(TaskPriority::Urgent.rank(), TaskPriority::Low.rank()) as usize)
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
    /// Dependencies that are not `done` yet; non-empty means it can't be claimed.
    pub blocked_by: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The latest events, oldest first. Omitted from summaries.
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
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(AgentState::Working),
            "idle" => Some(AgentState::Idle),
            "needs_input" => Some(AgentState::NeedsInput),
            "blocked" => Some(AgentState::Blocked),
            _ => None,
        }
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

/// A partial update. `assignee: Some(None)` unassigns the task.
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
            StoreError::Unavailable(message) => {
                write!(f, "the Terra MCP database is unavailable: {}", message)
            }
            StoreError::Database(message) => write!(f, "database error: {}", message),
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

/// Accept `T-12`, `t-12` and a bare `12`, so agents can be sloppy with ids.
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
