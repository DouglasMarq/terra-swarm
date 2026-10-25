use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FontFamily {
    pub name: String,
    pub monospace: bool,
}

fn families_from<'a>(faces: impl Iterator<Item = (&'a str, bool)>) -> Vec<FontFamily> {
    let mut by_name: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for (name, is_monospace) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let entry = by_name
            .entry(name.to_lowercase())
            .or_insert_with(|| (name.to_string(), false));
        entry.1 |= is_monospace;
    }
    by_name
        .into_values()
        .map(|(name, is_monospace)| FontFamily {
            name,
            monospace: is_monospace,
        })
        .collect()
}

#[tauri::command]
pub async fn list_system_fonts() -> Vec<FontFamily> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let faces: Vec<(String, bool)> = db
            .faces()
            .flat_map(|face| {
                face.families
                    .iter()
                    .map(move |(name, _)| (name.clone(), face.monospaced))
            })
            .collect();
        families_from(
            faces
                .iter()
                .map(|(name, is_monospace)| (name.as_str(), *is_monospace)),
        )
    })
    .await
    .unwrap_or_else(|error| {
        eprintln!("failed to list system fonts: {}", error);
        Vec::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_faces_of_one_family_in_mixed_case_when_grouping_then_they_form_one_family() {
        let faces = [
            ("JetBrains Mono", true),
            ("jetbrains mono", true),
            ("Helvetica", false),
            (".SF NS", false),
            ("", false),
        ];
        let families = families_from(faces.into_iter());
        assert_eq!(
            families,
            vec![
                FontFamily {
                    name: "Helvetica".into(),
                    monospace: false
                },
                FontFamily {
                    name: "JetBrains Mono".into(),
                    monospace: true
                },
            ]
        );
    }

    #[test]
    fn given_one_monospace_face_when_grouping_its_family_then_the_family_is_monospace() {
        let families = families_from([("Iosevka", false), ("Iosevka", true)].into_iter());
        assert!(families[0].monospace);
    }
}
