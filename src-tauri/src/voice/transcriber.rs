use super::audio::{compute_rms, TARGET_SAMPLE_RATE};
use crate::sync::LockExt;
use std::path::Path;
use std::sync::Mutex;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

const MAX_TOKENS: i32 = 128;
const FALLBACK_THREAD_COUNT: i32 = 4;
const WINDOW_SECONDS: f32 = 30.0;
const MAX_AUDIO_CTX: i32 = 1500;
const MIN_AUDIO_CTX: i32 = 768;
const AUDIO_CTX_PADDING: f32 = 256.0;
const AUDIO_CTX_STEP: i32 = 64;
const MILLIS_PER_SECOND: u32 = 1000;
const TRIM_CHUNK_SAMPLES: usize = samples_in_millis(100);
const MIN_KEPT_SAMPLES: usize = samples_in_millis(300);
const SILENCE_THRESHOLD: f32 = 0.01;

pub struct Transcriber {
    ctx: WhisperContext,
    state: Mutex<Option<WhisperState>>,
    should_use_gpu: bool,
}

impl Transcriber {
    pub fn new(model_path: &Path, should_use_gpu: bool) -> Result<Self, String> {
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.use_gpu(should_use_gpu);
        ctx_params.flash_attn(true);

        let ctx = WhisperContext::new_with_params(
            model_path.to_str().ok_or("Invalid model path encoding")?,
            ctx_params,
        )
        .map_err(|error| format!("Failed to load Whisper model: {error}"))?;

        let state = ctx
            .create_state()
            .map_err(|error| format!("Failed to create whisper state: {error}"))?;

        Ok(Self {
            ctx,
            state: Mutex::new(Some(state)),
            should_use_gpu,
        })
    }

    pub fn transcribe(&self, audio: &[f32], language: &str) -> Result<String, String> {
        if audio.is_empty() {
            return Ok(String::new());
        }

        let audio = trim_trailing_silence(audio);
        let params = decoding_params(language, audio.len(), thread_count(self.should_use_gpu));

        let mut guard = self.state.lock_or_recover();

        let mut state = match guard.take() {
            Some(state) => state,
            None => self
                .ctx
                .create_state()
                .map_err(|error| format!("Failed to recreate whisper state: {error}"))?,
        };

        let result = state.full(params, audio);

        if let Err(error) = result {
            *guard = None;
            return Err(format!("Transcription failed: {error}"));
        }

        let text = segments_text(&state);

        *guard = Some(state);

        Ok(text.trim().to_string())
    }
}

fn decoding_params(language: &str, sample_count: usize, threads: i32) -> FullParams<'_, 'static> {
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
    params.set_max_tokens(MAX_TOKENS);
    params.set_audio_ctx(compute_audio_ctx(sample_count));
    params.set_n_threads(threads);
    params
}

fn thread_count(should_use_gpu: bool) -> i32 {
    std::thread::available_parallelism()
        .ok()
        .and_then(|cores| i32::try_from(cores.get()).ok())
        .map(|cores| match should_use_gpu {
            true => cores,
            false => (cores / 2).max(1),
        })
        .unwrap_or(FALLBACK_THREAD_COUNT)
}

fn segments_text(state: &WhisperState) -> String {
    let mut text = String::new();

    for segment_index in 0..state.full_n_segments() {
        let Some(segment) = state.get_segment(segment_index) else {
            continue;
        };
        let Ok(segment_text) = segment.to_str() else {
            continue;
        };
        text.push_str(segment_text);
    }

    text
}

// The frame count is clamped below, so f32 precision and the saturating
// float-to-int `as` are exact enough for it.
#[allow(clippy::cast_possible_truncation)]
fn compute_audio_ctx(num_samples: usize) -> i32 {
    let duration_secs = num_samples as f32 / TARGET_SAMPLE_RATE as f32;
    let raw_ctx =
        (duration_secs / WINDOW_SECONDS * MAX_AUDIO_CTX as f32 + AUDIO_CTX_PADDING).ceil() as i32;
    ((raw_ctx + AUDIO_CTX_STEP - 1) / AUDIO_CTX_STEP * AUDIO_CTX_STEP)
        .clamp(MIN_AUDIO_CTX, MAX_AUDIO_CTX)
}

const fn samples_in_millis(millis: u32) -> usize {
    // A 16 kHz sample count of a few hundred milliseconds fits any usize.
    (TARGET_SAMPLE_RATE / MILLIS_PER_SECOND * millis) as usize
}

fn trim_trailing_silence(audio: &[f32]) -> &[f32] {
    let mut end = audio.len();

    while end > MIN_KEPT_SAMPLES {
        let start = end.saturating_sub(TRIM_CHUNK_SAMPLES);
        if compute_rms(&audio[start..end]) >= SILENCE_THRESHOLD {
            break;
        }
        end = start;
    }

    let padded = (end + TRIM_CHUNK_SAMPLES).min(audio.len());
    &audio[..padded]
}

#[cfg(test)]
mod tests {
    use super::{compute_audio_ctx, thread_count, trim_trailing_silence};

    #[test]
    fn given_a_cpu_or_a_gpu_when_counting_threads_then_the_cpu_uses_at_least_one_and_no_more_than_the_gpu(
    ) {
        let gpu_threads = thread_count(true);
        let cpu_threads = thread_count(false);

        assert!(cpu_threads >= 1);
        assert!(cpu_threads <= gpu_threads);
    }

    #[test]
    fn given_audio_of_various_lengths_when_computing_the_audio_context_then_it_scales_within_bounds(
    ) {
        assert_eq!(compute_audio_ctx(0), 768);
        assert_eq!(compute_audio_ctx(16_000 * 30), 1500);
        assert_eq!(compute_audio_ctx(16_000 * 120), 1500);
        let mid = compute_audio_ctx(16_000 * 15);
        assert!(mid > 768 && mid < 1500);
        assert_eq!(mid % 64, 0);
    }

    #[test]
    fn given_trailing_silence_when_trimming_then_it_is_cut_leaving_padding() {
        let mut audio = vec![0.5f32; 16_000];
        audio.extend(vec![0.0f32; 16_000]);
        let trimmed = trim_trailing_silence(&audio);
        assert_eq!(trimmed.len(), 16_000 + 1600);
    }

    #[test]
    fn given_short_or_quiet_audio_when_trimming_then_it_keeps_its_minimum() {
        let quiet = vec![0.0f32; 16_000];
        assert_eq!(trim_trailing_silence(&quiet).len(), 4800 + 1600);
        let tiny = vec![0.0f32; 1000];
        assert_eq!(trim_trailing_silence(&tiny).len(), 1000);
    }
}
