use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter::Adapter;
use rubato::{Fft, FixedSync, Resampler};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Emitter;

const TARGET_SAMPLE_RATE: u32 = 16000;
const RESAMPLE_CHUNK_SIZE: usize = 1024;

/// Wrapper to pass a mono `&[f32]` slice as a single-channel `Adapter` for rubato.
struct MonoSlice<'a>(&'a [f32]);

/// Safety: `MonoSlice` reports a fixed channel count of 1 and a frame count
/// equal to the slice length, both immutable for the lifetime of the buffer.
unsafe impl Adapter<f32> for MonoSlice<'_> {
    unsafe fn read_sample_unchecked(&self, _channel: usize, frame: usize) -> f32 {
        *self.0.get_unchecked(frame)
    }
    fn channels(&self) -> usize {
        1
    }
    fn frames(&self) -> usize {
        self.0.len()
    }
}

/// Emit audio-level events roughly every this many samples (at 16kHz ≈ 20Hz)
const LEVEL_EMIT_INTERVAL: usize = 800;
/// RMS below this threshold is considered silence
const SILENCE_THRESHOLD: f32 = 0.01;
/// Number of consecutive silent checks before triggering (~1.2s at 20Hz)
const SILENCE_FRAME_COUNT: u32 = 24;
/// Minimum checks before silence detection activates (~1s)
const MIN_RECORDING_CHECKS: u32 = 20;

enum Command {
    Start(
        Arc<Mutex<Vec<f32>>>,
        tauri::AppHandle,
        mpsc::Sender<Result<(), String>>,
    ),
    Stop,
    Shutdown,
}

/// True when at least one usable microphone is present.
pub fn has_input_device() -> bool {
    !list_input_devices().is_empty()
}

pub fn list_input_devices() -> Vec<String> {
    suppress_alsa_stderr(|| {
        let host = cpal::default_host();
        let Ok(devices) = host.input_devices() else {
            return Vec::new();
        };
        let mut seen = std::collections::HashSet::new();
        devices
            .filter_map(|d| {
                let name = d.description().ok()?.name().to_string();
                if !is_usable_input(&name, &d) {
                    return None;
                }
                if !seen.insert(name.clone()) {
                    return None;
                }
                Some(name)
            })
            .collect()
    })
}

/// Suppresses ALSA's noisy stderr output during device enumeration on Linux.
/// ALSA prints errors like "unable to open slave" and "Cannot open device /dev/dsp"
/// when probing virtual PCM plugins — these are harmless but spam the terminal.
#[cfg(target_os = "linux")]
fn suppress_alsa_stderr<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    use std::os::unix::io::AsRawFd;

    let saved = unsafe { libc::dup(libc::STDERR_FILENO) };
    if let Ok(devnull) = std::fs::File::open("/dev/null") {
        unsafe {
            libc::dup2(devnull.as_raw_fd(), libc::STDERR_FILENO);
        }
    }

    let result = f();

    if saved >= 0 {
        unsafe {
            libc::dup2(saved, libc::STDERR_FILENO);
            libc::close(saved);
        }
    }

    result
}

#[cfg(not(target_os = "linux"))]
fn suppress_alsa_stderr<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    f()
}

#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn is_usable_input(name: &str, device: &cpal::Device) -> bool {
    #[cfg(target_os = "linux")]
    {
        // ALSA exposes hundreds of virtual PCM plugin entries that are not
        // real microphones. Filter them out by prefix so we never attempt
        // to query their capabilities (some, like `jack`, try to connect to
        // a daemon and hang).
        const VIRTUAL_PREFIXES: &[&str] = &[
            "null",
            "speex",
            "jack",
            "oss",
            "lavrate",
            "samplerate",
            "a52",
            "upmix",
            "vdownmix",
            "dmix",
            "dsnoop",
            "surround",
            "front:",
            "rear:",
            "center_lfe:",
            "side:",
            "hdmi:",
            "iec958:",
            "usbstream",
            "pipewire",
            "pulse",
        ];
        let lower = name.to_lowercase();
        if VIRTUAL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
            return false;
        }
    }
    device.default_input_config().is_ok()
}

/// Thread-safe audio controller that manages mic capture on a dedicated thread
/// (cpal streams are not Send, so the stream must live on one thread).
pub struct AudioController {
    tx: mpsc::Sender<Command>,
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Command>();

        thread::spawn(move || {
            let mut active_stream: Option<cpal::Stream> = None;

            for cmd in rx {
                match cmd {
                    Command::Start(buffer, app, reply) => {
                        drop(active_stream.take());

                        let stream = match build_stream(buffer, app) {
                            Ok(s) => s,
                            Err(e) => {
                                let _ = reply.send(Err(e));
                                continue;
                            }
                        };
                        match stream.play() {
                            Ok(()) => {
                                active_stream = Some(stream);
                                let _ = reply.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = reply.send(Err(format!("Failed to start audio stream: {e}")));
                            }
                        }
                    }
                    Command::Stop => {
                        drop(active_stream.take());
                    }
                    Command::Shutdown => break,
                }
            }
        });

