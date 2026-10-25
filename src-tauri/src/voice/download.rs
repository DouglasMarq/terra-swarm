use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DOWNLOAD_QUEUE_CHUNKS: usize = 64;
const FULL_PERCENT: u64 = 100;

#[derive(Clone, Copy, Debug)]
pub(super) struct Timeouts {
    pub connect: Duration,
    pub read: Duration,
}

pub(super) const DOWNLOAD_TIMEOUTS: Timeouts = Timeouts {
    connect: Duration::from_secs(30),
    read: Duration::from_secs(60),
};

pub(super) fn client(timeouts: Timeouts) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(timeouts.connect)
        .read_timeout(timeouts.read)
        .build()
        .map_err(|error| format!("Failed to create the download client: {error}"))
}

pub(super) struct DownloadRequest<'a> {
    pub url: &'a str,
    pub expected_size: u64,
    pub expected_sha256: &'a str,
    pub final_path: PathBuf,
    pub partial_path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Progress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
}

struct ProgressReporter<F: FnMut(Progress)> {
    total: u64,
    last_percent: u8,
    on_progress: F,
}

impl<F: FnMut(Progress)> ProgressReporter<F> {
    fn record(&mut self, downloaded: u64) {
        let percent = percent_of(downloaded, self.total);
        if percent <= self.last_percent {
            return;
        }
        self.last_percent = percent;
        (self.on_progress)(Progress {
            downloaded,
            total: self.total,
            percent,
        });
    }
}

pub(super) async fn download_file(
    client: &reqwest::Client,
    request: DownloadRequest<'_>,
    on_progress: impl FnMut(Progress),
) -> Result<(), String> {
    let outcome = stream_to_partial(client, &request, on_progress).await;
    super::run_blocking(move || finalize(&request.partial_path, &request.final_path, outcome)).await
}

async fn stream_to_partial(
    client: &reqwest::Client,
    request: &DownloadRequest<'_>,
    on_progress: impl FnMut(Progress),
) -> Result<(), String> {
    let response = client
        .get(request.url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("Download failed: {error}"))?;
    let total = response.content_length().unwrap_or(request.expected_size);
    let mut reporter = ProgressReporter {
        total,
        last_percent: 0,
        on_progress,
    };

    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel(DOWNLOAD_QUEUE_CHUNKS);
    let writer = {
        let partial_path = request.partial_path.clone();
        tauri::async_runtime::spawn_blocking(move || write_chunks(&partial_path, chunk_rx))
    };
    let streamed = forward_chunks(response.bytes_stream(), chunk_tx, &mut reporter).await;
    let written = writer
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| format!("Write error: {error}")));
    let downloaded = streamed?;
    let digest = written?;
    if downloaded < total {
        return Err(format!(
            "Download incomplete: got {downloaded} of {total} bytes"
        ));
    }
    verify_sha256(&digest, request.expected_sha256)
}

fn verify_sha256(actual: &str, expected: &str) -> Result<(), String> {
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    Err(format!(
        "Checksum mismatch: expected SHA-256 {expected}, got {actual}"
    ))
}

async fn forward_chunks<C: AsRef<[u8]>, E: std::fmt::Display>(
    stream: impl futures_util::Stream<Item = Result<C, E>>,
    chunk_tx: tokio::sync::mpsc::Sender<C>,
    reporter: &mut ProgressReporter<impl FnMut(Progress)>,
) -> Result<u64, String> {
    let mut downloaded: u64 = 0;
    let mut stream = std::pin::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Download error: {error}"))?;
        let chunk_bytes = u64::try_from(chunk.as_ref().len()).unwrap_or(u64::MAX);
        if chunk_tx.send(chunk).await.is_err() {
            break;
        }
        downloaded = downloaded.saturating_add(chunk_bytes);
        reporter.record(downloaded);
    }
    Ok(downloaded)
}

fn percent_of(downloaded: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let percent = (downloaded.saturating_mul(FULL_PERCENT) / total).min(FULL_PERCENT);
    u8::try_from(percent).unwrap_or(u8::MAX)
}

fn finalize(
    partial_path: &Path,
    final_path: &Path,
    outcome: Result<(), String>,
) -> Result<(), String> {
    let Err(error) = outcome else {
        return std::fs::rename(partial_path, final_path)
            .map_err(|error| format!("Failed to finalize download: {error}"));
    };
    if let Err(remove_error) = std::fs::remove_file(partial_path) {
        eprintln!(
            "failed to remove the partial download {}: {remove_error}",
            partial_path.display()
        );
    }
    Err(error)
}

