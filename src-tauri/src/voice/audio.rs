use crate::sync::LockExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter::Adapter;
use rubato::{Fft, FixedSync, Resampler};
use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Emitter;

/// Sample rate, in Hz, of the audio handed to Whisper.
pub(super) const TARGET_SAMPLE_RATE: u32 = 16000;
const RESAMPLE_CHUNK_SIZE: usize = 1024;
const MONO_CHANNELS: usize = 1;
const AUDIO_LEVEL_EVENT: &str = "voice-audio-level";

/// Wrapper to pass a mono `&[f32]` slice as a single-channel `Adapter` for rubato.
struct MonoSlice<'a>(&'a [f32]);

// SAFETY: `MonoSlice` reports a fixed channel count of 1 and a frame count
// equal to the slice length, both immutable for the lifetime of the buffer.
unsafe impl Adapter<f32> for MonoSlice<'_> {
    unsafe fn read_sample_unchecked(&self, _channel: usize, frame: usize) -> f32 {
        // SAFETY: rubato only calls this with `frame < self.frames()`, which
        // is the slice length, so the index is in bounds.
        unsafe { *self.0.get_unchecked(frame) }
    }
    fn channels(&self) -> usize {
        MONO_CHANNELS
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
        Box<tauri::AppHandle>,
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
    with_stderr_silenced(f)
}

#[cfg(all(unix, any(target_os = "linux", test)))]
static STDERR_REDIRECT: Mutex<()> = Mutex::new(());

#[cfg(all(unix, any(target_os = "linux", test)))]
fn with_stderr_silenced<F, R>(work: F) -> R
where
    F: FnOnce() -> R,
{
    let _serialised = STDERR_REDIRECT.lock_or_recover();
    let _silenced = SilencedStderr::begin();
    work()
}

#[cfg(all(unix, any(target_os = "linux", test)))]
struct SilencedStderr {
    saved: Option<libc::c_int>,
}

#[cfg(all(unix, any(target_os = "linux", test)))]
impl SilencedStderr {
    fn begin() -> Self {
        use std::os::unix::io::AsRawFd;

        // SAFETY: `dup` only duplicates fd 2 in the descriptor table; a
        // negative result is checked before the copy is used.
        let saved = unsafe { libc::dup(libc::STDERR_FILENO) };
        if saved < 0 {
            return Self { saved: None };
        }
        if let Ok(devnull) = std::fs::File::open("/dev/null") {
            // SAFETY: `devnull` stays open for the call and `dup2` atomically
            // replaces fd 2, whose original is kept in `saved`.
            unsafe {
                libc::dup2(devnull.as_raw_fd(), libc::STDERR_FILENO);
            }
        }
        Self { saved: Some(saved) }
    }
}

