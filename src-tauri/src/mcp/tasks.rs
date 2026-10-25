use super::messages::{self, Outgoing};
use super::model::{
    clean_body, clean_labels, clean_title, normalize_task_id, task_id_of, task_not_found, Actor,
    Message, NewTask, StoreError, StoreResult, Task, TaskPatch, TaskPriority, TaskStatus,
    TASK_EVENTS_SHOWN,
};
use super::repo::{EventRecord, Queries, Repo};
use crate::clock::now_millis;

const FIRST_POSITION: f64 = 1.0;
const POSITION_STEP: f64 = 1.0;

pub struct TaskUpdate<'a> {
    pub id: &'a str,
    pub patch: TaskPatch,
}

pub struct Assignment<'a> {
    pub id: &'a str,
    pub to: &'a str,
    pub note: Option<&'a str>,
}

pub struct Completion<'a> {
    pub id: &'a str,
    pub summary: &'a str,
}

pub fn get(repo: &Repo, workspace_id: &str, raw_id: &str) -> StoreResult<Task> {
    let queries = repo.queries();
    let id = resolve_id(queries, workspace_id, raw_id)?;
    queries.task(workspace_id, &id, Some(TASK_EVENTS_SHOWN))
}

pub fn delete(repo: &Repo, workspace_id: &str, raw_id: &str) -> StoreResult<()> {
    let queries = repo.queries();
    let id = resolve_id(queries, workspace_id, raw_id)?;
    queries.delete_task(workspace_id, &id)
}

pub fn create(repo: &mut Repo, actor: &Actor<'_>, new: NewTask) -> StoreResult<Task> {
    let tx = repo.transaction()?;
    let queries = tx.queries();
    let task = new_task(queries, actor, new)?;
    queries.insert_task(&task)?;
    let change = Change {
        actor: actor.name,
        task_id: &task.id,
        at: task.created_at,
    };
    change.record(queries, "created", "")?;
    if let Some(assignee) = &task.assignee {
        change.record(queries, "assigned", assignee)?;
    }
    tx.commit()?;
    shown(repo, actor, &task.id)
}

pub fn claim(repo: &mut Repo, actor: &Actor<'_>, raw_id: &str) -> StoreResult<Task> {
    let at = now_millis();
    let tx = repo.transaction()?;
    let queries = tx.queries();
    let mut task = existing(queries, actor.workspace_id, raw_id)?;
    ensure_claimable(&task, actor.name)?;
    task.assignee = Some(actor.name.to_string());
    task.status = TaskStatus::InProgress;
    task.position = end_of_column(queries, actor.workspace_id, TaskStatus::InProgress)?;
    task.updated_at = at;
    queries.save_task(&task)?;
    let change = Change {
        actor: actor.name,
        task_id: &task.id,
        at,
    };
    change.record(queries, "claimed", "")?;
    tx.commit()?;
    shown(repo, actor, &task.id)
}

pub fn update(repo: &mut Repo, actor: &Actor<'_>, update: TaskUpdate<'_>) -> StoreResult<Task> {
    let tx = repo.transaction()?;
    let id = apply_patch(tx.queries(), actor, update)?;
    tx.commit()?;
    shown(repo, actor, &id)
}

pub fn assign(
    repo: &mut Repo,
    actor: &Actor<'_>,
    assignment: &Assignment<'_>,
) -> StoreResult<(Task, Message)> {
    let tx = repo.transaction()?;
    let queries = tx.queries();
    let current = existing(queries, actor.workspace_id, assignment.id)?;
    ensure_assignable(&current)?;
    let patch = TaskPatch {
        assignee: Some(Some(assignment.to.to_string())),
        status: (current.status == TaskStatus::Todo).then_some(TaskStatus::InProgress),
        ..TaskPatch::default()
    };
    let id = apply_patch(
        queries,
        actor,
        TaskUpdate {
            id: &current.id,
            patch,
        },
    )?;
    let task = queries.task(actor.workspace_id, &id, Some(TASK_EVENTS_SHOWN))?;
    let body = assignment_message(&task, assignment.note);
    let outgoing = Outgoing {
        to: assignment.to,
        body: &body,
    };
    let message = messages::send(queries, actor, &outgoing)?;
    tx.commit()?;
    Ok((task, message))
}