        Self { tx }
    }

    pub fn start(
        &self,
        audio_buffer: Arc<Mutex<Vec<f32>>>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(Command::Start(audio_buffer, app, reply_tx))
            .map_err(|e| format!("Audio thread not available: {e}"))?;
        reply_rx
            .recv()
            .map_err(|_| "Audio thread stopped unexpectedly".to_string())?
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(Command::Stop)
            .map_err(|e| format!("Audio thread not available: {e}"))
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

#[derive(Clone)]
struct StreamContext {
    channels: usize,
    resampler: Option<Arc<Mutex<Fft<f32>>>>,
    resample_pending: Arc<Mutex<Vec<f32>>>,
    buffer: Arc<Mutex<Vec<f32>>>,
    sample_counter: Arc<Mutex<usize>>,
    silence_counter: Arc<Mutex<u32>>,
    total_checks: Arc<Mutex<u32>>,
    app: tauri::AppHandle,
}

fn build_stream(buffer: Arc<Mutex<Vec<f32>>>, app: tauri::AppHandle) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found. Please connect a microphone and try again.")?;

    let config = device
        .default_input_config()
        .map_err(|_| "Microphone is not available. Please check your audio input settings.".to_string())?;

    let source_sample_rate = config.sample_rate();
    let source_channels = config.channels() as usize;

    let needs_resample = source_sample_rate != TARGET_SAMPLE_RATE;

    let resampler: Option<Arc<Mutex<Fft<f32>>>> = match needs_resample {
        true => {
            let r = Fft::new(
                source_sample_rate as usize,
                TARGET_SAMPLE_RATE as usize,
                RESAMPLE_CHUNK_SIZE,
                1,
                FixedSync::Input,
            )
            .map_err(|e| format!("Failed to create resampler: {e}"))?;
            Some(Arc::new(Mutex::new(r)))
        }
        false => None,
    };

    let ctx = StreamContext {
        channels: source_channels,
        resampler,
        resample_pending: Arc::new(Mutex::new(Vec::new())),
        buffer,
        sample_counter: Arc::new(Mutex::new(0usize)),
        silence_counter: Arc::new(Mutex::new(0u32)),
        total_checks: Arc::new(Mutex::new(0u32)),
        app,
    };
    let err_fn = |err| eprintln!("Audio stream error: {err}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let ctx = ctx.clone();
            device
                .build_input_stream(
                    config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        process_audio(data, &ctx);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build input stream: {e}"))?
        }
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> =
                        data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        format => return Err(format!("Unsupported sample format: {format:?}")),
    };

    Ok(stream)
}

/// Downmix interleaved multi-channel audio to mono by averaging each frame.
fn mono_downmix(data: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Compute the RMS (root mean square) of an audio sample buffer.
fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn process_audio(data: &[f32], ctx: &StreamContext) {
    let mono = mono_downmix(data, ctx.channels);

    let Some(resampler_arc) = &ctx.resampler else {
        emit_audio_level(&mono, ctx);
        if let Ok(mut buf) = ctx.buffer.lock() {
            buf.extend_from_slice(&mono);
        }
        return;
    };

    let Ok(mut pending) = ctx.resample_pending.lock() else {
        return;
    };
    pending.extend_from_slice(&mono);

    let mut resampler = resampler_arc.lock().unwrap();
    while pending.len() >= RESAMPLE_CHUNK_SIZE {
        let chunk: Vec<f32> = pending.drain(..RESAMPLE_CHUNK_SIZE).collect();
        let input = MonoSlice(&chunk);
        match resampler.process(&input, None) {
            Ok(output) => {
                let samples: Vec<f32> = (0..output.frames())
                    .map(|i| output.read_sample(0, i).unwrap_or(0.0))
                    .collect();
                emit_audio_level(&samples, ctx);
                if let Ok(mut buf) = ctx.buffer.lock() {
                    buf.extend_from_slice(&samples);
                }
            }
            Err(e) => {
                eprintln!("Resampling error: {e}");
                return;
            }
        }
    }
}

fn emit_audio_level(samples: &[f32], ctx: &StreamContext) {
    let Ok(mut counter) = ctx.sample_counter.lock() else {
        return;
    };
    *counter += samples.len();
    if *counter < LEVEL_EMIT_INTERVAL {
        return;
    }
    *counter = 0;
    let rms = compute_rms(samples);
    let _ = ctx.app.emit("voice-audio-level", rms);

    check_silence(rms, ctx);
}

fn check_silence(rms: f32, ctx: &StreamContext) {
    let Ok(mut tc) = ctx.total_checks.lock() else {
        return;
    };
    let Ok(mut sc) = ctx.silence_counter.lock() else {
        return;
    };
    *tc += 1;
    *sc = match rms < SILENCE_THRESHOLD {
        true => *sc + 1,
        false => 0,
    };
    if *tc <= MIN_RECORDING_CHECKS || *sc < SILENCE_FRAME_COUNT {
        return;
    }
    let _ = ctx.app.emit("voice-silence-detected", ());
    *sc = 0;
}
