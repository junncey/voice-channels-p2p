//! HTTP 服务：5 个端点（页面 / 进程列表 / 状态 / 采集启停 / PCM 流），
//! 全部响应带 CORS（频道页 http(s) → 127.0.0.1 直连用）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use tokio::sync::broadcast;

use crate::sessions::SessionWorker;
use crate::state::{App, CHANNELS, SAMPLE_RATE};

/// 内置试听页面
const PAGE: &str = include_str!("page.html");

/// 应用列表缓存时长：页面 3s 自动刷新时不重算会话枚举
const APPS_CACHE_MS: u64 = 1500;

pub struct HttpState {
    pub app: Arc<App>,
    pub sessions: SessionWorker,
}

pub fn router(app: Arc<App>, sessions: SessionWorker) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/processes", get(processes))
        .route("/api/status", get(status))
        .route("/stream", get(stream))
        .route("/api/start", post(start))
        .route("/api/stop", post(stop))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(Arc::new(HttpState { app, sessions }))
}

/// 频道页跨域直连（http(s) 页面 → 127.0.0.1）：全部响应带 CORS；
/// Private-Network 头应对 Chrome 专属预检（https 页面访问本机）。
fn add_cors(headers: &mut HeaderMap) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    headers.insert("Access-Control-Allow-Private-Network", HeaderValue::from_static("true"));
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
}

async fn cors_middleware(req: axum::extract::Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_cors(response.headers_mut());
        return response;
    }
    let mut response = next.run(req).await;
    add_cors(response.headers_mut());
    response
}

fn json_response(value: serde_json::Value, code: StatusCode) -> Response {
    let mut response = (code, axum::Json(value)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

// ---- 处理器 -------------------------------------------------------------------

async fn index() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        PAGE,
    )
        .into_response()
}

async fn status(State(state): State<Arc<HttpState>>) -> Response {
    let (st, pid, name, error) = state.app.snapshot();
    json_response(
        json!({
            "status": st,
            "pid": pid,
            "name": name,
            "error": error,
            "rate": SAMPLE_RATE,
            "channels": CHANNELS,
        }),
        StatusCode::OK,
    )
}

async fn processes(State(state): State<Arc<HttpState>>, RawQuery(query): RawQuery) -> Response {
    let all = query
        .map(|q| q.split('&').any(|kv| kv == "all=1"))
        .unwrap_or(false);
    if all {
        // 全部进程（「显示全部进程」开关与回退用）
        let items = tokio::task::spawn_blocking(crate::procinfo::list_processes)
            .await
            .unwrap_or_default();
        return json_response(
            json!({ "all": items.iter().map(|p| json!({"pid": p.pid, "name": p.name, "mem": p.mem})).collect::<Vec<_>>() }),
            StatusCode::OK,
        );
    }
    // 能发声的应用：1.5s 缓存（页面 3s 自动刷新，会话枚举有 COM 开销）
    {
        let cache = state.app.apps_cache.lock().unwrap();
        if let Some(data) = cache.1.as_ref() {
            if cache.0.elapsed() < Duration::from_millis(APPS_CACHE_MS) {
                return json_response(data.clone(), StatusCode::OK);
            }
        }
    }
    let worker = state.sessions.clone();
    let data = tokio::task::spawn_blocking(move || build_audio_apps(&worker))
        .await
        .unwrap_or_else(|_| json!({"apps": [], "fallback": "枚举线程异常"}));
    *state.app.apps_cache.lock().unwrap() = (Instant::now(), Some(data.clone()));
    json_response(data, StatusCode::OK)
}

/// 有音频会话的应用（即音量混合器里那份名单）——按应用名分组，
/// 正在发声的进程排最前、应用按「播放中 + 内存」排序。
fn build_audio_apps(worker: &SessionWorker) -> serde_json::Value {
    let mut fallback = String::new();
    let sessions = match worker.list_blocking(Duration::from_secs(3)) {
        Ok(list) => list,
        Err(err) => {
            // 无默认音频设备 / COM 失败：交给全量回退
            fallback = err;
            Vec::new()
        }
    };
    let procs = crate::procinfo::process_map();
    // name -> (pid -> active)，保持会话枚举顺序
    let mut apps: HashMap<String, Vec<(u32, bool)>> = HashMap::new();
    for session in sessions {
        let name = procs
            .get(&session.pid)
            .map(|(name, _)| name.clone())
            .unwrap_or_else(|| format!("PID {}", session.pid));
        let entry = apps.entry(name).or_default();
        match entry.iter_mut().find(|(pid, _)| *pid == session.pid) {
            Some((_, active)) => *active = *active || session.active,
            None => entry.push((session.pid, session.active)),
        }
    }
    let mut result = Vec::new();
    for (name, mut pids) in apps {
        // 正在发声的优先被选中（稳定排序保持枚举顺序）
        pids.sort_by_key(|(_, active)| !*active);
        let mem = pids
            .iter()
            .filter_map(|(pid, _)| procs.get(pid).map(|(_, mem)| *mem))
            .fold(0.0_f64, f64::max);
        let active = pids.first().map(|(_, a)| *a).unwrap_or(false);
        result.push(json!({
            "name": name,
            "mem": mem,
            "active": active,
            "pids": pids.iter().map(|(pid, active)| json!({"pid": pid, "active": active})).collect::<Vec<_>>(),
        }));
    }
    result.sort_by(|a, b| {
        let active = |v: &serde_json::Value| v["active"].as_bool().unwrap_or(false);
        let mem = |v: &serde_json::Value| v["mem"].as_f64().unwrap_or(0.0);
        (!active(a)).cmp(&!active(b)).then(mem(b).partial_cmp(&mem(a)).unwrap())
    });
    json!({ "apps": result, "fallback": fallback })
}

