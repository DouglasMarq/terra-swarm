//! Team roles. An agent started with a role learns what is expected of it
//! from `whoami`, and the orchestrator can hand tasks to its teammates.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Orchestrator,
    Planner,
    Executor,
    Reviewer,
    Tester,
}

impl Role {
    #[cfg(test)]
    pub const ALL: [Role; 5] = [
        Role::Orchestrator,
        Role::Planner,
        Role::Executor,
        Role::Reviewer,
        Role::Tester,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Orchestrator => "orchestrator",
            Role::Planner => "planner",
            Role::Executor => "executor",
            Role::Reviewer => "reviewer",
            Role::Tester => "tester",
        }
    }

    /// Only the orchestrator hands work to other agents (and so may type
    /// into their terminals through `assign_task`).
    pub fn can_assign(self) -> bool {
        self == Role::Orchestrator
    }

    /// One line for the agent's system prompt; the details come from `whoami`.
    /// Plain words only, so it needs no escaping in any shell.
    pub fn brief(self) -> String {
        format!(
            "You are the {} of a Terra Swarm agent team. Call the terra MCP tool whoami first: it returns your role instructions and your teammates.",
            self.as_str()
        )
    }

    pub fn instructions(self) -> &'static str {
        match self {
            Role::Orchestrator => "You coordinate the team and do not write code yourself. When the human \
                gives you a goal: (1) break it into small, independently verifiable tasks with \
                `create_task`, using `depends_on` for order and putting acceptance criteria in the \
                description; (2) hand each task to a teammate whose role fits with `assign_task` \
                (executors build, testers write and run tests, reviewers check finished work); it \
                delivers the task and wakes the agent when it is idle; (3) follow progress with \
                `list_tasks` and `read_inbox`, and when a task reaches `review`, assign a reviewer; \
                (4) answer teammates with `send_message`; (5) keep `report_status` current and tell \
                the human when the goal is done. Give each agent one active task at a time.",
            Role::Planner => "You turn goals into a plan on the board. Study the codebase, then create \
                tasks with clear acceptance criteria and `depends_on` links. Do not implement. Tell \
                the orchestrator (or \"all\") with `send_message` when the plan is ready.",
            Role::Executor => "You implement tasks. Work on tasks assigned to you (`list_tasks` with \
                assignee \"me\") or claim a `todo` task that fits. Keep changes focused on the task, \
                run the relevant tests, then `complete_task` with what changed and how you verified \
                it. If you are stuck, set the task `blocked` with `update_task` and a note, and \
                message the orchestrator.",
            Role::Reviewer => "You review finished work. Take tasks in `review`, read the changes \
                (git diff), and check correctness, tests and style. Record findings with \
                `update_task` notes. If changes are needed, move the task back to `in_progress` and \
                message its assignee; if it is good, move it to `done`.",
            Role::Tester => "You verify behaviour. For tasks assigned to you or in `review`, write or \
                extend automated tests and run the suite. Report failures with `update_task` notes \
                and `send_message` to the task's assignee. Finish your own tasks with \
                `complete_task`, summarising coverage and results.",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_round_trip_and_only_the_orchestrator_assigns() {
        for role in Role::ALL {
            let text = serde_json::to_string(&role).unwrap();
            assert_eq!(text, format!("\"{}\"", role.as_str()));
            assert_eq!(serde_json::from_str::<Role>(&text).unwrap(), role);
            assert!(!role.instructions().is_empty());
            assert!(role
                .brief()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " .:,".contains(c)));
        }
        assert!(Role::Orchestrator.can_assign());
        assert!(!Role::Executor.can_assign());
    }
}
