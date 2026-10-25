use super::model::{
    clamp_limit, clean_body, Actor, Note, StoreError, StoreResult, DEFAULT_SEARCH_LIMIT,
    MAX_NOTE_KEY_CHARS,
};
use super::repo::{NoteRecord, Queries};
use crate::clock::now_millis;

pub struct NoteDraft<'a> {
    pub key: Option<&'a str>,
    pub body: &'a str,
}

pub struct NoteSearch<'a> {
    pub query: &'a str,
    pub limit: Option<usize>,
}

pub fn add(queries: Queries<'_>, author: &Actor<'_>, draft: &NoteDraft<'_>) -> StoreResult<Note> {
    let body = clean_body(draft.body, "note", false)?;
    let key = draft.key.map(str::trim).filter(|key| !key.is_empty());
    if key.is_some_and(|key| key.chars().count() > MAX_NOTE_KEY_CHARS) {
        return Err(StoreError::Invalid(format!(
            "note key is longer than {} characters",
            MAX_NOTE_KEY_CHARS
        )));
    }
    queries.upsert_note(&NoteRecord {
        workspace_id: author.workspace_id,
        key,
        body: &body,
        author: author.name,
        at: now_millis(),
    })
}

pub fn search(
    queries: Queries<'_>,
    workspace_id: &str,
    search: &NoteSearch<'_>,
) -> StoreResult<Vec<Note>> {
    let limit = clamp_limit(search.limit, DEFAULT_SEARCH_LIMIT);
    queries.search_notes(workspace_id, search.query, limit)
}

#[cfg(test)]
mod tests {
    use super::super::repo::Repo;
    use super::super::test_support::actor;
    use super::*;

    #[test]
    fn given_keyed_notes_when_writing_and_searching_then_they_upsert_and_match_full_text() {
        let repo = Repo::in_memory();
        let first = add(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &NoteDraft {
                key: Some("test-command"),
                body: "npm test",
            },
        )
        .unwrap();
        let second = add(
            repo.queries(),
            &actor("ws-1", "t-2"),
            &NoteDraft {
                key: Some("test-command"),
                body: "npm run test:unit",
            },
        )
        .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.author, "t-2");
        assert_eq!(second.created_at, first.created_at);
        add(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &NoteDraft {
                key: None,
                body: "A API devolve JSON em snake_case",
            },
        )
        .unwrap();
        add(
            repo.queries(),
            &actor("ws-1", "t-1"),
            &NoteDraft {
                key: None,
                body: "Configuração do banco: migrações em db.rs",
            },
        )
        .unwrap();
        add(
            repo.queries(),
            &actor("ws-2", "t-9"),
            &NoteDraft {
                key: None,
                body: "npm elsewhere",
            },
        )
        .unwrap();

        let hits = search(
            repo.queries(),
            "ws-1",
            &NoteSearch {
                query: "NPM unit",
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].body, "npm run test:unit");
        assert_eq!(
            search(
                repo.queries(),
                "ws-1",
                &NoteSearch {
                    query: "configuracao migr",
                    limit: None
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            search(
                repo.queries(),
                "ws-1",
                &NoteSearch {
                    query: "test-command",
                    limit: None
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert!(search(
            repo.queries(),
            "ws-1",
            &NoteSearch {
                query: "\"unbalanced AND (",
                limit: None
            }
        )
        .is_ok());
        assert_eq!(
            search(
                repo.queries(),
                "ws-1",
                &NoteSearch {
                    query: "",
                    limit: None
                }
            )
            .unwrap()
            .len(),
            3
        );
        assert_eq!(
            search(
                repo.queries(),
                "ws-1",
                &NoteSearch {
                    query: "",
                    limit: Some(1)
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert!(search(
            repo.queries(),
            "ws-1",
            &NoteSearch {
                query: "elsewhere",
                limit: None
            }
        )
        .unwrap()
        .is_empty());
    }
}
