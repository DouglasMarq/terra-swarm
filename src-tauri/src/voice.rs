pub mod audio;
pub mod models;
pub mod transcriber;

use crate::sync::LockExt;
use audio::AudioController;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use transcriber::Transcriber;

/// Room for a batch of `/dev/snd` inotify events.
#[cfg(target_os = "linux")]
const INOTIFY_BUFFER_BYTES: usize = 4096;
/// Wait after a `/dev/snd` change so the burst of events settles first.
#[cfg(target_os = "linux")]
const DEVICE_SETTLE_DELAY: std::time::Duration = std::time::Duration::from_millis(500);
/// How often the microphone is checked where `/dev/snd` can't be watched.
#[cfg(not(target_os = "linux"))]
const MIC_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// Downloaded chunks waiting for the writer thread.
const DOWNLOAD_QUEUE_CHUNKS: usize = 64;

pub struct VoiceState {
    pub recording: Mutex<bool>,
    pub audio_buffer: Arc<Mutex<Vec<f32>>>,
    pub active_model_id: Mutex<Option<String>>,
    pub language: Mutex<String>,
    pub input_device: Mutex<Option<String>>,
    pub transcriber: Mutex<Option<Arc<Transcriber>>>,
    pub downloading: Mutex<std::collections::HashSet<String>>,
}

impl Default for VoiceState {
    fn default() -> Self {
        Self {
            recording: Mutex::new(false),
            audio_buffer: Arc::new(Mutex::new(Vec::new())),
            active_model_id: Mutex::new(None),
            language: Mutex::new("auto".into()),
            input_device: Mutex::new(None),
            transcriber: Mutex::new(None),
            downloading: Mutex::new(std::collections::HashSet::new()),
        }
    }
}

#[derive(serde::Serialize)]
pub struct VoiceModelInfo {
    id: String,
    display_name: String,
    size_label: String,
    description: String,
    downloaded: bool,
    active: bool,
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    model_id: String,
    downloaded: u64,
    total: u64,
    percent: f64,
}

/// Load a Whisper context, preferring GPU and falling back to CPU when the
/// GPU context fails to initialize.
#[cfg(not(target_os = "windows"))]
fn load_transcriber(path: &Path) -> Result<Transcriber, String> {
    match Transcriber::new(path, true) {
        Ok(t) => Ok(t),
        Err(gpu_err) => {
            eprintln!("GPU model load failed, retrying on CPU: {gpu_err}");
            Transcriber::new(path, false)
        }
    }
}

#[cfg(target_os = "windows")]
fn load_transcriber(path: &Path) -> Result<Transcriber, String> {
    Transcriber::new(path, false)
}

fn activate_model(app: &tauri::AppHandle, model_id: &str, path: PathBuf) -> Result<(), String> {
    let transcriber = load_transcriber(&path)?;
    let state = app.state::<VoiceState>();
    *state.transcriber.lock_or_recover() = Some(Arc::new(transcriber));
    *state.active_model_id.lock_or_recover() = Some(model_id.to_string());
    let _ = app.emit("voice-model-changed", model_id);
    Ok(())
}

fn start_recording_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<VoiceState>();
    // Held across check-and-start so two rapid toggles can't both start.
    let mut recording = state.recording.lock_or_recover();
    if *recording {
        return Err("Already recording".into());
    }
    if state.transcriber.lock_or_recover().is_none() {
        let msg = "No voice model loaded — download and select a model in Settings";
        let _ = app.emit("voice-recording-error", msg);
        return Err(msg.into());
    }
    let controller = app.state::<AudioController>();
    let device = state.input_device.lock_or_recover().clone();

    state.audio_buffer.lock_or_recover().clear();
    if let Err(e) = controller.start(state.audio_buffer.clone(), app.clone(), device) {
        let _ = app.emit("voice-recording-error", &e);
        return Err(e);
    }
    *recording = true;
    let _ = app.emit("voice-recording-started", ());
    Ok(())
}

