use crate::sync::LockExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter::Adapter;
use rubato::{Fft, FixedSync, Resampler};
use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Runtime};

pub(super) const TARGET_SAMPLE_RATE: u32 = 16000;
const RESAMPLE_CHUNK_SIZE: usize = 1024;
const MONO_CHANNELS: usize = 1;
const AUDIO_LEVEL_EVENT: &str = "voice-audio-level";

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

const LEVEL_EMIT_INTERVAL: usize = 800;
const SILENCE_THRESHOLD: f32 = 0.01;
const SILENCE_FRAME_COUNT: u32 = 24;
const MIN_RECORDING_CHECKS: u32 = 20;

enum Command<R: Runtime> {
    Start(
        Arc<Mutex<Vec<f32>>>,
        Box<AppHandle<R>>,
        Option<String>,
        mpsc::Sender<Result<(), String>>,
    ),
    Stop,
    Shutdown,
}

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
            .filter_map(|device| {
                let name = device.description().ok()?.name().to_string();
                if !is_usable_input(&name, &device) {
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

#[cfg(target_os = "linux")]
fn suppress_alsa_stderr<F, R>(enumerate: F) -> R
where
    F: FnOnce() -> R,
{
    with_stderr_silenced(enumerate)
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
fn suppress_alsa_stderr<F, R>(enumerate: F) -> R
where
    F: FnOnce() -> R,
{
    enumerate()
}

// `name` is only read by the Linux filter of ALSA's virtual devices.
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn is_usable_input(name: &str, device: &cpal::Device) -> bool {
    #[cfg(target_os = "linux")]
    {
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
        if VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        {
            return false;
        }
    }
    device.default_input_config().is_ok()
}

pub struct AudioController<R: Runtime = tauri::Wry> {
    tx: mpsc::Sender<Command<R>>,
}

impl<R: Runtime> AudioController<R> {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Command<R>>();

        thread::spawn(move || {
            let mut active_stream: Option<cpal::Stream> = None;

            for cmd in rx {
                match cmd {
                    Command::Start(buffer, app, device_name, reply) => {
                        drop(active_stream.take());

                        let stream = match build_stream(buffer, *app, device_name) {
                            Ok(stream) => stream,
                            Err(error) => {
                                let _ = reply.send(Err(error));
                                continue;
                            }
                        };
                        match stream.play() {
                            Ok(()) => {
                                active_stream = Some(stream);
                                let _ = reply.send(Ok(()));
                            }
                            Err(error) => {
                                let _ = reply
                                    .send(Err(format!("Failed to start audio stream: {error}")));
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
        app: AppHandle<R>,
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
            .map_err(|error| format!("Audio thread not available: {error}"))?;
        reply_rx
            .recv()
            .map_err(|_| "Audio thread stopped unexpectedly".to_string())?
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(Command::Stop)
            .map_err(|error| format!("Audio thread not available: {error}"))
    }
}

impl<R: Runtime> Drop for AudioController<R> {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

struct StreamContext<R: Runtime> {
    channels: u16,
    resampler: Option<Arc<Mutex<Fft<f32>>>>,
    resample_pending: Arc<Mutex<Vec<f32>>>,
    buffer: Arc<Mutex<Vec<f32>>>,
    sample_counter: Arc<Mutex<usize>>,
    silence_counter: Arc<Mutex<u32>>,
    total_checks: Arc<Mutex<u32>>,
    app: AppHandle<R>,
}

fn resolve_input_device(host: &cpal::Host, device_name: &Option<String>) -> Option<cpal::Device> {
    if let Some(name) = device_name {
        let found = suppress_alsa_stderr(|| {
            host.input_devices().ok()?.find(|device| {
                device
                    .description()
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

fn build_stream<R: Runtime>(
    buffer: Arc<Mutex<Vec<f32>>>,
    app: AppHandle<R>,
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
    .map_err(|error| format!("Failed to create resampler: {error}"))?;
    Ok(Some(Arc::new(Mutex::new(resampler))))
}

fn rate_in_hz(sample_rate: u32) -> Result<usize, String> {
    usize::try_from(sample_rate).map_err(|error| format!("Failed to create resampler: {error}"))
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
convertible_sample!(cpal::I24, i24_to_f32, f32_to_i24);
convertible_sample!(cpal::U24, u24_to_f32, f32_to_u24);
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
        .map_err(|error| format!("Failed to build input stream: {error}"))
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
        .map_err(|error| format!("Failed to build output stream: {error}"))
}

fn mono_downmix(data: &[f32], channels: u16) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(usize::from(channels))
        .map(|frame| frame.iter().sum::<f32>() / f32::from(channels))
        .collect()
}

pub(super) fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    // A mean over audio samples tolerates the rounding of a very large count.
    let count = samples.len() as f32;
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / count).sqrt()
}

const I24_FULL_SCALE: f32 = 8_388_607.0;
const U24_MIDPOINT: f32 = 8_388_607.5;

fn i8_to_f32(sample: &i8) -> f32 {
    f32::from(*sample) / f32::from(i8::MAX)
}

fn u8_to_f32(sample: &u8) -> f32 {
    (f32::from(*sample) - f32::from(u8::MAX) / 2.0) / (f32::from(u8::MAX) / 2.0)
}

fn i16_to_f32(sample: &i16) -> f32 {
    f32::from(*sample) / f32::from(i16::MAX)
}

fn u16_to_f32(sample: &u16) -> f32 {
    (f32::from(*sample) - f32::from(u16::MAX) / 2.0) / (f32::from(u16::MAX) / 2.0)
}

fn i24_to_f32(sample: &cpal::I24) -> f32 {
    // A 24-bit value fits the f32 mantissa, so this conversion is exact.
    sample.inner() as f32 / I24_FULL_SCALE
}

fn u24_to_f32(sample: &cpal::U24) -> f32 {
    // A 24-bit value fits the f32 mantissa, so this conversion is exact.
    (sample.inner() as f32 - U24_MIDPOINT) / U24_MIDPOINT
}

fn i32_to_f32(sample: &i32) -> f32 {
    // Rounding to f32 precision is inaudible in a normalised sample.
    *sample as f32 / i32::MAX as f32
}

fn f32_to_i8(sample: f32) -> i8 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (sample * f32::from(i8::MAX)) as i8
}

fn f32_to_u8(sample: f32) -> u8 {
    // .round() so digital silence lands exactly on the format'sample equilibrium
    // instead of 1 LSB below it (a tiny DC offset).
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (sample * (f32::from(u8::MAX) / 2.0) + f32::from(u8::MAX) / 2.0).round() as u8
}

fn f32_to_i16(sample: f32) -> i16 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (sample * f32::from(i16::MAX)) as i16
}

fn f32_to_u16(sample: f32) -> u16 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    (sample * (f32::from(u16::MAX) / 2.0) + f32::from(u16::MAX) / 2.0).round() as u16
}

fn f32_to_i24(sample: f32) -> cpal::I24 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    cpal::I24::new_unchecked((sample * I24_FULL_SCALE) as i32)
}

fn f32_to_u24(sample: f32) -> cpal::U24 {
    // A float-to-int `as` saturates, clipping out-of-range samples.
    cpal::U24::new_unchecked((sample * U24_MIDPOINT + U24_MIDPOINT).round() as i32)
}

fn f32_to_i32(sample: f32) -> i32 {
    // Rounding i32::MAX to f32 and the saturating float-to-int `as` clip
    // out-of-range samples, which is the intended behaviour.
    (sample * i32::MAX as f32) as i32
}

#[cfg(test)]
mod conversion_tests {
    use super::*;

    const EPS: f32 = 1e-6;

    #[test]
    fn given_signed_integer_samples_when_converting_then_they_scale_to_full_range() {
        assert_eq!(i8_to_f32(&0), 0.0);
        assert_eq!(i8_to_f32(&i8::MAX), 1.0);
        assert!((i8_to_f32(&i8::MIN) - -1.0).abs() < 0.01);
        assert_eq!(i16_to_f32(&i16::MAX), 1.0);
        assert_eq!(i32_to_f32(&i32::MAX), 1.0);
    }

    #[test]
    fn given_unsigned_integer_samples_when_converting_then_they_are_centered_on_zero() {
        assert_eq!(u8_to_f32(&0), -1.0);
        assert_eq!(u8_to_f32(&u8::MAX), 1.0);
        assert!((u8_to_f32(&128)).abs() < 0.01);
        assert_eq!(u16_to_f32(&0), -1.0);
        assert_eq!(u16_to_f32(&u16::MAX), 1.0);
        assert!((u16_to_f32(&32768)).abs() < 1e-4);
    }

    #[test]
    fn given_i24_samples_when_converting_then_they_use_the_24_bit_full_scale() {
        assert_eq!(i24_to_f32(&cpal::I24::new(0).unwrap()), 0.0);
        assert_eq!(i24_to_f32(&cpal::I24::new(8_388_607).unwrap()), 1.0);
        assert!((i24_to_f32(&cpal::I24::new(-8_388_608).unwrap()) - -1.0).abs() < EPS);
        assert!((i24_to_f32(&cpal::I24::new(4_194_304).unwrap()) - 0.5).abs() < EPS);
    }

    #[test]
    fn given_u24_samples_when_converting_then_they_are_centered_on_equilibrium() {
        assert_eq!(u24_to_f32(&cpal::U24::new(0).unwrap()), -1.0);
        assert_eq!(u24_to_f32(&cpal::U24::new(16_777_215).unwrap()), 1.0);
        assert!((u24_to_f32(&cpal::U24::new(8_388_608).unwrap())).abs() < EPS);
    }

    #[test]
    fn given_signed_formats_when_converting_to_f32_and_back_then_they_round_trip() {
        assert_eq!(f32_to_i8(1.0), i8::MAX);
        assert_eq!(f32_to_i16(1.0), i16::MAX);
        assert_eq!(f32_to_i32(1.0), i32::MAX);
        assert_eq!(f32_to_i24(1.0).inner(), 8_388_607);
        assert_eq!(f32_to_i24(-1.0).inner(), -8_388_607);
        assert!((i24_to_f32(&f32_to_i24(0.5)) - 0.5).abs() < EPS);
    }

    #[test]
    fn given_unsigned_formats_at_equilibrium_when_converting_to_f32_and_back_then_they_round_trip()
    {
        assert_eq!(f32_to_u8(1.0), u8::MAX);
        assert_eq!(f32_to_u8(-1.0), 0);
        assert_eq!(f32_to_u8(0.0), 128);
        assert_eq!(f32_to_u16(0.0), 32768);
        assert_eq!(f32_to_u24(1.0).inner(), 16_777_215);
        assert_eq!(f32_to_u24(-1.0).inner(), 0);
        assert_eq!(f32_to_u24(0.0).inner(), 8_388_608);
    }
}

fn process_audio<R: Runtime>(data: &[f32], ctx: &StreamContext<R>) {
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
                    .map(|frame| output.read_sample(0, frame).unwrap_or(0.0))
                    .collect();
                emit_audio_level(&samples, ctx);
                ctx.buffer.lock_or_recover().extend_from_slice(&samples);
            }
            Err(error) => {
                eprintln!("Resampling error: {error}");
                return;
            }
        }
    }
}

fn emit_audio_level<R: Runtime>(samples: &[f32], ctx: &StreamContext<R>) {
    let Some(rms) = take_due_level(&ctx.sample_counter, samples) else {
        return;
    };
    let _ = ctx.app.emit(AUDIO_LEVEL_EVENT, rms);

    check_silence(rms, ctx);
}

fn take_due_level(counter: &Mutex<usize>, samples: &[f32]) -> Option<f32> {
    let mut counter = counter.lock_or_recover();
    *counter += samples.len();
    if *counter < LEVEL_EMIT_INTERVAL {
        return None;
    }
    *counter = 0;
    Some(compute_rms(samples))
}

fn check_silence<R: Runtime>(rms: f32, ctx: &StreamContext<R>) {
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
                            Ok(streams) => streams,
                            Err(error) => {
                                let _ = reply.send(Err(error));
                                continue;
                            }
                        };
                        let (input, output) = streams;
                        if let Err(error) = output.play() {
                            let _ = reply.send(Err(format!("Failed to start playback: {error}")));
                            continue;
                        }
                        match input.play() {
                            Ok(()) => {
                                active = Some((input, output));
                                let _ = reply.send(Ok(()));
                            }
                            Err(error) => {
                                let _ =
                                    reply.send(Err(format!("Failed to start microphone: {error}")));
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
            .map_err(|error| format!("Mic test thread not available: {error}"))?;
        reply_rx
            .recv()
            .map_err(|_| "Mic test thread stopped unexpectedly".to_string())?
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(TestCommand::Stop)
            .map_err(|error| format!("Mic test thread not available: {error}"))
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
    fn given_a_lower_rate_when_resampling_then_each_sample_is_held() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0]));
        let mut cursor = LoopbackCursor::new(0.5);
        let out: Vec<f32> = (0..8).map(|_| cursor.next_sample(&ring)).collect();
        assert_eq!(out, vec![0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 0.0]);
    }

    #[test]
    fn given_a_higher_rate_when_resampling_then_samples_are_dropped() {
        let ring = Mutex::new(VecDeque::from([1.0f32, 2.0, 3.0, 4.0]));
        let mut cursor = LoopbackCursor::new(2.0);
        let out: Vec<f32> = (0..3).map(|_| cursor.next_sample(&ring)).collect();
        assert_eq!(out, vec![2.0, 4.0, 0.0]);
    }

    #[test]
    fn given_more_samples_than_the_cap_when_pushing_to_the_loopback_then_the_latest_are_kept() {
        let ring = Mutex::new(VecDeque::new());
        let all: Vec<f32> = (0..LOOPBACK_MAX_SAMPLES + 100)
            .map(|sample| sample as f32)
            .collect();
        push_loopback(&ring, &all);
        let kept = ring.lock().unwrap();
        assert_eq!(kept.len(), LOOPBACK_MAX_SAMPLES);
        assert_eq!(*kept.front().unwrap(), 100.0);
        assert_eq!(*kept.back().unwrap(), (LOOPBACK_MAX_SAMPLES + 99) as f32);
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
        .map_err(|error| format!("Speaker is not available: {error}"))?;
    if config.channels() == 0 {
        return Err("Speaker reports zero output channels".into());
    }
    Ok((device, config))
}

#[cfg(test)]
mod resample_tests {
    use super::*;

    #[test]
    fn given_a_48k_sine_when_downsampling_to_16k_then_its_level_is_kept() {
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
            .map(|frame| {
                amplitude * (2.0 * std::f32::consts::PI * 440.0 * frame as f32 / 48000.0).sin()
            })
            .collect();

        let mut out = Vec::new();
        for chunk in input.as_chunks::<RESAMPLE_CHUNK_SIZE>().0 {
            let output = resampler.process(&MonoSlice(chunk), None).unwrap();
            out.extend((0..output.frames()).map(|frame| output.read_sample(0, frame).unwrap()));
        }

        let chunks = input.len() / RESAMPLE_CHUNK_SIZE;
        let expected = chunks * RESAMPLE_CHUNK_SIZE / 3;
        assert!(
            out.len() <= expected && expected - out.len() <= RESAMPLE_CHUNK_SIZE / 3,
            "got {} frames, expected ~{expected}",
            out.len()
        );

        let tail = &out[out.len() / 2..];
        let rms =
            (tail.iter().map(|sample| sample * sample).sum::<f32>() / tail.len() as f32).sqrt();
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