pub fn complete(
    repo: &mut Repo,
    actor: &Actor<'_>,
    completion: &Completion<'_>,
) -> StoreResult<Task> {
    let summary = clean_body(completion.summary, "summary", false)?;
    let at = now_millis();
    let tx = repo.transaction()?;
    let queries = tx.queries();
    let mut task = existing(queries, actor.workspace_id, completion.id)?;
    ensure_completable(&task, actor.name)?;
    if task.status != TaskStatus::Review {
        task.position = end_of_column(queries, actor.workspace_id, TaskStatus::Review)?;
    }
    task.status = TaskStatus::Review;
    task.assignee = Some(actor.name.to_string());
    task.updated_at = at;
    queries.save_task(&task)?;
    let change = Change {
        actor: actor.name,
        task_id: &task.id,
        at,
    };
    change.record(queries, "completed", &summary)?;
    tx.commit()?;
    shown(repo, actor, &task.id)
}

fn shown(repo: &Repo, actor: &Actor<'_>, id: &str) -> StoreResult<Task> {
    repo.queries()
        .task(actor.workspace_id, id, Some(TASK_EVENTS_SHOWN))
}

fn resolve_id(queries: Queries<'_>, workspace_id: &str, raw_id: &str) -> StoreResult<String> {
    let id = normalize_task_id(raw_id).ok_or_else(|| task_not_found(raw_id))?;
    if !queries.has_task(workspace_id, &id)? {
        return Err(task_not_found(raw_id));
    }
    Ok(id)
}

fn existing(queries: Queries<'_>, workspace_id: &str, raw_id: &str) -> StoreResult<Task> {
    let id = resolve_id(queries, workspace_id, raw_id)?;
    queries.task(workspace_id, &id, None)
}

struct Change<'a> {
    actor: &'a str,
    task_id: &'a str,
    at: i64,
}

impl Change<'_> {
    fn record(&self, queries: Queries<'_>, kind: &str, body: &str) -> StoreResult<()> {
        queries.add_event(&EventRecord {
            task_id: self.task_id,
            actor: self.actor,
            kind,
            body,
            at: self.at,
        })
    }
}

fn new_task(queries: Queries<'_>, actor: &Actor<'_>, new: NewTask) -> StoreResult<Task> {
    let at = now_millis();
    let title = clean_title(&new.title)?;
    let description = clean_body(
        new.description.as_deref().unwrap_or(""),
        "description",
        true,
    )?;
    let labels = clean_labels(&new.labels)?;
    let assignee = new.assignee.filter(|id| !id.trim().is_empty());
    let status = if assignee.is_some() {
        TaskStatus::InProgress
    } else {
        TaskStatus::Todo
    };
    let depends_on = dependency_ids(queries, actor.workspace_id, &new.depends_on)?;
    Ok(Task {
        id: task_id_of(queries.next_task_number()?),
        workspace_id: actor.workspace_id.to_string(),
        title,
        description,
        status,
        priority: new.priority.unwrap_or(TaskPriority::Medium),
        assignee,
        created_by: actor.name.to_string(),
        labels,
        position: end_of_column(queries, actor.workspace_id, status)?,
        depends_on,
        blocked_by: Vec::new(),
        created_at: at,
        updated_at: at,
        events: None,
    })
}

