// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

use slidra::server::credential::{self, CallerKind};

fn request(
    method: &str,
    url: &str,
    origin: Option<&str>,
    credential_value: Option<&str>,
) -> ureq::http::Response<ureq::Body> {
    assert_eq!(method, "GET");
    let mut request = ureq::get(url);
    if let Some(value) = origin {
        request = request.header("Origin", value);
    }
    if let Some(value) = credential_value {
        request = request.header(credential::CREDENTIAL_HEADER, value);
    }
    request
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .expect("request must be sent")
}

#[test]
fn browser_origin_is_exact_and_preflight_never_needs_a_credential() {
    let editor_origin = "http://editor.test:3000";
    let addr = slidra::server::test_support::spawn_test_server_with_editor_origin(editor_origin);
    let base = format!("http://{addr}");

    let preflight = ureq::options(format!("{base}/presentation"))
        .header("Origin", editor_origin)
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "x-slidra-credential")
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .unwrap();
    assert_eq!(preflight.status().as_u16(), 204);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        editor_origin
    );
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-methods")
            .unwrap(),
        "GET, POST, OPTIONS"
    );
    assert!(
        preflight
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("x-slidra-credential")
    );
    assert_eq!(preflight.headers().get("vary").unwrap(), "Origin");

    let credential_value = credential::encode(CallerKind::Editor, "wb-cors");
    let accepted = request(
        "GET",
        &format!("{base}/editing"),
        Some(editor_origin),
        Some(&credential_value),
    );
    assert_eq!(accepted.status().as_u16(), 404);
    assert_eq!(
        accepted
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        editor_origin
    );
    assert_eq!(accepted.headers().get("vary").unwrap(), "Origin");

    let wrong = request(
        "GET",
        &format!("{base}/editing"),
        Some("http://evil.test"),
        Some(&credential_value),
    );
    assert_eq!(wrong.status().as_u16(), 403);
    assert!(wrong.headers().get("access-control-allow-origin").is_none());

    let opaque = request(
        "GET",
        &format!("{base}/editing"),
        Some("null"),
        Some(&credential_value),
    );
    assert_eq!(opaque.status().as_u16(), 403);

    let cli = request(
        "GET",
        &format!("{base}/editing"),
        None,
        Some(&credential_value),
    );
    assert_eq!(cli.status().as_u16(), 404);
    assert!(cli.headers().get("access-control-allow-origin").is_none());
}

#[test]
fn browser_preflight_allows_the_open_file_header() {
    let editor_origin = "http://editor.test:3000";
    let addr = slidra::server::test_support::spawn_test_server_with_editor_origin(editor_origin);
    let base = format!("http://{addr}");

    let preflight = ureq::options(format!("{base}/open"))
        .header("Origin", editor_origin)
        .header("Access-Control-Request-Method", "POST")
        .header(
            "Access-Control-Request-Headers",
            "content-type, x-slidra-file-name, x-slidra-credential",
        )
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .unwrap();

    assert_eq!(preflight.status().as_u16(), 204);
    assert!(
        preflight
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .split(',')
            .any(|name| name.trim().eq_ignore_ascii_case("x-slidra-file-name"))
    );
}
