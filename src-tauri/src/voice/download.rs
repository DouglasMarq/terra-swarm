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
        .map_err(|e| format!("Failed to create the download client: {e}"))
}

pub(super) struct DownloadRequest<'a> {
    pub url: &'a str,
    pub expected_size: u64,
    pub final_path: PathBuf,
    pub partial_path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Progress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
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
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = response.content_length().unwrap_or(request.expected_size);

    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel(DOWNLOAD_QUEUE_CHUNKS);
    let writer = {
        let partial_path = request.partial_path.clone();
        tauri::async_runtime::spawn_blocking(move || write_chunks(&partial_path, chunk_rx))
    };
    let streamed = forward_chunks(response.bytes_stream(), chunk_tx, total, on_progress).await;
    let written = writer
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| format!("Write error: {e}")));
    let downloaded = streamed?;
    written?;
    match downloaded < total {
        true => Err(format!(
            "Download incomplete: got {downloaded} of {total} bytes"
        )),
        false => Ok(()),
    }
}

async fn forward_chunks<C: AsRef<[u8]>, E: std::fmt::Display>(
    stream: impl futures_util::Stream<Item = Result<C, E>>,
    chunk_tx: tokio::sync::mpsc::Sender<C>,
    total: u64,
    mut on_progress: impl FnMut(Progress),
) -> Result<u64, String> {
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut stream = std::pin::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {e}"))?;
        let chunk_bytes = u64::try_from(chunk.as_ref().len()).unwrap_or(u64::MAX);
        if chunk_tx.send(chunk).await.is_err() {
            break;
        }
        downloaded = downloaded.saturating_add(chunk_bytes);
        let percent = percent_of(downloaded, total);
        if percent > last_percent {
            last_percent = percent;
            on_progress(Progress {
                downloaded,
                total,
                percent,
            });
        }
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
            .map_err(|e| format!("Failed to finalize download: {e}"));
    };
    if let Err(remove_error) = std::fs::remove_file(partial_path) {
        eprintln!(
            "failed to remove the partial download {}: {remove_error}",
            partial_path.display()
        );
    }
    Err(error)
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

#[cfg(test)]
mod tests {
    use super::{
        client, download_file, percent_of, write_chunks, DownloadRequest, Progress, Timeouts,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    const REQUEST_BUFFER_BYTES: usize = 4096;
    const SERVER_STALL: Duration = Duration::from_secs(10);
    const SHORT_TIMEOUTS: Timeouts = Timeouts {
        connect: Duration::from_secs(1),
        read: Duration::from_millis(200),
    };

    #[test]
    fn given_a_server_that_stalls_mid_body_when_downloading_then_the_read_timeout_ends_it() {
        let dir = temp_dir("stalled");
        let url = serve_once(Reply {
            declared_length: 100,
            body: b"partial".to_vec(),
            stall: SERVER_STALL,
        });
        let started = Instant::now();

        let result = tauri::async_runtime::block_on(download_file(
            &client(SHORT_TIMEOUTS).unwrap(),
            request_for(&url, &dir),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Download error")));
        assert!(started.elapsed() < SERVER_STALL);
        assert!(!dir.join("ggml-test.bin.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "terra-voice-{}-{}-{}",
            name,
            std::process::id(),
            crate::mcp::repo::now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Reply {
        declared_length: usize,
        body: Vec<u8>,
        stall: Duration,
    }

    fn serve_once(reply: Reply) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; REQUEST_BUFFER_BYTES];
            let _ = socket.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.declared_length
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(&reply.body);
            std::thread::sleep(reply.stall);
        });
        format!("http://{address}/ggml-test.bin")
    }

    fn request_for<'a>(url: &'a str, dir: &std::path::Path) -> DownloadRequest<'a> {
        DownloadRequest {
            url,
            expected_size: 0,
            final_path: dir.join("ggml-test.bin"),
            partial_path: dir.join("ggml-test.bin.tmp"),
        }
    }

    #[test]
    fn given_a_complete_response_when_downloading_then_the_file_lands_and_progress_reaches_100() {
        let dir = temp_dir("complete");
        let body = b"whisper model bytes".to_vec();
        let url = serve_once(Reply {
            declared_length: body.len(),
            body: body.clone(),
            stall: Duration::ZERO,
        });
        let mut reports: Vec<Progress> = Vec::new();

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir),
            |progress| reports.push(progress),
        ));

        assert_eq!(result, Ok(()));
        assert_eq!(std::fs::read(dir.join("ggml-test.bin")).unwrap(), body);
        assert!(!dir.join("ggml-test.bin.tmp").exists());
        assert_eq!(reports.last().map(|progress| progress.percent), Some(100));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_a_truncated_response_when_downloading_then_it_fails_and_removes_the_partial_file() {
        let dir = temp_dir("truncated");
        let url = serve_once(Reply {
            declared_length: 100,
            body: b"short".to_vec(),
            stall: Duration::ZERO,
        });

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&url, &dir),
            |_| {},
        ));

        assert!(result.is_err());
        assert!(!dir.join("ggml-test.bin").exists());
        assert!(!dir.join("ggml-test.bin.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn given_an_unreachable_server_when_downloading_then_it_reports_the_failure() {
        let dir = temp_dir("unreachable");
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap()
        };

        let result = tauri::async_runtime::block_on(download_file(
            &reqwest::Client::new(),
            request_for(&format!("http://{closed}/ggml-test.bin"), &dir),
            |_| {},
        ));

        assert!(result.is_err_and(|error| error.starts_with("Download failed")));
        assert!(!dir.join("ggml-test.bin").exists());
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