pub fn stop_recording_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<VoiceState>();
    {
        let mut recording = state.recording.lock_or_recover();
        if !*recording {
            return Err("Not recording".into());
        }
        // Clear unconditionally: if the audio thread died, stop() will fail
        // forever and the flag must not leave the app stuck in "recording".
        *recording = false;
    }
    let controller = app.state::<AudioController>();

    if let Err(e) = controller.stop() {
        eprintln!("audio stop failed: {}", e);
        let _ = app.emit("voice-recording-error", &e);
    }
    let _ = app.emit("voice-recording-stopped", ());

    let audio_data = std::mem::take(&mut *state.audio_buffer.lock_or_recover());
    let language = state.language.lock_or_recover().clone();
    let transcriber = state.transcriber.lock_or_recover().clone();

    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _ = app_handle.emit("voice-transcription-started", ());
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &transcriber {
                Some(t) => t.transcribe(&audio_data, &language),
                None => Err("No model loaded".into()),
            }));
        match result {
            Ok(Ok(text)) => {
                let _ = app_handle.emit("voice-transcription-complete", text);
            }
            Ok(Err(e)) => {
                let _ = app_handle.emit("voice-transcription-error", e);
            }
            Err(_) => {
                let _ = app_handle.emit(
                    "voice-transcription-error",
                    "Transcription failed unexpectedly",
                );
            }
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn voice_toggle_recording(app: tauri::AppHandle) -> Result<(), String> {
    let recording = *app.state::<VoiceState>().recording.lock_or_recover();
    match recording {
        true => stop_recording_impl(&app),
        false => start_recording_impl(&app),
    }
}

#[tauri::command]
pub fn voice_set_language(language: String, state: tauri::State<'_, VoiceState>) {
    *state.language.lock_or_recover() = language;
}

#[tauri::command]
pub async fn voice_mic_available() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(audio::has_input_device)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_list_input_devices() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(audio::list_input_devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_set_input_device(device: Option<String>, state: tauri::State<'_, VoiceState>) {
    *state.input_device.lock_or_recover() = device;
}

/// Start capturing the given device and playing it back through the
/// speakers (plus streaming `voice-audio-level` for the settings UI meter),
/// so the user can hear and see whether a device — whose OS-reported name
/// doesn't always match what's on the box — is actually picking up sound.
/// Runs on its own stream pair, entirely separate from the real recording
/// path, so it can never clobber or be clobbered by an active transcription.
#[tauri::command]
pub async fn voice_test_mic_start(
    device: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<audio::MicTestController>()
            .start(device, app.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_test_mic_stop(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<audio::MicTestController>().stop())
        .await
        .map_err(|e| e.to_string())?
}

/// Check the current mic state and, when it changed, emit `voice-mic-changed`.
/// Stops an active recording if the microphone disappeared.
fn emit_if_mic_changed(app: &tauri::AppHandle, last: &mut Option<bool>) {
    let available = audio::has_input_device();
    if *last == Some(available) {
        return;
    }
    *last = Some(available);
    let _ = app.emit("voice-mic-changed", available);
    if !available && *app.state::<VoiceState>().recording.lock_or_recover() {
        if let Err(error) = stop_recording_impl(app) {
            eprintln!(
                "failed to stop recording after the mic disappeared: {}",
                error
            );
        }
    }
}

#[cfg(target_os = "linux")]
pub fn watch_input_devices(app: tauri::AppHandle) {
    use std::ffi::CString;

    std::thread::spawn(move || {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
        if fd < 0 {
            return;
        }

        let Ok(path) = CString::new("/dev/snd") else {
            unsafe { libc::close(fd) };
            return;
        };
        let wd = unsafe {
            libc::inotify_add_watch(fd, path.as_ptr(), libc::IN_CREATE | libc::IN_DELETE)
        };
        if wd < 0 {
            unsafe { libc::close(fd) };
            return;
        }

        let mut last: Option<bool> = None;
        let mut buf = [0u8; INOTIFY_BUFFER_BYTES];
        loop {
            let len = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if len <= 0 {
                break;
            }

            std::thread::sleep(DEVICE_SETTLE_DELAY);

            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
                while libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) > 0 {}
                libc::fcntl(fd, libc::F_SETFL, flags);
            }

            emit_if_mic_changed(&app, &mut last);
        }

        unsafe { libc::close(fd) };
    });
}

#[cfg(not(target_os = "linux"))]
pub fn watch_input_devices(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            emit_if_mic_changed(&app, &mut last);
            std::thread::sleep(MIC_POLL_INTERVAL);
        }
    });
}

#[tauri::command(async)]
pub fn voice_list_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, VoiceState>,
) -> Result<Vec<VoiceModelInfo>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let downloaded = models::downloaded_model_ids(&data_dir);
    let active = state.active_model_id.lock_or_recover().clone();
    Ok(models::available_models()
        .into_iter()
        .map(|m| VoiceModelInfo {
            id: m.id.to_string(),
            display_name: m.display_name.to_string(),
            size_label: m.size_label.to_string(),
            description: m.description.to_string(),
            downloaded: downloaded.iter().any(|d| d == m.id),
            active: active.as_deref() == Some(m.id),
        })
        .collect())
}

