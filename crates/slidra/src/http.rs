//! Minimal HTTP GET for `asset import <url>` — the only user of the `ureq`
//! dependency in this crate. Ported from the private `downloadSource`
//! helper at the bottom of `packages/cli/src/commands/asset-import.ts`
//! (its `Response`/`fetch`-based body), stripped of the `maxBytes`
//! parameter (plan §2.1 item 8: `maxBytes` is only used by
//! `POST /api/asset`, out of this ticket's scope — the CLI call path never
//! passes it, so this port takes no size limit at all).
//!
//! Deliberately does NOT read `HTTP_PROXY`/`HTTPS_PROXY` (plan §2.1 item 9,
//! §3.5): Node's `fetch` does not consult those either, so leaving this
//! client proxy-blind is behavior parity, not an oversight. Loopback tests
//! (`tests` module below) are how the URL path is exercised without relying
//! on any real network egress being reachable from this sandbox.

use crate::errors::{SlidraError, SlidraResult};
use std::io::Read;

/// Downloads `url` via a single synchronous GET and returns the response
/// body bytes.
///
/// - Connection/DNS failure (the request never got a response at all) ->
///   `failed`, "Unable to download source: <url>".
/// - A response was received but its status is not 2xx -> `failed`,
///   "Unable to download source, server responded <status>: <url>".
/// - 2xx -> the body bytes, in full (no size cap — see module doc).
pub fn download_source(url: &str) -> SlidraResult<Vec<u8>> {
    match ureq::get(url).call() {
        Ok(response) => {
            let mut bytes = Vec::new();
            response
                .into_reader()
                .read_to_end(&mut bytes)
                .map_err(|_| SlidraError::invalid(format!("failed to download source: {url}")))?;
            Ok(bytes)
        }
        Err(ureq::Error::Status(status, _response)) => Err(SlidraError::invalid(format!(
            "failed to download source, server responded {status}: {url}"
        ))),
        Err(ureq::Error::Transport(_)) => Err(SlidraError::invalid(format!(
            "failed to download source: {url}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// Starts a loopback HTTP/1.1 server that accepts exactly one
    /// connection and writes back `response` verbatim (status line +
    /// headers + body, hand-assembled by the caller), then shuts down.
    /// Sandbox egress to arbitrary external hosts is not guaranteed (plan
    /// §6.3), so `download_source`'s URL path is exercised entirely
    /// against this loopback server rather than any real external URL.
    fn serve_once(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("local_addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Drain the request so the client's write doesn't block on
                // a full socket buffer; the tiny fixed-size read is enough
                // for GET requests this test issues.
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn http_response(status_line: &str, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(status_line.as_bytes());
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
        out.extend_from_slice(b"Connection: close\r\n");
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn downloads_body_bytes_on_200() {
        let body = b"hello from loopback";
        let response = http_response("HTTP/1.1 200 OK", body);
        let base = serve_once(response);
        let url = format!("{base}/ok");

        let bytes = download_source(&url).unwrap();
        assert_eq!(bytes, body);
    }

    #[test]
    fn non_2xx_status_is_failed_with_status_code_in_message() {
        let response = http_response("HTTP/1.1 404 Not Found", b"nope");
        let base = serve_once(response);
        let url = format!("{base}/missing");

        let err = download_source(&url).unwrap_err();
        assert_eq!(
            err.message(),
            format!("failed to download source, server responded 404: {url}")
        );
    }

    #[test]
    fn connection_failure_is_failed_with_generic_message() {
        // Bind then immediately drop the listener so the port is (almost
        // certainly) refused on connect — a real connection failure, not a
        // 4xx/5xx response.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("local_addr");
        drop(listener);

        let url = format!("http://{addr}/unreachable");
        let err = download_source(&url).unwrap_err();
        assert_eq!(err.message(), format!("failed to download source: {url}"));
    }
}
