use super::model::{
    clamp_limit, clean_body, Actor, Message, StoreError, StoreResult, DEFAULT_INBOX_LIMIT,
};
use super::repo::{InboxQuery, MessageRecord, Queries, Repo};
use crate::clock::now_millis;

pub struct Outgoing<'a> {
    pub to: &'a str,
    pub body: &'a str,
}

pub struct InboxRequest {
    pub unread_only: bool,
    pub limit: Option<usize>,
}

pub fn send(
    queries: Queries<'_>,
    actor: &Actor<'_>,
    outgoing: &Outgoing<'_>,
) -> StoreResult<Message> {
    let body = clean_body(outgoing.body, "message", false)?;
    let to = outgoing.to.trim();
    if to.is_empty() {
        return Err(StoreError::Invalid("recipient cannot be empty".into()));
    }
    queries.insert_message(&MessageRecord {
        workspace_id: actor.workspace_id,
        from: actor.name,
        to,
        body: &body,
        at: now_millis(),
    })
}

pub fn read_inbox(
    repo: &mut Repo,
    reader: &Actor<'_>,
    request: &InboxRequest,
) -> StoreResult<Vec<Message>> {
    let query = InboxQuery {
        workspace_id: reader.workspace_id,
        reader: reader.name,
        unread_only: request.unread_only,
        limit: clamp_limit(request.limit, DEFAULT_INBOX_LIMIT),
    };
    let tx = repo.transaction()?;
    let queries = tx.queries();
    let mut messages = queries.inbox(&query)?;
    queries.mark_read(reader.name, &messages)?;
    queries.attach_readers(&mut messages)?;
    tx.commit()?;
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::super::model::{NewTask, TaskPatch, MAX_LIMIT, TASK_EVENTS_SHOWN};
    use super::super::tasks::{self, TaskUpdate};
    use super::super::test_support::actor;
    use super::*;

    fn task(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..NewTask::default()
        }
    }

    #[test]
    fn inbox_separates_direct_and_broadcast_and_marks_read() {
        let mut repo = Repo::in_memory();
        send(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &Outgoing {
                to: "t-2",
                body: "hi two",
            },
        )
        .unwrap();
        send(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &Outgoing {
                to: "all",
                body: "hi all",
            },
        )
        .unwrap();
        send(
            repo.queries(),
            &actor("ws-1", "t-2"),
            &Outgoing {
                to: "all",
                body: "mine",
            },
        )
        .unwrap();
        send(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &Outgoing {
                to: "t-3",
                body: "not for two",
            },
        )
        .unwrap();
        send(
            repo.queries(),
            &actor("ws-2", "t-8"),
            &Outgoing {
                to: "all",
                body: "other project",
            },
        )
        .unwrap();

        assert_eq!(repo.queries().unread_count("ws-1", "t-2").unwrap(), 2);
        let inbox = read_inbox(
            &mut repo,
            &actor("ws-1", "t-2"),
            &InboxRequest {
                unread_only: true,
                limit: None,
            },
        )
        .unwrap();
        let bodies: Vec<&str> = inbox.iter().map(|m| m.body.as_str()).collect();
        assert_eq!(bodies, vec!["hi two", "hi all"]);
        assert!(inbox.iter().all(|m| m.read_by.contains(&"t-2".to_string())));
        assert!(read_inbox(
            &mut repo,
            &actor("ws-1", "t-2"),
            &InboxRequest {
                unread_only: true,
                limit: None
            }
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            read_inbox(
                &mut repo,
                &actor("ws-1", "t-2"),
                &InboxRequest {
                    unread_only: false,
                    limit: None
                }
            )
            .unwrap()
            .len(),
            2
        );
        assert_eq!(repo.queries().unread_count("ws-1", "t-3").unwrap(), 3);
        assert_eq!(
            read_inbox(
                &mut repo,
                &actor("ws-1", "t-3"),
                &InboxRequest {
                    unread_only: true,
                    limit: Some(1)
                }
            )
            .unwrap()[0]
                .body,
            "hi all"
        );
        assert_eq!(repo.queries().unread_count("ws-1", "t-3").unwrap(), 2);
    }

    #[test]
    fn history_is_kept_in_full() {
        let mut repo = Repo::in_memory();
        for n in 0..700 {
            send(
                repo.queries(),
                &actor("ws-1", "t-1"),
                &Outgoing {
                    to: "all",
                    body: &format!("m{}", n),
                },
            )
            .unwrap();
        }
        assert_eq!(repo.count("messages"), 700);
        assert_eq!(
            read_inbox(
                &mut repo,
                &actor("ws-1", "t-2"),
                &InboxRequest {
                    unread_only: true,
                    limit: Some(MAX_LIMIT + 50)
                }
            )
            .unwrap()
            .len(),
            MAX_LIMIT
        );
        assert_eq!(
            read_inbox(
                &mut repo,
                &actor("ws-1", "t-2"),
                &InboxRequest {
                    unread_only: true,
                    limit: None
                }
            )
            .unwrap()[0]
                .body,
            format!("m{}", MAX_LIMIT)
        );
        let id = tasks::create(&mut repo, &actor("ws-1", "t-1"), task("log"))
            .unwrap()
            .id;
        for n in 0..150 {
            tasks::update(
                &mut repo,
                &actor("ws-1", "t-1"),
                TaskUpdate {
                    id: &id,
                    patch: TaskPatch {
                        note: Some(format!("step {}", n)),
                        ..TaskPatch::default()
                    },
                },
            )
            .unwrap();
        }
        assert_eq!(repo.count("task_events"), 151);
        let shown = tasks::get(&repo, "ws-1", &id).unwrap().events.unwrap();
        assert_eq!(shown.len(), TASK_EVENTS_SHOWN);
        assert_eq!(shown.last().unwrap().body, "step 149");
    }
}
