//! Minimal MCP over Streamable-HTTP (stateless): a single `POST /mcp`
//! endpoint speaking JSON-RPC 2.0. We respond with `application/json`
//! (no SSE / session id needed for a request/response tool server).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use super::{tools, McpState};

/// MCP protocol revision we implement.
const PROTOCOL_VERSION: &str = "2024-11-05";

pub async fn handle(State(st): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    // Bearer-token auth — required on every request.
    let want = format!("Bearer {}", st.token);
    let authorized = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == want)
        .unwrap_or(false);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_error(Value::Null, -32700, &format!("parse error: {e}")).into_response()
        }
    };

    let has_id = req.get("id").is_some();
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => json_result(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "deploytools", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .into_response(),

        // Notifications carry no id and expect no response body.
        m if m.starts_with("notifications/") => StatusCode::ACCEPTED.into_response(),

        "ping" => json_result(id, json!({})).into_response(),

        "tools/list" => json_result(id, json!({ "tools": tools::list() })).into_response(),

        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match tools::call(&st.app, &name, arguments).await {
                Ok(text) => json_result(
                    id,
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                )
                .into_response(),
                Err(text) => json_result(
                    id,
                    json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
                )
                .into_response(),
            }
        }

        _ => {
            if has_id {
                json_error(id, -32601, &format!("method not found: {method}")).into_response()
            } else {
                StatusCode::ACCEPTED.into_response()
            }
        }
    }
}

fn json_result(id: Value, result: Value) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn json_error(id: Value, code: i64, message: &str) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
}