#[cfg(all(unix, any(target_os = "linux", test)))]
impl Drop for SilencedStderr {
    fn drop(&mut self) {
        let Some(saved) = self.saved else {
            return;
        };
        // SAFETY: `saved` is a descriptor this guard alone owns, from `dup`;
        // it is put back on fd 2 and closed exactly once, here.
        unsafe {
            libc::dup2(saved, libc::STDERR_FILENO);
            libc::close(saved);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn suppress_alsa_stderr<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    f()
}

// `name` is only read by the Linux filter of ALSA's virtual devices.
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

            // Replies are best-effort: the caller may have stopped waiting.
            for cmd in rx {
                match cmd {
                    Command::Start(buffer, app, device_name, reply) => {
                        drop(active_stream.take());

                        let stream = match build_stream(buffer, *app, device_name) {
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
                                let _ =
                                    reply.send(Err(format!("Failed to start audio stream: {e}")));
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
            .send(Command::Start(
                audio_buffer,
                Box::new(app),
                device_name,
                reply_tx,
            ))
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

struct StreamContext {
    channels: u16,
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

fn open_microphone(
    host: &cpal::Host,
    device_name: &Option<String>,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let device = resolve_input_device(host, device_name)
        .ok_or("No microphone found. Please connect a microphone and try again.")?;
    let config = device.default_input_config().map_err(|error| {
        format!("Microphone is not available ({error}). Please check your audio input settings.")
    })?;
    Ok((device, config))
}

fn build_stream(
    buffer: Arc<Mutex<Vec<f32>>>,
    app: tauri::AppHandle,
    device_name: Option<String>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let (device, config) = open_microphone(&host, &device_name)?;
    let ctx = StreamContext {
        channels: config.channels(),
        resampler: resampler_for(config.sample_rate())?,
        resample_pending: Arc::new(Mutex::new(Vec::new())),
        buffer,
        sample_counter: Arc::new(Mutex::new(0usize)),
        silence_counter: Arc::new(Mutex::new(0u32)),
        total_checks: Arc::new(Mutex::new(0u32)),
        app,
    };
    build_input(&device, &config, move |samples| {
        process_audio(samples, &ctx)
    })
}

fn resampler_for(source_sample_rate: u32) -> Result<Option<Arc<Mutex<Fft<f32>>>>, String> {
    if source_sample_rate == TARGET_SAMPLE_RATE {
        return Ok(None);
    }
    let resampler = Fft::new(
        rate_in_hz(source_sample_rate)?,
        rate_in_hz(TARGET_SAMPLE_RATE)?,
        RESAMPLE_CHUNK_SIZE,
        MONO_CHANNELS,
        FixedSync::Input,
    )
    .map_err(|e| format!("Failed to create resampler: {e}"))?;
    Ok(Some(Arc::new(Mutex::new(resampler))))
}

fn rate_in_hz(sample_rate: u32) -> Result<usize, String> {
    usize::try_from(sample_rate).map_err(|e| format!("Failed to create resampler: {e}"))
}

trait ConvertibleSample: cpal::SizedSample {
    fn to_f32(&self) -> f32;
    fn from_f32(sample: f32) -> Self;
}

impl ConvertibleSample for f32 {
    fn to_f32(&self) -> f32 {
        *self
    }
    fn from_f32(sample: f32) -> Self {
        sample
    }
}

macro_rules! convertible_sample {
    ($sample:ty, $to_f32:ident, $from_f32:ident) => {
        impl ConvertibleSample for $sample {
            fn to_f32(&self) -> f32 {
                $to_f32(self)
            }
            fn from_f32(sample: f32) -> Self {
                $from_f32(sample)
            }
        }
    };
}

convertible_sample!(i8, i8_to_f32, f32_to_i8);
convertible_sample!(u8, u8_to_f32, f32_to_u8);
convertible_sample!(i16, i16_to_f32, f32_to_i16);
convertible_sample!(u16, u16_to_f32, f32_to_u16);
// 24-bit USB interfaces (Focusrite & co.) natively report I24/U24.
// cpal hands these over as dasp I24/U24 (right-justified in a 32-bit
// container), so the 24-bit full-scale helpers apply — not the I32 one.
convertible_sample!(cpal::I24, i24_to_f32, f32_to_i24);
convertible_sample!(cpal::U24, u24_to_f32, f32_to_u24);
// Several ALSA HDA codecs (e.g. Realtek ALC897) only expose their raw
// hardware PCM as S32 — PulseAudio/PipeWire normally hide this behind
// format conversion, but selecting the hw device directly bypasses
// that, so it must be handled here too.
convertible_sample!(i32, i32_to_f32, f32_to_i32);

fn build_input<F>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    on_samples: F,
) -> Result<cpal::Stream, String>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    let stream_config = config.config();
    match config.sample_format() {
        cpal::SampleFormat::F32 => input_stream_of::<f32>(device, stream_config, on_samples),
        cpal::SampleFormat::I8 => input_stream_of::<i8>(device, stream_config, on_samples),
        cpal::SampleFormat::U8 => input_stream_of::<u8>(device, stream_config, on_samples),
        cpal::SampleFormat::I16 => input_stream_of::<i16>(device, stream_config, on_samples),
        cpal::SampleFormat::U16 => input_stream_of::<u16>(device, stream_config, on_samples),
        cpal::SampleFormat::I24 => input_stream_of::<cpal::I24>(device, stream_config, on_samples),
        cpal::SampleFormat::U24 => input_stream_of::<cpal::U24>(device, stream_config, on_samples),
        cpal::SampleFormat::I32 => input_stream_of::<i32>(device, stream_config, on_samples),
        format => Err(format!("Unsupported microphone sample format: {format:?}")),
    }
}

fn input_stream_of<T: ConvertibleSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut on_samples: impl FnMut(&[f32]) + Send + 'static,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let converted: Vec<f32> = data.iter().map(T::to_f32).collect();
                on_samples(&converted);
            },
            |error| eprintln!("Microphone stream error: {error}"),
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {e}"))
}

fn build_output<F>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    next_sample: F,
) -> Result<cpal::Stream, String>
where
    F: FnMut() -> f32 + Send + 'static,
{
    let stream_config = config.config();
    match config.sample_format() {
        cpal::SampleFormat::F32 => output_stream_of::<f32>(device, stream_config, next_sample),
        cpal::SampleFormat::I8 => output_stream_of::<i8>(device, stream_config, next_sample),
        cpal::SampleFormat::U8 => output_stream_of::<u8>(device, stream_config, next_sample),
        cpal::SampleFormat::I16 => output_stream_of::<i16>(device, stream_config, next_sample),
        cpal::SampleFormat::U16 => output_stream_of::<u16>(device, stream_config, next_sample),
        cpal::SampleFormat::I24 => {
            output_stream_of::<cpal::I24>(device, stream_config, next_sample)
        }
        cpal::SampleFormat::U24 => {
            output_stream_of::<cpal::U24>(device, stream_config, next_sample)
        }
        cpal::SampleFormat::I32 => output_stream_of::<i32>(device, stream_config, next_sample),
        format => Err(format!("Unsupported speaker sample format: {format:?}")),
    }
}

fn output_stream_of<T: ConvertibleSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut next_sample: impl FnMut() -> f32 + Send + 'static,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels);
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                for frame in data.chunks_mut(channels) {
                    frame.fill(T::from_f32(next_sample()));
                }
            },
            |error| eprintln!("Speaker stream error: {error}"),
            None,
        )
        .map_err(|e| format!("Failed to build output stream: {e}"))
}

