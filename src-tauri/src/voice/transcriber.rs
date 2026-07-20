use std::path::Path;
use std::sync::Mutex;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

pub struct Transcriber {
    ctx: WhisperContext,
    state: Mutex<Option<WhisperState>>,
    use_gpu: bool,
}

impl Transcriber {
    pub fn new(model_path: &Path, use_gpu: bool) -> Result<Self, String> {
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.use_gpu(use_gpu);
        ctx_params.flash_attn(true);

        let ctx = WhisperContext::new_with_params(
            model_path.to_str().ok_or("Invalid model path encoding")?,
            ctx_params,
        )
        .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

        let state = ctx
            .create_state()
            .map_err(|e| format!("Failed to create whisper state: {e}"))?;

        Ok(Self {
            ctx,
            state: Mutex::new(Some(state)),
            use_gpu,
        })
    }

    pub fn transcribe(&self, audio: &[f32], language: &str) -> Result<String, String> {
        if audio.is_empty() {
            return Ok(String::new());
        }

        let audio = trim_trailing_silence(audio);

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let lang = match language {
            "auto" => None,
            code => Some(code),
        };
        params.set_language(lang);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_single_segment(true);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_temperature_inc(0.0);
        params.set_max_tokens(128);

        params.set_audio_ctx(compute_audio_ctx(audio.len()));

        // GPU handles heavy compute — use all logical cores for pre/post processing
        // CPU-only: physical cores only (hyperthreads hurt whisper)
        let threads = std::thread::available_parallelism()
            .map(|n| match self.use_gpu {
                true => n.get() as i32,
                false => ((n.get() as i32) / 2).max(1),
            })
            .unwrap_or(4);
        params.set_n_threads(threads);

        let mut guard = self
            .state
            .lock()
            .map_err(|e| format!("State lock poisoned: {e}"))?;

        let mut state = match guard.take() {
            Some(s) => s,
            None => self
                .ctx
                .create_state()
                .map_err(|e| format!("Failed to recreate whisper state: {e}"))?,
        };

        let result = state.full(params, audio);

        if let Err(e) = result {
            *guard = None;
            return Err(format!("Transcription failed: {e}"));
        }

        let num_segments = state.full_n_segments();
        let mut text = String::new();

        for i in 0..num_segments {
            let Some(segment) = state.get_segment(i) else {
                continue;
            };
            let Ok(s) = segment.to_str() else { continue };
            text.push_str(s);
        }

        // Return state for reuse
        *guard = Some(state);

        Ok(text.trim().to_string())
    }
}

/// Compute the audio_ctx parameter for Whisper based on number of 16kHz samples.
/// Formula from whisper.cpp issue #1855: (duration/30)*1500 + padding.
/// Minimum 768, maximum 1500, always a multiple of 64.
fn compute_audio_ctx(num_samples: usize) -> i32 {
    let duration_secs = num_samples as f32 / 16000.0;
    let raw_ctx = (duration_secs / 30.0 * 1500.0 + 256.0).ceil() as i32;
    ((raw_ctx + 63) / 64 * 64).clamp(768, 1500)
}

/// Trim trailing silence from audio. Works backwards in 100ms chunks.
fn trim_trailing_silence(audio: &[f32]) -> &[f32] {
    const CHUNK: usize = 1600; // 100ms at 16kHz
    const THRESHOLD: f32 = 0.01;
    const MIN_SAMPLES: usize = 4800; // keep at least 300ms

    let mut end = audio.len();

    while end > MIN_SAMPLES {
        let start = end.saturating_sub(CHUNK);
        let chunk = &audio[start..end];
        let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
        if rms >= THRESHOLD {
            break;
        }
        end = start;
    }

    // Keep 100ms padding after last non-silent chunk
    let padded = (end + CHUNK).min(audio.len());
    &audio[..padded]
}