fn dependency_ids(
    queries: Queries<'_>,
    workspace_id: &str,
    raw: &[String],
) -> StoreResult<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let normalized: Vec<Option<String>> = raw.iter().map(|dep| normalize_task_id(dep)).collect();
    let candidates: Vec<&str> = normalized.iter().flatten().map(String::as_str).collect();
    let existing = queries.existing_task_ids(workspace_id, &candidates)?;
    let mut depends_on: Vec<String> = Vec::new();
    for (dep, id) in raw.iter().zip(normalized) {
        let Some(id) = id.filter(|id| existing.contains(id)) else {
            return Err(StoreError::Invalid(format!(
                "dependency {} is not a task in this workspace",
                dep
            )));
        };
        if !depends_on.contains(&id) {
            depends_on.push(id);
        }
    }
    Ok(depends_on)
}

fn end_of_column(queries: Queries<'_>, workspace_id: &str, status: TaskStatus) -> StoreResult<f64> {
    let max = queries.max_position(workspace_id, status)?;
    Ok(max.map_or(FIRST_POSITION, |max| max.floor() + POSITION_STEP))
}

fn ensure_unblocked(task: &Task) -> StoreResult<()> {
    if task.blocked_by.is_empty() {
        return Ok(());
    }
    Err(StoreError::Conflict(format!(
        "task {} depends on unfinished tasks: {}",
        task.id,
        task.blocked_by.join(", ")
    )))
}

fn ensure_not_done(task: &Task) -> StoreResult<()> {
    if task.status != TaskStatus::Done {
        return Ok(());
    }
    Err(StoreError::Conflict(format!(
        "task {} is already done",
        task.id
    )))
}

fn ensure_claimable(task: &Task, who: &str) -> StoreResult<()> {
    ensure_unblocked(task)?;
    match task.assignee.as_deref() {
        Some(owner) if owner == who => Err(StoreError::Conflict(format!(
            "you already hold task {}",
            task.id
        ))),
        Some(owner) => Err(StoreError::Conflict(format!(
            "task {} is already claimed by {}",
            task.id, owner
        ))),
        None if task.status != TaskStatus::Todo => Err(StoreError::Conflict(format!(
            "task {} is `{}`; only `todo` tasks can be claimed",
            task.id,
            task.status.as_str()
        ))),
        None => Ok(()),
    }
}

fn ensure_assignable(task: &Task) -> StoreResult<()> {
    ensure_unblocked(task)?;
    ensure_not_done(task)
}

fn ensure_completable(task: &Task, who: &str) -> StoreResult<()> {
    if let Some(owner) = task.assignee.as_deref().filter(|owner| *owner != who) {
        return Err(StoreError::Conflict(format!(
            "task {} is assigned to {}; only they can complete it",
            task.id, owner
        )));
    }
    ensure_not_done(task)
}

fn assignment_message(task: &Task, note: Option<&str>) -> String {
    match note.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => format!("I assigned you {}: {}. {}", task.id, task.title, note),
        None => format!("I assigned you {}: {}.", task.id, task.title),
    }
}

fn apply_patch(
    queries: Queries<'_>,
    actor: &Actor<'_>,
    update: TaskUpdate<'_>,
) -> StoreResult<String> {
    let before = existing(queries, actor.workspace_id, update.id)?;
    let patch = clean_patch(update.patch)?;
    let change = Change {
        actor: actor.name,
        task_id: &before.id,
        at: now_millis(),
    };
    let mut after = patched(&before, &patch);
    after.position = new_position(queries, &before, &patch)?;
    after.updated_at = change.at;
    queries.save_task(&after)?;
    for (kind, body) in patch_events(&before, &after, patch.note.as_deref()) {
        change.record(queries, kind, &body)?;
    }
    Ok(before.id.clone())
}

fn clean_patch(patch: TaskPatch) -> StoreResult<TaskPatch> {
    let title = patch.title.as_deref().map(clean_title).transpose()?;
    let description = patch
        .description
        .as_deref()
        .map(|value| clean_body(value, "description", true))
        .transpose()?;
    let note = patch
        .note
        .as_deref()
        .map(|value| clean_body(value, "note", false))
        .transpose()?;
    if patch.position.is_some_and(|position| !position.is_finite()) {
        return Err(StoreError::Invalid(
            "position must be a finite number".into(),
        ));
    }
    Ok(TaskPatch {
        title,
        description,
        note,
        assignee: patch
            .assignee
            .map(|value| value.filter(|id| !id.trim().is_empty())),
        ..patch
    })
}