/// Downmix interleaved multi-channel audio to mono by averaging each frame.
fn mono_downmix(data: &[f32], channels: u16) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(usize::from(channels))
        .map(|frame| frame.iter().sum::<f32>() / f32::from(channels))
        .collect()
}

/// Compute the RMS (root mean square) of an audio sample buffer.
pub(super) fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    // A mean over audio samples tolerates the rounding of a very large count.
    let count = samples.len() as f32;
    (samples.iter().map(|s| s * s).sum::<f32>() / count).sqrt()
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
    f32::from(*s) / f32::from(i8::MAX)
}

fn u8_to_f32(s: &u8) -> f32 {
    (f32::from(*s) - f32::from(u8::MAX) / 2.0) / (f32::from(u8::MAX) / 2.0)
}

fn i16_to_f32(s: &i16) -> f32 {
    f32::from(*s) / f32::from(i16::MAX)
}

fn u16_to_f32(s: &u16) -> f32 {
    (f32::from(*s) - f32::from(u16::MAX) / 2.0) / (f32::from(u16::MAX) / 2.0)
}

fn i24_to_f32(s: &cpal::I24) -> f32 {
    // A 24-bit value fits the f32 mantissa, so this conversion is exact.
    s.inner() as f32 / I24_FULL_SCALE
}

fn u24_to_f32(s: &cpal::U24) -> f32 {
    // A 24-bit value fits the f32 mantissa, so this conversion is exact.
    (s.inner() as f32 - U24_MIDPOINT) / U24_MIDPOINT
}

fn i32_to_f32(s: &i32) -> f32 {
    // Rounding to f32 precision is inaudible in a normalised sample.
    *s as f32 / i32::MAX as f32
}

fn f32_to_i8(s: f32) -> i8 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (s * f32::from(i8::MAX)) as i8
}

fn f32_to_u8(s: f32) -> u8 {
    // .round() so digital silence lands exactly on the format's equilibrium
    // instead of 1 LSB below it (a tiny DC offset).
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (s * (f32::from(u8::MAX) / 2.0) + f32::from(u8::MAX) / 2.0).round() as u8
}

fn f32_to_i16(s: f32) -> i16 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (s * f32::from(i16::MAX)) as i16
}

fn f32_to_u16(s: f32) -> u16 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (s * (f32::from(u16::MAX) / 2.0) + f32::from(u16::MAX) / 2.0).round() as u16
}

fn f32_to_i24(s: f32) -> cpal::I24 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    cpal::I24::new_unchecked((s * I24_FULL_SCALE) as i32)
}

fn f32_to_u24(s: f32) -> cpal::U24 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    cpal::U24::new_unchecked((s * U24_MIDPOINT + U24_MIDPOINT).round() as i32)
}

fn f32_to_i32(s: f32) -> i32 {
    // Rounding i32::MAX to f32 and the saturating float-to-int `as` clip
    // out-of-range samples, which is the intended behaviour.
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
        ctx.buffer.lock_or_recover().extend_from_slice(&mono);
        return;
    };

    let mut pending = ctx.resample_pending.lock_or_recover();
    pending.extend_from_slice(&mono);

    let mut resampler = resampler_arc.lock_or_recover();
    while pending.len() >= RESAMPLE_CHUNK_SIZE {
        let chunk: Vec<f32> = pending.drain(..RESAMPLE_CHUNK_SIZE).collect();
        let input = MonoSlice(&chunk);
        match resampler.process(&input, None) {
            Ok(output) => {
                let samples: Vec<f32> = (0..output.frames())
                    .map(|i| output.read_sample(0, i).unwrap_or(0.0))
                    .collect();
                emit_audio_level(&samples, ctx);
                ctx.buffer.lock_or_recover().extend_from_slice(&samples);
            }
            Err(e) => {
                eprintln!("Resampling error: {e}");
                return;
            }
        }
    }
}

