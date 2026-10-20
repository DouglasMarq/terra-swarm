//! System font listing for the terminal font picker. The webview has no API
//! to enumerate installed fonts, so the backend scans the system font
//! directories once and reports every family, flagging monospaced ones.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FontFamily {
    pub name: String,
    /// True when any face of the family is fixed-pitch.
    pub monospace: bool,
}

/// Groups faces into families, skipping hidden system families (".SF…").
fn families_from<'a>(faces: impl Iterator<Item = (&'a str, bool)>) -> Vec<FontFamily> {
    let mut by_name: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for (name, monospace) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let entry = by_name
            .entry(name.to_lowercase())
            .or_insert_with(|| (name.to_string(), false));
        entry.1 |= monospace;
    }
    by_name
        .into_values()
        .map(|(name, monospace)| FontFamily { name, monospace })
        .collect()
}

#[tauri::command]
pub async fn list_system_fonts() -> Vec<FontFamily> {
    // Scanning reads every font file header; keep it off the main thread.
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
        families_from(faces.iter().map(|(name, mono)| (name.as_str(), *mono)))
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_faces_by_family_case_insensitively() {
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
    fn a_family_is_monospace_when_any_face_is() {
        let families = families_from([("Iosevka", false), ("Iosevka", true)].into_iter());
        assert!(families[0].monospace);
    }
}
