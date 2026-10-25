use std::path::{Path, PathBuf};

const MODEL_REPOSITORY_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp";
const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

pub struct VoiceModel {
    pub id: &'static str,
    pub filename: &'static str,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub size_label: &'static str,
    pub description: &'static str,
    pub sha256: &'static str,
}

impl VoiceModel {
    pub fn url(&self) -> String {
        format!(
            "{MODEL_REPOSITORY_URL}/resolve/{MODEL_REVISION}/{}",
            self.filename
        )
    }
}

pub fn available_models() -> Vec<VoiceModel> {
    vec![
        VoiceModel {
            id: "tiny",
            filename: "ggml-tiny.bin",
            display_name: "Tiny",
            size_bytes: 77_691_713,
            size_label: "75 MB",
            description: "Fastest, basic accuracy",
            sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        },
        VoiceModel {
            id: "base",
            filename: "ggml-base.bin",
            display_name: "Base",
            size_bytes: 147_951_465,
            size_label: "142 MB",
            description: "Good balance of speed and accuracy",
            sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        },
        VoiceModel {
            id: "small-q5_1",
            filename: "ggml-small-q5_1.bin",
            display_name: "Small Q5",
            size_bytes: 190_085_487,
            size_label: "181 MB",
            description: "Recommended — quantized for fast inference with near-identical accuracy",
            sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        },
        VoiceModel {
            id: "small",
            filename: "ggml-small.bin",
            display_name: "Small",
            size_bytes: 487_601_967,
            size_label: "466 MB",
            description: "Excellent accuracy, larger download",
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        },
        VoiceModel {
            id: "medium",
            filename: "ggml-medium.bin",
            display_name: "Medium",
            size_bytes: 1_533_763_059,
            size_label: "1.5 GB",
            description: "High accuracy, needs more RAM and CPU time",
            sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        },
        VoiceModel {
            id: "large-v3-turbo",
            filename: "ggml-large-v3-turbo.bin",
            display_name: "Large V3 Turbo",
            size_bytes: 1_624_555_275,
            size_label: "1.5 GB",
            description: "Best accuracy with optimized speed, heavy",
            sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        },
        VoiceModel {
            id: "large-v3",
            filename: "ggml-large-v3.bin",
            display_name: "Large V3",
            size_bytes: 3_095_033_483,
            size_label: "2.9 GB",
            description: "Best multilingual accuracy, very heavy",
            sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
        },
    ]
}

pub fn find_model(id: &str) -> Option<VoiceModel> {
    available_models().into_iter().find(|model| model.id == id)
}

pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

pub fn model_path(data_dir: &Path, id: &str) -> Option<PathBuf> {
    let model = find_model(id)?;
    let path = models_dir(data_dir).join(model.filename);
    path.exists().then_some(path)
}

pub fn downloaded_model_ids(data_dir: &Path) -> Vec<String> {
    available_models()
        .iter()
        .filter(|model| models_dir(data_dir).join(model.filename).exists())
        .map(|model| model.id.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_the_model_catalog_when_inspecting_it_then_ids_are_unique_and_files_match() {
        let models = available_models();
        let mut ids: Vec<&str> = models.iter().map(|model| model.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), models.len());
        for model in &models {
            assert!(model.url().ends_with(model.filename), "{}", model.id);
            assert!(model.size_bytes > 0, "{}", model.id);
        }
        assert_eq!(
            find_model("base").map(|model| model.filename),
            Some("ggml-base.bin")
        );
        assert!(find_model("nope").is_none());
    }

    #[test]
    fn given_the_catalog_when_reading_each_model_then_it_is_pinned_to_a_revision_and_a_sha256() {
        for model in available_models() {
            assert!(
                model.url().contains(&format!("/resolve/{MODEL_REVISION}/")),
                "{}",
                model.id
            );
            assert_eq!(model.sha256.len(), 64, "{}", model.id);
            assert!(
                model
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "{}",
                model.id
            );
        }
    }

    #[test]
    fn given_model_files_when_checking_downloads_then_only_present_files_count() {
        let dir = std::env::temp_dir().join(format!("terra-voice-models-{}", std::process::id()));
        std::fs::create_dir_all(models_dir(&dir)).unwrap();
        assert!(downloaded_model_ids(&dir).is_empty());
        assert!(model_path(&dir, "tiny").is_none());
        std::fs::write(models_dir(&dir).join("ggml-tiny.bin"), b"x").unwrap();
        assert_eq!(downloaded_model_ids(&dir), vec!["tiny".to_string()]);
        assert_eq!(
            model_path(&dir, "tiny"),
            Some(models_dir(&dir).join("ggml-tiny.bin"))
        );
        assert!(model_path(&dir, "unknown").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