fn write_chunks<C: AsRef<[u8]>>(
    path: &Path,
    mut chunks: tokio::sync::mpsc::Receiver<C>,
) -> std::io::Result<String> {
    use sha2::Digest;
    use std::io::Write;

    let mut file = std::fs::File::create(path)?;
    let mut hasher = sha2::Sha256::new();
    while let Some(chunk) = chunks.blocking_recv() {
        file.write_all(chunk.as_ref())?;
        hasher.update(chunk.as_ref());
    }
    file.flush()?;
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        client, download_file, percent_of, to_hex, write_chunks, DownloadRequest, Progress,
        Timeouts,
    };
    use sha2::Digest;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    const REQUEST_BUFFER_BYTES: usize = 4096;
    const SERVER_STALL: Duration = Duration::from_secs(10);
    const SHORT_TIMEOUTS: Timeouts = Timeouts {
        connect: Duration::from_secs(1),
        read: Duration::from_millis(200),
    };
    const MODEL_BYTES: &[u8] = b"whisper model bytes";
    const OK_STATUS: &str = "200 OK";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-voice-{}-{}-{}",
            name,
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha256_of(bytes: &[u8]) -> String {
        to_hex(&sha2::Sha256::digest(bytes))
    }

    struct Reply {
        status: &'static str,
        declared_length: usize,
        body: &'static [u8],
        stall: Duration,
    }

    fn complete_reply(body: &'static [u8]) -> Reply {
        Reply {
            status: OK_STATUS,
            declared_length: body.len(),
            body,
            stall: Duration::ZERO,
        }
    }

    fn serve_once(reply: Reply) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; REQUEST_BUFFER_BYTES];
            let _ = socket.read(&mut request);
            let head = format!(
                "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.status, reply.declared_length
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(reply.body);
            std::thread::sleep(reply.stall);
        });
        format!("http://{address}/ggml-test.bin")
    }

    fn request_for<'a>(url: &'a str, dir: &Path, sha256: &'a str) -> DownloadRequest<'a> {
        DownloadRequest {
            url,
            expected_size: 0,
            expected_sha256: sha256,
            final_path: dir.join("ggml-test.bin"),
            partial_path: dir.join("ggml-test.bin.tmp"),
        }
    }

    fn has_left_no_file(dir: &Path) -> bool {
        !dir.join("ggml-test.bin").exists() && !dir.join("ggml-test.bin.tmp").exists()
    }

    #[test]
    fn given_a_complete_response_with_the_expected_sha256_when_downloading_then_the_file_lands() {
        let dir = temp_dir("complete");
        let url = serve_once(complete_reply(MODEL_BYTES));
        let sha256 = sha256_of(MODEL_BYTES);
        let mut reports: Vec<Progress> = Vec::new();

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir, &sha256),
            |progress| reports.push(progress),
        ));

        assert_eq!(result, Ok(()));
        assert_eq!(
            std::fs::read(dir.join("ggml-test.bin")).unwrap(),
            MODEL_BYTES
        );
        assert!(!dir.join("ggml-test.bin.tmp").exists());
        assert_eq!(reports.last().map(|progress| progress.percent), Some(100));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_response_with_another_sha256_when_downloading_then_it_fails_and_deletes_the_file() {
        let dir = temp_dir("mismatch");
        let url = serve_once(complete_reply(MODEL_BYTES));
        let other = sha256_of(b"something else");

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir, &other),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Checksum mismatch")));
        assert!(has_left_no_file(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_an_error_status_when_downloading_then_it_fails_without_writing_a_file() {
        let dir = temp_dir("status");
        let url = serve_once(Reply {
            status: "404 Not Found",
            ..complete_reply(b"missing")
        });

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir, &sha256_of(b"missing")),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Download failed")));
        assert!(has_left_no_file(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_truncated_response_when_downloading_then_it_fails_and_removes_the_partial_file() {
        let dir = temp_dir("truncated");
        let url = serve_once(Reply {
            declared_length: 100,
            ..complete_reply(b"short")
        });

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir, &sha256_of(b"short")),
            |_| {},
        ));

        assert!(result.is_err());
        assert!(has_left_no_file(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_server_that_stalls_mid_body_when_downloading_then_the_read_timeout_ends_it() {
        let dir = temp_dir("stalled");
        let url = serve_once(Reply {
            declared_length: 100,
            stall: SERVER_STALL,
            ..complete_reply(b"partial")
        });
        let started = Instant::now();

        let result = tauri::async_runtime::block_on(download_file(
            &client(SHORT_TIMEOUTS).unwrap(),
            request_for(&url, &dir, &sha256_of(b"partial")),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Download error")));
        assert!(started.elapsed() < SERVER_STALL);
        assert!(has_left_no_file(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_an_unreachable_server_when_downloading_then_it_reports_the_failure() {
        let dir = temp_dir("unreachable");
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap()
        };
        let url = format!("http://{closed}/ggml-test.bin");

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir, &sha256_of(MODEL_BYTES)),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Download failed")));
        assert!(has_left_no_file(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_byte_counts_when_computing_the_percent_then_it_is_floored_and_capped() {
        assert_eq!(percent_of(0, 0), 0);
        assert_eq!(percent_of(1, 3), 33);
        assert_eq!(percent_of(3, 3), 100);
        assert_eq!(percent_of(5, 3), 100);
    }

    #[test]
    fn given_queued_chunks_when_writing_then_they_are_written_in_order_and_hashed() {
        let dir = temp_dir("chunks");
        let path = dir.join("model.bin.tmp");
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        sender.try_send(b"whis".to_vec()).unwrap();
        sender.try_send(b"per".to_vec()).unwrap();
        drop(sender);

        let digest = write_chunks(&path, receiver).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"whisper");
        assert_eq!(digest, sha256_of(b"whisper"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_missing_folder_when_writing_then_it_reports_the_write_error() {
        let dir = temp_dir("missing");
        let path = dir.join("absent").join("model.bin.tmp");
        let (sender, receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        drop(sender);

        assert!(write_chunks(&path, receiver).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