fn emit_audio_level(samples: &[f32], ctx: &StreamContext) {
    let Some(rms) = take_due_level(&ctx.sample_counter, samples) else {
        return;
    };
    let _ = ctx.app.emit(AUDIO_LEVEL_EVENT, rms);

    check_silence(rms, ctx);
}

/// Count `samples` towards the next level reading and, once
/// `LEVEL_EMIT_INTERVAL` samples have passed, restart the count and return
/// their RMS. Counting and restarting happen under one lock.
fn take_due_level(counter: &Mutex<usize>, samples: &[f32]) -> Option<f32> {
    let mut counter = counter.lock_or_recover();
    *counter += samples.len();
    if *counter < LEVEL_EMIT_INTERVAL {
        return None;
    }
    *counter = 0;
    Some(compute_rms(samples))
}

fn check_silence(rms: f32, ctx: &StreamContext) {
    let mut tc = ctx.total_checks.lock_or_recover();
    let mut sc = ctx.silence_counter.lock_or_recover();
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

            // Replies are best-effort: the caller may have stopped waiting.
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
    let mut buf = ring.lock_or_recover();
    buf.extend(samples.iter().copied());
    let excess = buf.len().saturating_sub(LOOPBACK_MAX_SAMPLES);
    if excess > 0 {
        buf.drain(..excess);
    }
}

struct LoopbackCursor {
    step: f64,
    position: f64,
    carry: f32,
}

impl LoopbackCursor {
    fn new(step: f64) -> Self {
        Self {
            step,
            position: 0.0,
            carry: 0.0,
        }
    }

    /// Pull one sample per output frame out of the ring buffer, holding the last
    /// value while `position` catches up (a cheap zero-order-hold resample) and
    /// falling back to silence — not the stale value — once the buffer runs dry.
    fn next_sample(&mut self, ring: &Mutex<VecDeque<f32>>) -> f32 {
        self.position += self.step;
        if self.position >= 1.0 {
            let mut buf = ring.lock_or_recover();
            while self.position >= 1.0 {
                self.position -= 1.0;
                self.carry = buf.pop_front().unwrap_or(0.0);
            }
        }
        self.carry
    }
}

#[cfg(test)]
mod loopback_tests {
    use super::*;

    #[test]
    fn upsamples_by_holding_each_sample() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0]));
        let mut cursor = LoopbackCursor::new(0.5);
        let out: Vec<f32> = (0..8).map(|_| cursor.next_sample(&ring)).collect();
        assert_eq!(out, vec![0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 0.0]);
    }

    #[test]
    fn downsamples_by_dropping_samples() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0, 4.0]));
        let mut cursor = LoopbackCursor::new(2.0);
        let out: Vec<f32> = (0..3).map(|_| cursor.next_sample(&ring)).collect();
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

#[cfg(test)]
mod level_tests {
    use super::*;

    fn converted<T: ConvertibleSample>(sample: f32) -> f32 {
        T::from_f32(sample).to_f32()
    }

    #[test]
    fn given_fewer_samples_than_the_interval_when_counting_then_no_level_is_due() {
        let counter = Mutex::new(0usize);

        let level = take_due_level(&counter, &[0.5; LEVEL_EMIT_INTERVAL - 1]);

        assert_eq!(level, None);
        assert_eq!(*counter.lock().unwrap(), LEVEL_EMIT_INTERVAL - 1);
    }

    #[test]
    fn given_the_interval_is_reached_when_counting_then_the_rms_is_due_and_the_count_restarts() {
        let counter = Mutex::new(LEVEL_EMIT_INTERVAL - 1);

        let level = take_due_level(&counter, &[0.5, -0.5]);

        assert_eq!(level, Some(0.5));
        assert_eq!(*counter.lock().unwrap(), 0);
    }

