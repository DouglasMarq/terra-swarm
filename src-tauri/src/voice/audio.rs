use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter::Adapter;
use rubato::{Fft, FixedSync, Resampler};
use std::collections::VecDeque;
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
        Option<String>,
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
                    Command::Start(buffer, app, device_name, reply) => {
                        drop(active_stream.take());

                        let stream = match build_stream(buffer, app, device_name) {
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
        device_name: Option<String>,
    ) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(Command::Start(audio_buffer, app, device_name, reply_tx))
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

/// Resolve the requested input device by name, falling back to the system
/// default when no name was given or the named device is no longer present
/// (e.g. it was unplugged since the user selected it).
fn resolve_input_device(host: &cpal::Host, device_name: &Option<String>) -> Option<cpal::Device> {
    if let Some(name) = device_name {
        let found = suppress_alsa_stderr(|| {
            host.input_devices().ok()?.find(|d| {
                d.description()
                    .ok()
                    .map(|desc| desc.name() == name.as_str())
                    .unwrap_or(false)
            })
        });
        if found.is_some() {
            return found;
        }
    }
    host.default_input_device()
}

fn build_stream(
    buffer: Arc<Mutex<Vec<f32>>>,
    app: tauri::AppHandle,
    device_name: Option<String>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = resolve_input_device(&host, &device_name)
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
        cpal::SampleFormat::I8 => device
            .build_input_stream(
                config.into(),
                move |data: &[i8], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(i8_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        cpal::SampleFormat::U8 => device
            .build_input_stream(
                config.into(),
                move |data: &[u8], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(u8_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                config.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(i16_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                config.into(),
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(u16_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        // 24-bit USB interfaces (Focusrite & co.) natively report I24/U24.
        // cpal hands these over as dasp I24/U24 (right-justified in a 32-bit
        // container), so the 24-bit full-scale helpers apply — not the I32 one.
        cpal::SampleFormat::I24 => device
            .build_input_stream(
                config.into(),
                move |data: &[cpal::I24], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(i24_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        cpal::SampleFormat::U24 => device
            .build_input_stream(
                config.into(),
                move |data: &[cpal::U24], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(u24_to_f32).collect();
                    process_audio(&float_data, &ctx);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {e}"))?,
        // Several ALSA HDA codecs (e.g. Realtek ALC897) only expose their raw
        // hardware PCM as S32 — PulseAudio/PipeWire normally hide this behind
        // format conversion, but selecting the hw device directly bypasses
        // that, so it must be handled here too.
        cpal::SampleFormat::I32 => device
            .build_input_stream(
                config.into(),
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    let float_data: Vec<f32> = data.iter().map(i32_to_f32).collect();
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

/// 24-bit full scale (2^23 - 1). cpal delivers I24 samples as dasp `I24`:
/// the value right-justified in an i32 container, range -(2^23)..=(2^23-1)
/// — NOT shifted into the high bits. Using the i32::MAX scaling here would
/// attenuate the signal by 256x.
const I24_FULL_SCALE: f32 = 8_388_607.0;
/// 24-bit unsigned midpoint ((2^24 - 1) / 2). dasp `U24` is also an i32
/// container, range 0..=(2^24-1) with equilibrium at 2^23.
const U24_MIDPOINT: f32 = 8_388_607.5;

fn i8_to_f32(s: &i8) -> f32 {
    *s as f32 / i8::MAX as f32
}

fn u8_to_f32(s: &u8) -> f32 {
    (*s as f32 - u8::MAX as f32 / 2.0) / (u8::MAX as f32 / 2.0)
}

fn i16_to_f32(s: &i16) -> f32 {
    *s as f32 / i16::MAX as f32
}

fn u16_to_f32(s: &u16) -> f32 {
    (*s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)
}

fn i24_to_f32(s: &cpal::I24) -> f32 {
    s.inner() as f32 / I24_FULL_SCALE
}

fn u24_to_f32(s: &cpal::U24) -> f32 {
    (s.inner() as f32 - U24_MIDPOINT) / U24_MIDPOINT
}

fn i32_to_f32(s: &i32) -> f32 {
    *s as f32 / i32::MAX as f32
}

fn f32_to_i8(s: f32) -> i8 {
    (s * i8::MAX as f32) as i8
}

fn f32_to_u8(s: f32) -> u8 {
    // .round() so digital silence lands exactly on the format's equilibrium
    // instead of 1 LSB below it (a tiny DC offset).
    (s * (u8::MAX as f32 / 2.0) + u8::MAX as f32 / 2.0).round() as u8
}

fn f32_to_i16(s: f32) -> i16 {
    (s * i16::MAX as f32) as i16
}

fn f32_to_u16(s: f32) -> u16 {
    (s * (u16::MAX as f32 / 2.0) + u16::MAX as f32 / 2.0).round() as u16
}

fn f32_to_i24(s: f32) -> cpal::I24 {
    cpal::I24::new_unchecked((s * I24_FULL_SCALE) as i32)
}

fn f32_to_u24(s: f32) -> cpal::U24 {
    cpal::U24::new_unchecked((s * U24_MIDPOINT + U24_MIDPOINT).round() as i32)
}

fn f32_to_i32(s: f32) -> i32 {
    (s * i32::MAX as f32) as i32
}

#[cfg(test)]
mod conversion_tests {
    use super::*;

    const EPS: f32 = 1e-6;

    #[test]
    fn signed_ints_scale_to_full_range() {
        assert_eq!(i8_to_f32(&0), 0.0);
        assert_eq!(i8_to_f32(&i8::MAX), 1.0);
        assert!((i8_to_f32(&i8::MIN) - -1.0).abs() < 0.01);
        assert_eq!(i16_to_f32(&i16::MAX), 1.0);
        assert_eq!(i32_to_f32(&i32::MAX), 1.0);
    }

    #[test]
    fn unsigned_ints_are_centered_on_zero() {
        assert_eq!(u8_to_f32(&0), -1.0);
        assert_eq!(u8_to_f32(&u8::MAX), 1.0);
        assert!((u8_to_f32(&128)).abs() < 0.01); // midpoint ≈ silence
        assert_eq!(u16_to_f32(&0), -1.0);
        assert_eq!(u16_to_f32(&u16::MAX), 1.0);
        assert!((u16_to_f32(&32768)).abs() < 1e-4);
    }

    #[test]
    fn i24_uses_24bit_full_scale_not_i32() {
        assert_eq!(i24_to_f32(&cpal::I24::new(0).unwrap()), 0.0);
        assert_eq!(i24_to_f32(&cpal::I24::new(8_388_607).unwrap()), 1.0);
        assert!((i24_to_f32(&cpal::I24::new(-8_388_608).unwrap()) - -1.0).abs() < EPS);
        // A value at half of 24-bit range must read as ~0.5; i32::MAX scaling
        // would wrongly read it as ~0.002.
        assert!((i24_to_f32(&cpal::I24::new(4_194_304).unwrap()) - 0.5).abs() < EPS);
    }

    #[test]
    fn u24_is_centered_on_equilibrium() {
        assert_eq!(u24_to_f32(&cpal::U24::new(0).unwrap()), -1.0);
        assert_eq!(u24_to_f32(&cpal::U24::new(16_777_215).unwrap()), 1.0);
        assert!((u24_to_f32(&cpal::U24::new(8_388_608).unwrap())).abs() < EPS);
    }

    #[test]
    fn f32_roundtrips_signed_formats() {
        assert_eq!(f32_to_i8(1.0), i8::MAX);
        assert_eq!(f32_to_i16(1.0), i16::MAX);
        assert_eq!(f32_to_i32(1.0), i32::MAX);
        assert_eq!(f32_to_i24(1.0).inner(), 8_388_607);
        assert_eq!(f32_to_i24(-1.0).inner(), -8_388_607);
        assert!((i24_to_f32(&f32_to_i24(0.5)) - 0.5).abs() < EPS);
    }

    #[test]
    fn f32_roundtrips_unsigned_formats_on_equilibrium() {
        assert_eq!(f32_to_u8(1.0), u8::MAX);
        assert_eq!(f32_to_u8(-1.0), 0);
        assert_eq!(f32_to_u8(0.0), 128); // equilibrium, not 127
        assert_eq!(f32_to_u16(0.0), 32768);
        assert_eq!(f32_to_u24(1.0).inner(), 16_777_215);
        assert_eq!(f32_to_u24(-1.0).inner(), 0);
        assert_eq!(f32_to_u24(0.0).inner(), 8_388_608);
    }
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

/// Cap on how much captured audio waits to be played back, so a stalled
/// output stream can't grow the loopback delay (or memory use) without bound.
const LOOPBACK_MAX_SAMPLES: usize = 24_000;

enum TestCommand {
    Start(
        Option<String>,
        tauri::AppHandle,
        mpsc::Sender<Result<(), String>>,
    ),
    Stop,
    Shutdown,
}

/// Owns the paired mic-capture + speaker-playback streams used by the
/// settings-page microphone test, on their own dedicated thread (same
/// non-`Send` constraint as `AudioController`, but kept separate so a stuck
/// or busy test device can never affect a real recording session).
pub struct MicTestController {
    tx: mpsc::Sender<TestCommand>,
}

impl MicTestController {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<TestCommand>();

        thread::spawn(move || {
            let mut active: Option<(cpal::Stream, cpal::Stream)> = None;

            for cmd in rx {
                match cmd {
                    TestCommand::Start(device_name, app, reply) => {
                        drop(active.take());

                        let streams = match build_test_streams(device_name, app) {
                            Ok(s) => s,
                            Err(e) => {
                                let _ = reply.send(Err(e));
                                continue;
                            }
                        };
                        let (input, output) = streams;
                        if let Err(e) = output.play() {
                            let _ = reply.send(Err(format!("Failed to start playback: {e}")));
                            continue;
                        }
                        match input.play() {
                            Ok(()) => {
                                active = Some((input, output));
                                let _ = reply.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = reply.send(Err(format!("Failed to start microphone: {e}")));
                            }
                        }
                    }
                    TestCommand::Stop => {
                        drop(active.take());
                    }
                    TestCommand::Shutdown => break,
                }
            }
        });

        Self { tx }
    }

    pub fn start(&self, device_name: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(TestCommand::Start(device_name, app, reply_tx))
            .map_err(|e| format!("Mic test thread not available: {e}"))?;
        reply_rx
            .recv()
            .map_err(|_| "Mic test thread stopped unexpectedly".to_string())?
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(TestCommand::Stop)
            .map_err(|e| format!("Mic test thread not available: {e}"))
    }
}

impl Drop for MicTestController {
    fn drop(&mut self) {
        let _ = self.tx.send(TestCommand::Shutdown);
    }
}

fn push_loopback(ring: &Mutex<VecDeque<f32>>, samples: &[f32]) {
    let Ok(mut buf) = ring.lock() else { return };
    buf.extend(samples.iter().copied());
    let excess = buf.len().saturating_sub(LOOPBACK_MAX_SAMPLES);
    if excess > 0 {
        buf.drain(..excess);
    }
}

/// Pull one sample per output frame out of the ring buffer, holding the last
/// value while `acc` catches up (a cheap zero-order-hold resample) and
/// falling back to silence — not the stale value — once the buffer runs dry.
fn next_loopback_sample(
    ring: &Mutex<VecDeque<f32>>,
    step: f64,
    acc: &mut f64,
    carry: &mut f32,
) -> f32 {
    *acc += step;
    if *acc >= 1.0 {
        let mut buf = ring.lock().unwrap();
        while *acc >= 1.0 {
            *acc -= 1.0;
            *carry = buf.pop_front().unwrap_or(0.0);
        }
    }
    *carry
}

#[cfg(test)]
mod loopback_tests {
    use super::*;

    #[test]
    fn upsamples_by_holding_each_sample() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0]));
        let mut acc = 0f64;
        let mut carry = 0f32;
        let step = 0.5; // output rate is 2x the input rate
        let out: Vec<f32> = (0..8)
            .map(|_| next_loopback_sample(&ring, step, &mut acc, &mut carry))
            .collect();
        assert_eq!(out, vec![0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 0.0]);
    }

    #[test]
    fn downsamples_by_dropping_samples() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0, 4.0]));
        let mut acc = 0f64;
        let mut carry = 0f32;
        let step = 2.0; // input rate is 2x the output rate
        let out: Vec<f32> = (0..3)
            .map(|_| next_loopback_sample(&ring, step, &mut acc, &mut carry))
            .collect();
        assert_eq!(out, vec![2.0, 4.0, 0.0]);
    }

    #[test]
    fn push_loopback_caps_and_keeps_latest_samples() {
        let ring = Mutex::new(VecDeque::new());
        let all: Vec<f32> = (0..LOOPBACK_MAX_SAMPLES + 100).map(|i| i as f32).collect();
        push_loopback(&ring, &all);
        let buf = ring.lock().unwrap();
        assert_eq!(buf.len(), LOOPBACK_MAX_SAMPLES);
        assert_eq!(*buf.front().unwrap(), 100.0);
        assert_eq!(*buf.back().unwrap(), (LOOPBACK_MAX_SAMPLES + 99) as f32);
    }
}

/// Build a live mic-capture -> speaker-playback pair so the settings page can
/// let the user hear (and see, via `voice-audio-level`) whether the selected
/// device actually picks up sound.
fn build_test_streams(
    device_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<(cpal::Stream, cpal::Stream), String> {
    let host = cpal::default_host();
    let device = resolve_input_device(&host, &device_name)
        .ok_or("No microphone found. Please connect a microphone and try again.")?;
    let in_config = device
        .default_input_config()
        .map_err(|_| "Microphone is not available. Please check your audio input settings.".to_string())?;
    let in_channels = in_config.channels() as usize;
    let in_rate = in_config.sample_rate();

    let out_device = host
        .default_output_device()
        .ok_or("No speaker found. Please connect a speaker or headphones and try again.")?;
    let out_config = out_device
        .default_output_config()
        .map_err(|e| format!("Speaker is not available: {e}"))?;
    let out_channels = out_config.channels() as usize;
    if out_channels == 0 {
        return Err("Speaker reports zero output channels".into());
    }
    let out_rate = out_config.sample_rate();

    let ring = Arc::new(Mutex::new(VecDeque::<f32>::new()));
    let level_counter = Arc::new(Mutex::new(0usize));

    let ring_in = ring.clone();
    let level_in = level_counter.clone();
    let app_in = app.clone();
    let in_err_fn = |err| eprintln!("Mic test input error: {err}");

    macro_rules! input_arm {
        ($ty:ty, $to_f32:expr) => {
            device
                .build_input_stream(
                    in_config.into(),
                    move |data: &$ty, _: &cpal::InputCallbackInfo| {
                        let converted: Vec<f32> = data.iter().map($to_f32).collect();
                        let mono = mono_downmix(&converted, in_channels);
                        push_loopback(&ring_in, &mono);
                        let rms_ready = {
                            let mut c = level_in.lock().unwrap();
                            *c += mono.len();
                            if *c >= LEVEL_EMIT_INTERVAL {
                                *c = 0;
                                true
                            } else {
                                false
                            }
                        };
                        if rms_ready {
                            let _ = app_in.emit("voice-audio-level", compute_rms(&mono));
                        }
                    },
                    in_err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build input stream: {e}"))?
        };
    }

    let input_stream = match in_config.sample_format() {
        cpal::SampleFormat::F32 => input_arm!([f32], |s: &f32| *s),
        cpal::SampleFormat::I8 => input_arm!([i8], i8_to_f32),
        cpal::SampleFormat::U8 => input_arm!([u8], u8_to_f32),
        cpal::SampleFormat::I16 => input_arm!([i16], i16_to_f32),
        cpal::SampleFormat::U16 => input_arm!([u16], u16_to_f32),
        cpal::SampleFormat::I24 => input_arm!([cpal::I24], i24_to_f32),
        cpal::SampleFormat::U24 => input_arm!([cpal::U24], u24_to_f32),
        cpal::SampleFormat::I32 => input_arm!([i32], i32_to_f32),
        format => return Err(format!("Unsupported microphone sample format: {format:?}")),
    };

    let ring_out = ring;
    let step = in_rate as f64 / out_rate as f64;
    let out_err_fn = |err| eprintln!("Mic test output error: {err}");

    macro_rules! output_arm {
        ($ty:ty, $from_f32:expr) => {{
            let mut acc = 0f64;
            let mut carry = 0f32;
            out_device
                .build_output_stream(
                    out_config.into(),
                    move |data: &mut $ty, _: &cpal::OutputCallbackInfo| {
                        for frame in data.chunks_mut(out_channels) {
                            let sample =
                                next_loopback_sample(&ring_out, step, &mut acc, &mut carry);
                            frame.fill($from_f32(sample));
                        }
                    },
                    out_err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build output stream: {e}"))?
        }};
    }

    let output_stream = match out_config.sample_format() {
        cpal::SampleFormat::F32 => output_arm!([f32], |s: f32| s),
        cpal::SampleFormat::I8 => output_arm!([i8], f32_to_i8),
        cpal::SampleFormat::U8 => output_arm!([u8], f32_to_u8),
        cpal::SampleFormat::I16 => output_arm!([i16], f32_to_i16),
        cpal::SampleFormat::U16 => output_arm!([u16], f32_to_u16),
        cpal::SampleFormat::I24 => output_arm!([cpal::I24], f32_to_i24),
        cpal::SampleFormat::U24 => output_arm!([cpal::U24], f32_to_u24),
        cpal::SampleFormat::I32 => output_arm!([i32], f32_to_i32),
        format => return Err(format!("Unsupported speaker sample format: {format:?}")),
    };

    Ok((input_stream, output_stream))
}