async fn start(State(state): State<Arc<HttpState>>, body: Bytes) -> Response {
    // 宽容解析：空体当 {}，坏 JSON 报 400
    let payload: serde_json::Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return json_response(json!({"ok": false, "error": "bad json"}), StatusCode::BAD_REQUEST),
        }
    };
    let Some(pid) = payload["pid"].as_u64().filter(|&pid| pid > 0) else {
        return json_response(json!({"ok": false, "error": "无效的 PID"}), StatusCode::BAD_REQUEST);
    };
    let pid = pid as u32;
    let name = payload["name"].as_str().unwrap_or("").to_string();

    let app = state.app.clone();
    app.stop_capture(); // 换源：旧采集作废
    let generation = app.slot.lock().unwrap().generation;

    // 结束回调：只有当前代次且仍处 running 时才落状态（晚到的旧回调作废）
    let app_late = app.clone();
    let on_end = move |reason: &str| {
        let mut slot = app_late.slot.lock().unwrap();
        if slot.generation == generation && slot.status == "running" {
            slot.status = "stopped";
            slot.error = reason.to_string();
            slot.tx = None;
        }
    };

    let spawn_result =
        tokio::task::spawn_blocking(move || crate::wasapi::spawn(pid, on_end)).await;
    let handle = match spawn_result {
        Ok(Ok(handle)) => handle,
        Ok(Err(err)) => {
            crate::debug_log(&format!("[start-failed] pid={pid}: {err}"));
            return json_response(json!({"ok": false, "error": err}), StatusCode::BAD_REQUEST);
        }
        Err(join_err) => {
            let err = format!("采集线程启动失败：{join_err}");
            crate::debug_log(&format!("[start-failed] pid={pid}: {err}"));
            return json_response(json!({"ok": false, "error": err}), StatusCode::BAD_REQUEST);
        }
    };
    {
        let mut slot = app.slot.lock().unwrap();
        slot.tx = Some(handle.tx);
        slot.stop = Some(handle.stop);
        slot.pid = Some(pid);
        slot.name = name.clone();
        slot.status = "running";
        slot.error.clear();
    }
    crate::debug_log(&format!("[start] pid={pid} name={name}"));
    let (st, pid, name, error) = app.snapshot();
    json_response(
        json!({"ok": true, "status": st, "pid": pid, "name": name, "error": error, "rate": SAMPLE_RATE, "channels": CHANNELS}),
        StatusCode::OK,
    )
}

async fn stop(State(state): State<Arc<HttpState>>) -> Response {
    state.app.stop_capture();
    let (st, pid, name, error) = state.app.snapshot();
    json_response(
        json!({"ok": true, "status": st, "pid": pid, "name": name, "error": error, "rate": SAMPLE_RATE, "channels": CHANNELS}),
        StatusCode::OK,
    )
}

/// PCM 流：48k/2ch/float32 交错，chunked 下发；采集结束即收尾。
/// 慢消费者各自落后丢帧（broadcast 容量 ≈6s），互不影响。
async fn stream(State(state): State<Arc<HttpState>>) -> Response {
    let receiver = {
        let slot = state.app.slot.lock().unwrap();
        if slot.status == "running" {
            slot.tx.as_ref().map(|tx| tx.subscribe())
        } else {
            None
        }
    };
    let body = match receiver {
        Some(receiver) => Body::from_stream(futures_util::stream::unfold(receiver, |mut receiver| async move {
            loop {
                match receiver.recv().await {
                    Ok(bytes) => return Some((Ok::<Bytes, std::io::Error>(bytes), receiver)),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue, // 落后：丢旧帧继续
                    Err(broadcast::error::RecvError::Closed) => return None, // 采集结束：正常收尾
                }
            }
        })),
        // 无采集：立即结束（订阅后即遇 idle 退出，频道页断流路径同主动停止）
        None => Body::empty(),
    };
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}