    #[test]
    fn given_interleaved_stereo_when_downmixing_then_each_frame_is_averaged() {
        assert_eq!(mono_downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert!(mono_downmix(&[1.0], 0).is_empty());
    }

    #[test]
    fn given_every_sample_format_when_converting_full_scale_through_it_then_it_round_trips() {
        assert_eq!(converted::<f32>(1.0), 1.0);
        assert_eq!(converted::<i8>(1.0), 1.0);
        assert_eq!(converted::<u8>(1.0), 1.0);
        assert_eq!(converted::<i16>(1.0), 1.0);
        assert_eq!(converted::<u16>(1.0), 1.0);
        assert_eq!(converted::<cpal::I24>(1.0), 1.0);
        assert_eq!(converted::<cpal::U24>(1.0), 1.0);
        assert_eq!(converted::<i32>(1.0), 1.0);
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
    let (device, in_config) = open_microphone(&host, &device_name)?;
    let (out_device, out_config) = open_speaker(&host)?;
    let in_channels = in_config.channels();

    let ring = Arc::new(Mutex::new(VecDeque::<f32>::new()));
    let ring_in = ring.clone();
    let level_counter = Mutex::new(0usize);
    let input_stream = build_input(&device, &in_config, move |samples| {
        let mono = mono_downmix(samples, in_channels);
        push_loopback(&ring_in, &mono);
        if let Some(rms) = take_due_level(&level_counter, &mono) {
            let _ = app.emit(AUDIO_LEVEL_EVENT, rms);
        }
    })?;

    let step = f64::from(in_config.sample_rate()) / f64::from(out_config.sample_rate());
    let mut cursor = LoopbackCursor::new(step);
    let output_stream = build_output(&out_device, &out_config, move || cursor.next_sample(&ring))?;

    Ok((input_stream, output_stream))
}

fn open_speaker(host: &cpal::Host) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let device = host
        .default_output_device()
        .ok_or("No speaker found. Please connect a speaker or headphones and try again.")?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("Speaker is not available: {e}"))?;
    if config.channels() == 0 {
        return Err("Speaker reports zero output channels".into());
    }
    Ok((device, config))
}

#[cfg(test)]
mod resample_tests {
    use super::*;

    /// Same setup `start_capture` uses for a 48kHz mic.
    #[test]
    fn downsamples_48k_sine_to_16k_without_losing_level() {
        let mut resampler = Fft::<f32>::new(
            48000,
            TARGET_SAMPLE_RATE as usize,
            RESAMPLE_CHUNK_SIZE,
            1,
            FixedSync::Input,
        )
        .unwrap();

        let amplitude = 0.5f32;
        let input: Vec<f32> = (0..48000)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin())
            .collect();

        let mut out = Vec::new();
        for chunk in input.as_chunks::<RESAMPLE_CHUNK_SIZE>().0 {
            let output = resampler.process(&MonoSlice(chunk), None).unwrap();
            out.extend((0..output.frames()).map(|i| output.read_sample(0, i).unwrap()));
        }

        // Output runs at a third of the input rate; the FFT block size delays
        // up to one output chunk, so allow that much shortfall.
        let chunks = input.len() / RESAMPLE_CHUNK_SIZE;
        let expected = chunks * RESAMPLE_CHUNK_SIZE / 3;
        assert!(
            out.len() <= expected && expected - out.len() <= RESAMPLE_CHUNK_SIZE / 3,
            "got {} frames, expected ~{expected}",
            out.len()
        );

        // Skip the filter warm-up, then the tone should keep its RMS (A/√2).
        let tail = &out[out.len() / 2..];
        let rms = (tail.iter().map(|s| s * s).sum::<f32>() / tail.len() as f32).sqrt();
        let want = amplitude / std::f32::consts::SQRT_2;
        assert!((rms - want).abs() < want * 0.05, "rms {rms}, want {want}");
    }
}

#[cfg(all(test, unix))]
mod stderr_tests {
    use super::with_stderr_silenced;
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    use std::time::Duration;

    const CONCURRENT_CALLERS: usize = 16;
    const ROUNDS: usize = 20;

    fn stderr_identity() -> (u64, u64) {
        let copy = std::io::stderr()
            .as_fd()
            .try_clone_to_owned()
            .expect("duplicate stderr");
        let metadata = std::fs::File::from(copy).metadata().expect("stat stderr");
        (metadata.dev(), metadata.ino())
    }

    #[test]
    fn given_concurrent_silencers_when_they_all_finish_then_stderr_is_the_original_one() {
        let original = stderr_identity();

        std::thread::scope(|scope| {
            for _ in 0..CONCURRENT_CALLERS {
                scope.spawn(|| {
                    for _ in 0..ROUNDS {
                        with_stderr_silenced(|| std::thread::sleep(Duration::from_micros(50)));
                    }
                });
            }
        });

        assert_eq!(stderr_identity(), original);
    }
}