fn patched(before: &Task, patch: &TaskPatch) -> Task {
    Task {
        title: patch.title.clone().unwrap_or_else(|| before.title.clone()),
        description: patch
            .description
            .clone()
            .unwrap_or_else(|| before.description.clone()),
        status: patch.status.unwrap_or(before.status),
        priority: patch.priority.unwrap_or(before.priority),
        assignee: patch
            .assignee
            .clone()
            .unwrap_or_else(|| before.assignee.clone()),
        ..before.clone()
    }
}

fn new_position(queries: Queries<'_>, before: &Task, patch: &TaskPatch) -> StoreResult<f64> {
    if let Some(position) = patch.position {
        return Ok(position);
    }
    match patch.status.filter(|status| *status != before.status) {
        Some(status) => end_of_column(queries, &before.workspace_id, status),
        None => Ok(before.position),
    }
}

fn patch_events(before: &Task, after: &Task, note: Option<&str>) -> Vec<(&'static str, String)> {
    let mut events = Vec::new();
    if after.status != before.status {
        events.push((
            "status",
            format!("{} → {}", before.status.as_str(), after.status.as_str()),
        ));
    }
    if after.assignee != before.assignee {
        events.push(("assigned", after.assignee.clone().unwrap_or_default()));
    }
    if let Some(note) = note {
        events.push(("note", note.to_string()));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::super::messages::{self, Outgoing};
    use super::super::model::{MAX_BODY_BYTES, MAX_TITLE_CHARS};
    use super::super::notes::{self, NoteDraft};
    use super::super::repo::{StatusFilter, TaskQuery};
    use super::super::test_support::actor;
    use super::*;
    use rusqlite::params;
    use std::sync::{Arc, Barrier, Mutex};

    fn task(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..NewTask::default()
        }
    }

    fn set_status(repo: &mut Repo, id: &str, status: TaskStatus) {
        update(
            repo,
            &actor("ws-1", "user"),
            TaskUpdate {
                id,
                patch: TaskPatch {
                    status: Some(status),
                    ..TaskPatch::default()
                },
            },
        )
        .unwrap();
    }

    #[test]
    fn task_crud_with_dependencies_and_events() {
        let mut repo = Repo::in_memory();
        let base = create(&mut repo, &actor("ws-1", "t-1"), task("Lexer")).unwrap();
        let created = create(
            &mut repo,
            &actor("ws-1", "t-1"),
            NewTask {
                title: "  Write the parser ".into(),
                description: Some("tokens first".into()),
                priority: Some(TaskPriority::High),
                labels: vec!["backend".into(), "backend".into(), " ".into()],
                depends_on: vec!["t-1".into(), "1".into()],
                ..NewTask::default()
            },
        )
        .unwrap();
        assert_eq!(base.id, "T-1");
        assert_eq!(created.id, "T-2");
        assert_eq!(created.title, "Write the parser");
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.priority, TaskPriority::High);
        assert_eq!(created.labels, vec!["backend".to_string()]);
        assert_eq!(created.depends_on, vec!["T-1".to_string()]);
        assert_eq!(created.blocked_by, vec!["T-1".to_string()]);
        assert_eq!(created.position, 2.0);
        assert_eq!(created.events.as_ref().unwrap()[0].kind, "created");

        let updated = update(
            &mut repo,
            &actor("ws-1", "user"),
            TaskUpdate {
                id: "T-2",
                patch: TaskPatch {
                    status: Some(TaskStatus::Blocked),
                    note: Some("waiting on the lexer".into()),
                    ..TaskPatch::default()
                },
            },
        )
        .unwrap();
        assert_eq!(updated.status, TaskStatus::Blocked);
        let kinds: Vec<&str> = updated
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|e| e.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["created", "status", "note"]);
        assert_eq!(updated.events.as_ref().unwrap()[1].body, "todo → blocked");

        set_status(&mut repo, "T-1", TaskStatus::Done);
        assert!(get(&repo, "ws-1", "T-2").unwrap().blocked_by.is_empty());

        delete(&repo, "ws-1", "T-1").unwrap();
        assert!(matches!(
            get(&repo, "ws-1", "T-1"),
            Err(StoreError::NotFound(_))
        ));
        assert!(get(&repo, "ws-1", "T-2").unwrap().depends_on.is_empty());
        assert_eq!(repo.count("task_deps"), 0);
    }

    #[test]
    fn list_orders_by_status_priority_and_position() {
        let mut repo = Repo::in_memory();
        create(&mut repo, &actor("ws-1", "u"), task("medium first")).unwrap();
        create(
            &mut repo,
            &actor("ws-1", "u"),
            NewTask {
                title: "urgent".into(),
                priority: Some(TaskPriority::Urgent),
                ..NewTask::default()
            },
        )
        .unwrap();
        create(&mut repo, &actor("ws-1", "u"), task("medium second")).unwrap();
        create(&mut repo, &actor("ws-1", "u"), task("in progress")).unwrap();
        create(&mut repo, &actor("ws-1", "u"), task("finished")).unwrap();
        set_status(&mut repo, "T-4", TaskStatus::InProgress);
        set_status(&mut repo, "T-5", TaskStatus::Done);
        update(
            &mut repo,
            &actor("ws-1", "u"),
            TaskUpdate {
                id: "T-3",
                patch: TaskPatch {
                    position: Some(0.5),
                    ..TaskPatch::default()
                },
            },
        )
        .unwrap();

        let ids: Vec<String> = repo
            .queries()
            .list_tasks(&TaskQuery::all("ws-1"))
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec!["T-4", "T-2", "T-3", "T-1", "T-5"]);
        assert!(
            repo.queries().list_tasks(&TaskQuery::all("ws-1")).unwrap()[0]
                .events
                .is_none()
        );
        assert_eq!(
            repo.queries()
                .list_tasks(&TaskQuery {
                    status: StatusFilter::Is(TaskStatus::Todo),
                    ..TaskQuery::all("ws-1")
                })
                .unwrap()
                .len(),
            3
        );
        let moved = update(
            &mut repo,
            &actor("ws-1", "u"),
            TaskUpdate {
                id: "T-2",
                patch: TaskPatch {
                    status: Some(TaskStatus::Done),
                    ..TaskPatch::default()
                },
            },
        )
        .unwrap();
        assert_eq!(moved.position, 2.0);
    }

    #[test]
    fn tasks_are_invisible_from_other_workspaces() {
        let mut repo = Repo::in_memory();
        create(&mut repo, &actor("ws-1", "t-1"), task("secret")).unwrap();
        assert!(repo
            .queries()
            .list_tasks(&TaskQuery::all("ws-2"))
            .unwrap()
            .is_empty());
        assert!(matches!(
            get(&repo, "ws-2", "T-1"),
            Err(StoreError::NotFound(_))
        ));
        assert!(claim(&mut repo, &actor("ws-2", "t-9"), "T-1").is_err());
        assert!(delete(&repo, "ws-2", "T-1").is_err());
        assert!(create(
            &mut repo,
            &actor("ws-2", "t-9"),
            NewTask {
                title: "x".into(),
                depends_on: vec!["T-1".into()],
                ..NewTask::default()
            }
        )
        .is_err());
    }

    #[test]
    fn given_a_task_of_another_workspace_task_writes_find_nothing_and_change_nothing() {
        let mut repo = Repo::in_memory();
        create(&mut repo, &actor("ws-1", "t-1"), task("private")).unwrap();
        let not_found = |result: StoreResult<Task>| matches!(result, Err(StoreError::NotFound(_)));
        assert!(not_found(update(
            &mut repo,
            &actor("ws-2", "t-9"),
            TaskUpdate {
                id: "T-1",
                patch: TaskPatch {
                    title: Some("taken over".into()),
                    status: Some(TaskStatus::Done),
                    note: Some("mine now".into()),
                    ..TaskPatch::default()
                }
            }
        )));
        assert!(not_found(claim(&mut repo, &actor("ws-2", "t-9"), "T-1")));
        assert!(not_found(complete(
            &mut repo,
            &actor("ws-2", "t-9"),
            &Completion {
                id: "T-1",
                summary: "done"
            }
        )));
        assert!(matches!(
            assign(
                &mut repo,
                &actor("ws-2", "t-9"),
                &Assignment {
                    id: "T-1",
                    to: "t-8",
                    note: None
                }
            ),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            delete(&repo, "ws-2", "T-1"),
            Err(StoreError::NotFound(_))
        ));

        let task = get(&repo, "ws-1", "T-1").unwrap();
        assert_eq!(task.title, "private");
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.assignee, None);
        assert_eq!(task.events.unwrap().len(), 1);
        assert_eq!(repo.count("messages"), 0);
    }

    #[test]
    fn given_a_dependency_link_to_another_workspace_it_neither_shows_nor_blocks() {
        let mut repo = Repo::in_memory();
        let foreign = create(&mut repo, &actor("ws-1", "t-1"), task("foreign")).unwrap();
        let local = create(&mut repo, &actor("ws-2", "t-5"), task("local")).unwrap();
        repo.execute(
            "INSERT INTO task_deps(task_id, depends_on) VALUES (?1, ?2)",
            params![local.id, foreign.id],
        );
        let loaded = get(&repo, "ws-2", &local.id).unwrap();
        assert!(loaded.depends_on.is_empty());
        assert!(loaded.blocked_by.is_empty());
        assert!(claim(&mut repo, &actor("ws-2", "t-5"), &local.id).is_ok());
    }

    #[test]
    fn given_several_tasks_each_gets_its_own_dependencies_and_latest_events() {
        let mut repo = Repo::in_memory();
        let first = create(&mut repo, &actor("ws-1", "t-1"), task("first")).unwrap();
        let second = create(
            &mut repo,
            &actor("ws-1", "t-1"),
            NewTask {
                title: "second".into(),
                depends_on: vec![first.id.clone()],
                ..NewTask::default()
            },
        )
        .unwrap();
        create(
            &mut repo,
            &actor("ws-1", "t-1"),
            NewTask {
                title: "third".into(),
                depends_on: vec![second.id.clone(), first.id.clone(), "T-2".into()],
                ..NewTask::default()
            },
        )
        .unwrap();
        set_status(&mut repo, &first.id, TaskStatus::Done);
        for step in ["a", "b", "c"] {
            update(
                &mut repo,
                &actor("ws-1", "t-1"),
                TaskUpdate {
                    id: &second.id,
                    patch: TaskPatch {
                        note: Some(step.into()),
                        ..TaskPatch::default()
                    },
                },
            )
            .unwrap();
        }

        let tasks = repo
            .queries()
            .list_tasks(&TaskQuery {
                events: Some(2),
                ..TaskQuery::all("ws-1")
            })
            .unwrap();
        let by_title = |title: &str| tasks.iter().find(|task| task.title == title).unwrap();
        assert_eq!(by_title("third").depends_on, vec!["T-1", "T-2"]);
        assert_eq!(by_title("third").blocked_by, vec!["T-2"]);
        assert_eq!(by_title("second").depends_on, vec!["T-1"]);
        assert!(by_title("second").blocked_by.is_empty());
        assert!(by_title("first").depends_on.is_empty());
        let notes: Vec<&str> = by_title("second")
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|event| event.body.as_str())
            .collect();
        assert_eq!(notes, vec!["b", "c"]);
        let kinds: Vec<&str> = by_title("third")
            .events
            .as_ref()
            .unwrap()
            .iter()
            .map(|event| event.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["created"]);
    }

    #[test]
    fn given_an_unknown_dependency_create_task_names_it_and_creates_nothing() {
        let mut repo = Repo::in_memory();
        create(&mut repo, &actor("ws-1", "t-1"), task("base")).unwrap();
        assert_eq!(
            create(
                &mut repo,
                &actor("ws-1", "t-1"),
                NewTask {
                    title: "next".into(),
                    depends_on: vec!["T-1".into(), "nope".into()],
                    ..NewTask::default()
                }
            ),
            Err(StoreError::Invalid(
                "dependency nope is not a task in this workspace".into()
            ))
        );
        assert_eq!(repo.count("tasks"), 1);
    }

    #[test]
    fn given_a_todo_task_assign_task_starts_it_and_messages_the_assignee() {
        let mut repo = Repo::in_memory();
        let id = create(&mut repo, &actor("ws-1", "t-1"), task("API"))
            .unwrap()
            .id;
        let (task, message) = assign(
            &mut repo,
            &actor("ws-1", "t-1"),
            &Assignment {
                id: &id,
                to: "t-2",
                note: Some("  Use axum. "),
            },
        )
        .unwrap();
        assert_eq!(task.assignee.as_deref(), Some("t-2"));
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!((message.from.as_str(), message.to.as_str()), ("t-1", "t-2"));
        assert_eq!(message.body, "I assigned you T-1: API. Use axum.");

        set_status(&mut repo, &id, TaskStatus::Done);
        assert_eq!(
            assign(
                &mut repo,
                &actor("ws-1", "t-1"),
                &Assignment {
                    id: &id,
                    to: "t-3",
                    note: None
                }
            )
            .unwrap_err(),
            StoreError::Conflict("task T-1 is already done".into())
        );
    }

    #[test]
    fn given_the_message_cannot_be_written_assign_task_leaves_the_task_untouched() {
        let mut repo = Repo::in_memory();
        let id = create(&mut repo, &actor("ws-1", "t-1"), task("API"))
            .unwrap()
            .id;
        let note = "x".repeat(MAX_BODY_BYTES);
        assert!(matches!(
            assign(
                &mut repo,
                &actor("ws-1", "t-1"),
                &Assignment {
                    id: &id,
                    to: "t-2",
                    note: Some(&note)
                }
            ),
            Err(StoreError::Invalid(_))
        ));
        let task = get(&repo, "ws-1", &id).unwrap();
        assert_eq!(task.assignee, None);
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.events.unwrap().len(), 1);
        assert_eq!(repo.count("messages"), 0);
    }

    #[test]
    fn rejects_bad_input() {
        let mut repo = Repo::in_memory();
        assert!(matches!(
            create(&mut repo, &actor("ws-1", "t-1"), task("   ")),
            Err(StoreError::Invalid(_))
        ));
        assert!(create(
            &mut repo,
            &actor("ws-1", "t-1"),
            task(&"x".repeat(MAX_TITLE_CHARS + 1))
        )
        .is_err());
        assert!(messages::send(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &Outgoing {
                to: "all",
                body: &"x".repeat(MAX_BODY_BYTES + 1)
            }
        )
        .is_err());
        assert!(notes::add(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &NoteDraft {
                key: None,
                body: ""
            }
        )
        .is_err());
        create(&mut repo, &actor("ws-1", "t-1"), task("x")).unwrap();
        assert!(update(
            &mut repo,
            &actor("ws-1", "u"),
            TaskUpdate {
                id: "T-1",
                patch: TaskPatch {
                    position: Some(f64::NAN),
                    ..TaskPatch::default()
                }
            }
        )
        .is_err());
    }

    #[test]
    fn claim_needs_a_free_todo_task_with_finished_dependencies() {
        let mut repo = Repo::in_memory();
        let first = create(&mut repo, &actor("ws-1", "t-1"), task("first")).unwrap();
        let second = create(
            &mut repo,
            &actor("ws-1", "t-1"),
            NewTask {
                title: "second".into(),
                depends_on: vec![first.id.clone()],
                ..NewTask::default()
            },
        )
        .unwrap();

        let err = claim(&mut repo, &actor("ws-1", "t-2"), &second.id).unwrap_err();
        assert!(err.to_string().contains("T-1"), "{}", err);

        let claimed = claim(&mut repo, &actor("ws-1", "t-2"), &first.id).unwrap();
        assert_eq!(claimed.assignee.as_deref(), Some("t-2"));
        assert_eq!(claimed.status, TaskStatus::InProgress);
        assert_eq!(
            claimed.events.as_ref().unwrap().last().unwrap().kind,
            "claimed"
        );
        assert_eq!(
            claim(&mut repo, &actor("ws-1", "t-3"), &first.id).unwrap_err(),
            StoreError::Conflict("task T-1 is already claimed by t-2".into())
        );
        assert_eq!(
            claim(&mut repo, &actor("ws-1", "t-2"), &first.id).unwrap_err(),
            StoreError::Conflict("you already hold task T-1".into())
        );

        let third = create(&mut repo, &actor("ws-1", "t-1"), task("third")).unwrap();
        set_status(&mut repo, &third.id, TaskStatus::Blocked);
        assert!(claim(&mut repo, &actor("ws-1", "t-2"), &third.id)
            .unwrap_err()
            .to_string()
            .contains("only `todo`"));

        assert!(matches!(
            complete(
                &mut repo,
                &actor("ws-1", "t-3"),
                &Completion {
                    id: &first.id,
                    summary: "done"
                }
            ),
            Err(StoreError::Conflict(_))
        ));
        let reviewed = complete(
            &mut repo,
            &actor("ws-1", "t-2"),
            &Completion {
                id: &first.id,
                summary: "parser works",
            },
        )
        .unwrap();
        assert_eq!(reviewed.status, TaskStatus::Review);
        let last = reviewed.events.as_ref().unwrap().last().unwrap().clone();
        assert_eq!(
            (last.kind.as_str(), last.body.as_str()),
            ("completed", "parser works")
        );
    }

    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        let repo = Arc::new(Mutex::new(Repo::in_memory()));
        let id = create(
            &mut repo.lock().unwrap(),
            &actor("ws-1", "t-1"),
            task("race"),
        )
        .unwrap()
        .id;
        let agents = 8;
        let barrier = Arc::new(Barrier::new(agents));
        let handles: Vec<_> = (0..agents)
            .map(|n| {
                let repo = Arc::clone(&repo);
                let barrier = Arc::clone(&barrier);
                let id = id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let name = format!("t-{}", n + 10);
                    claim(&mut repo.lock().unwrap(), &actor("ws-1", &name), &id).is_ok()
                })
            })
            .collect();
        let winners = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn claim_is_atomic_across_connections() {
        let dir = std::env::temp_dir().join(format!("terra-mcp-claim-{}", now_millis()));
        let path = dir.join("mcp.db");
        let mut one = Repo::new(super::super::db::open(&path).unwrap());
        let mut two = Repo::new(super::super::db::open(&path).unwrap());
        let id = create(&mut one, &actor("ws-1", "t-1"), task("shared"))
            .unwrap()
            .id;
        assert!(claim(&mut one, &actor("ws-1", "t-1"), &id).is_ok());
        assert_eq!(
            claim(&mut two, &actor("ws-1", "t-2"), &id).unwrap_err(),
            StoreError::Conflict("task T-1 is already claimed by t-1".into())
        );
        drop((one, two));
        let _ = std::fs::remove_dir_all(dir);
    }
}
