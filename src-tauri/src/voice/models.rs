use std::path::{Path, PathBuf};

pub struct VoiceModel {
    pub id: &'static str,
    pub filename: &'static str,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub size_label: &'static str,
    pub description: &'static str,
    pub url: &'static str,
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
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        },
        VoiceModel {
            id: "base",
            filename: "ggml-base.bin",
            display_name: "Base",
            size_bytes: 147_951_465,
            size_label: "142 MB",
            description: "Good balance of speed and accuracy",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        },
        VoiceModel {
            id: "small-q5_1",
            filename: "ggml-small-q5_1.bin",
            display_name: "Small Q5",
            size_bytes: 190_000_000,
            size_label: "181 MB",
            description: "Recommended — quantized for fast inference with near-identical accuracy",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        },
        VoiceModel {
            id: "small",
            filename: "ggml-small.bin",
            display_name: "Small",
            size_bytes: 487_601_967,
            size_label: "466 MB",
            description: "Excellent accuracy, larger download",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        },
        VoiceModel {
            id: "medium",
            filename: "ggml-medium.bin",
            display_name: "Medium",
            size_bytes: 1_533_774_781,
            size_label: "1.5 GB",
            description: "High accuracy, needs more RAM and CPU time",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        },
        VoiceModel {
            id: "large-v3-turbo",
            filename: "ggml-large-v3-turbo.bin",
            display_name: "Large V3 Turbo",
            size_bytes: 1_649_885_547,
            size_label: "1.5 GB",
            description: "Best accuracy with optimized speed, heavy",
            url:
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        },
        VoiceModel {
            id: "large-v3",
            filename: "ggml-large-v3.bin",
            display_name: "Large V3",
            size_bytes: 3_095_033_483,
            size_label: "2.9 GB",
            description: "Best multilingual accuracy, very heavy",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        },
    ]
}

pub fn find_model(id: &str) -> Option<VoiceModel> {
    available_models().into_iter().find(|m| m.id == id)
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
        .filter(|m| models_dir(data_dir).join(m.filename).exists())
        .map(|m| m.id.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_has_unique_ids_and_matching_files() {
        let models = available_models();
        let mut ids: Vec<&str> = models.iter().map(|model| model.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), models.len());
        for model in &models {
            assert!(model.url.ends_with(model.filename), "{}", model.id);
            assert!(model.size_bytes > 0, "{}", model.id);
        }
        assert_eq!(
            find_model("base").map(|model| model.filename),
            Some("ggml-base.bin")
        );
        assert!(find_model("nope").is_none());
    }

    #[test]
    fn only_present_files_count_as_downloaded() {
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