#[tauri::command]
pub async fn voice_set_model(model_id: String, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {e}"))?;
        let path = models::model_path(&data_dir, &model_id).ok_or("Model is not downloaded yet")?;
        activate_model(&app, &model_id, path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_download_model(model_id: String, app: tauri::AppHandle) -> Result<(), String> {
    // Per-model in-progress guard: two concurrent downloads of the same model
    // would interleave writes into the shared .tmp file and corrupt it.
    {
        let state = app.state::<VoiceState>();
        let mut dl = state.downloading.lock_or_recover();
        if !dl.insert(model_id.clone()) {
            return Err(format!("Download of {} is already in progress", model_id));
        }
    }
    let result = download_model_impl(model_id.clone(), app.clone()).await;
    app.state::<VoiceState>()
        .downloading
        .lock_or_recover()
        .remove(&model_id);
    result
}

async fn download_model_impl(model_id: String, app: tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;

    let model = models::find_model(&model_id).ok_or("Unknown model ID")?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    let dir = models::models_dir(&data_dir);
    let model_path = dir.join(model.filename);
    let tmp_path = dir.join(format!("{}.tmp", model.filename));

    let is_downloaded = {
        let model_path = model_path.clone();
        run_blocking(move || {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create models dir: {e}"))?;
            Ok(model_path.exists())
        })
        .await?
    };

    if !is_downloaded {
        let response = reqwest::get(model.url)
            .await
            .map_err(|e| format!("Download failed: {e}"))?;

        let total = response.content_length().unwrap_or(model.size_bytes);
        let mut downloaded: u64 = 0;
        let mut last_percent: u64 = 0;
        let mut download_error: Option<String> = None;

        let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel(DOWNLOAD_QUEUE_CHUNKS);
        let writer = {
            let tmp_path = tmp_path.clone();
            tauri::async_runtime::spawn_blocking(move || write_chunks(&tmp_path, chunk_rx))
        };

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    download_error = Some(format!("Download error: {e}"));
                    break;
                }
            };
            let chunk_bytes = chunk.len() as u64;
            if chunk_tx.send(chunk).await.is_err() {
                break;
            }

            downloaded += chunk_bytes;
            let percent = match total > 0 {
                true => ((downloaded as f64 / total as f64 * 100.0).min(100.0)) as u64,
                false => 0,
            };

            if percent > last_percent {
                last_percent = percent;
                let _ = app.emit(
                    "voice-model-download-progress",
                    DownloadProgress {
                        model_id: model_id.clone(),
                        downloaded,
                        total,
                        percent: percent as f64,
                    },
                );
            }
        }
        drop(chunk_tx);

        let written = writer
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result.map_err(|e| format!("Write error: {e}")));
        let outcome = match (download_error, written) {
            (Some(error), _) | (None, Err(error)) => Err(error),
            (None, Ok(())) if downloaded < total => Err(format!(
                "Download incomplete: got {downloaded} of {total} bytes"
            )),
            (None, Ok(())) => Ok(()),
        };

        let model_path = model_path.clone();
        let filename = model.filename;
        run_blocking(move || match outcome {
            Ok(()) => std::fs::rename(&tmp_path, &model_path)
                .map_err(|e| format!("Failed to finalize download: {e}")),
            Err(error) => {
                if let Err(remove_error) = std::fs::remove_file(&tmp_path) {
                    eprintln!(
                        "failed to remove the partial download of {filename}: {remove_error}"
                    );
                }
                Err(error)
            }
        })
        .await?;
    }

    let app2 = app.clone();
    let id = model_id.clone();
    run_blocking(move || activate_model(&app2, &id, model_path)).await?;

    let _ = app.emit("voice-model-download-complete", &model_id);
    Ok(())
}

/// Writes every chunk received to a new file at `path` until the sender is
/// dropped. Blocking: runs on its own thread while the download streams.
fn write_chunks<C: AsRef<[u8]>>(
    path: &Path,
    mut chunks: tokio::sync::mpsc::Receiver<C>,
) -> std::io::Result<()> {
    use std::io::Write;

    let mut file = std::fs::File::create(path)?;
    while let Some(chunk) = chunks.blocking_recv() {
        file.write_all(chunk.as_ref())?;
    }
    file.flush()
}

/// Runs blocking file work off the async runtime.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::write_chunks;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-voice-{}-{}-{}",
            name,
            std::process::id(),
            crate::mcp::repo::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn given_queued_chunks_writes_them_in_order_to_the_file() {
        let dir = temp_dir("chunks");
        let path = dir.join("model.bin.tmp");
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        sender.try_send(b"whis".to_vec()).unwrap();
        sender.try_send(b"per".to_vec()).unwrap();
        drop(sender);

        write_chunks(&path, receiver).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"whisper");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_missing_folder_reports_the_write_error() {
        let dir = temp_dir("missing");
        let path = dir.join("absent").join("model.bin.tmp");
        let (sender, receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        drop(sender);

        assert!(write_chunks(&path, receiver).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
