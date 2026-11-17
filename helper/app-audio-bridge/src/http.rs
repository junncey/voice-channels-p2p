//! HTTP 服务：5 个端点（页面 / 进程列表 / 状态 / 采集启停 / PCM 流），
//! 全部响应带 CORS（频道页 http(s) → 127.0.0.1 直连用）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use tokio::sync::broadcast;

use crate::sessions::{SessionInfo, SessionWorker};
use crate::state::{App, CHANNELS, SAMPLE_RATE};

/// 内置试听页面
const PAGE: &str = include_str!("page.html");

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
///
/// 威胁模型（有意接受的权衡）：ACAO `*` 意味着本工具运行期间，任意网页
/// 都能枚举本机进程、启停采集、拉取音频。接受的前提是工具仅在使用者主动
/// 启动、做「一起听」分享的时段运行——进程名单与音频本就要交给频道页，
/// 以此换取单文件零配置。若要收紧须三端同步改（此处 + share.js + 内嵌页）。
fn add_cors(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    headers.insert(
        "Access-Control-Allow-Private-Network",
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
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

/// /api/status、/api/start、/api/stop 共用的状态体
fn status_json(app: &App) -> serde_json::Value {
    let (st, pid, name, error) = app.snapshot();
    json!({
        "status": st,
        "pid": pid,
        "name": name,
        "error": error,
        "rate": SAMPLE_RATE,
        "channels": CHANNELS,
    })
}

/// `?all=1` 解析（内嵌页「显示全部进程」开关）：精确匹配该键值对
fn wants_all(query: Option<&str>) -> bool {
    query.is_some_and(|q| q.split('&').any(|kv| kv == "all=1"))
}

// ---- 处理器 -------------------------------------------------------------------

async fn index() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response()
}

async fn status(State(state): State<Arc<HttpState>>) -> Response {
    json_response(status_json(&state.app), StatusCode::OK)
}

async fn processes(State(state): State<Arc<HttpState>>, RawQuery(query): RawQuery) -> Response {
    if wants_all(query.as_deref()) {
        // 全部进程（「显示全部进程」开关与回退用）
        let items = match tokio::task::spawn_blocking(crate::procinfo::list_processes).await {
            Ok(items) => items,
            Err(err) => {
                crate::debug_log!("[processes] 全量枚举线程失败：{err}");
                Vec::new()
            }
        };
        return json_response(
            json!({ "all": items.iter().map(|p| json!({"pid": p.pid, "name": p.name, "mem": p.mem})).collect::<Vec<_>>() }),
            StatusCode::OK,
        );
    }
    // 能发声的应用：短暂缓存（页面 3s 自动刷新，会话枚举有 COM 开销）
    if let Some(data) = state.app.take_apps_cache() {
        return json_response(data, StatusCode::OK);
    }
    let worker = state.sessions.clone();
    let data = match tokio::task::spawn_blocking(move || build_audio_apps(&worker)).await {
        Ok(data) => data,
        Err(_) => json!({"apps": [], "fallback": "枚举线程异常"}),
    };
    state.app.store_apps_cache(data.clone());
    json_response(data, StatusCode::OK)
}

/// 有音频会话的应用（即音量混合器里那份名单）：IO 在此（专职线程枚举 +
/// 进程快照），纯数据变换在 `merge_audio_apps`（可单测）。
fn build_audio_apps(worker: &SessionWorker) -> serde_json::Value {
    let (fallback, sessions) = match worker.list_blocking(Duration::from_secs(3)) {
        Ok(list) => (String::new(), list),
        // 无默认音频设备 / COM 失败：交给全量回退
        Err(err) => (err, Vec::new()),
    };
    let procs = crate::procinfo::process_map();
    merge_audio_apps(&sessions, &procs, &fallback)
}

/// 会话 + 进程快照 → 应用分组列表：按展示名分组（同名多 pid 合并、正在
/// 发声的进程排最前），应用按「播放中 + 内存」排序；排除本工具自身与
/// 浏览器（见 procinfo::BROWSER_EXES），查不到进程名的以 `PID {n}` 兜底。
/// 纯函数。
fn merge_audio_apps(
    sessions: &[SessionInfo],
    procs: &HashMap<u32, (String, f64)>,
    fallback: &str,
) -> serde_json::Value {
    let self_pid = std::process::id();
    // name -> (pid -> active)，保持会话枚举顺序
    let mut apps: HashMap<String, Vec<(u32, bool)>> = HashMap::new();
    for session in sessions {
        if session.pid == self_pid {
            continue; // 本工具自身：试听页的声音经浏览器会话播放，自身不该入列
        }
        let name = match procs.get(&session.pid) {
            // 浏览器：有自己的标签页分享方案，且活跃会话常驻排头——排除
            Some((exe, _)) if crate::procinfo::is_browser(exe) => continue,
            Some((exe, _)) => crate::procinfo::display_name(exe),
            None => format!("PID {}", session.pid),
        };
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
        // total_cmp：NaN 安全（值来自 JSON 解析，防患于未然）
        (!active(a))
            .cmp(&!active(b))
            .then_with(|| mem(b).total_cmp(&mem(a)))
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
            Err(_) => {
                return json_response(
                    json!({"ok": false, "error": "bad json"}),
                    StatusCode::BAD_REQUEST,
                )
            }
        }
    };
    // pid 限 u32 域内：直接 as u32 截断会静默指向另一个进程
    let Some(pid) = payload["pid"]
        .as_u64()
        .filter(|&pid| pid > 0 && pid <= u32::MAX as u64)
        .map(|pid| pid as u32)
    else {
        return json_response(
            json!({"ok": false, "error": "无效的 PID"}),
            StatusCode::BAD_REQUEST,
        );
    };
    let name = payload["name"].as_str().unwrap_or("").to_string();

    let app = state.app.clone();
    app.stop_capture(); // 换源：旧采集作废（代次 +1，旧回调从此不覆写）
    let generation = app.current_generation();

    // 结束回调：晚到的旧代次回调直接作废
    let app_late = app.clone();
    let on_end = move |reason: &str| app_late.end_capture(generation, reason);

    // 激活 + 落座整体放进阻塞任务：即使客户端提前断开、handler future 被
    // 丢弃，激活成功的线程也已正确落座或自止，不因响应无人接收而泄漏
    let result = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            crate::wasapi::spawn(pid, on_end)
                .map_err(|err| (err, StatusCode::BAD_REQUEST))
                .and_then(|handle| {
                    // 并发竞态防护：等待激活期间若来了新的 start（代次已变），
                    // 本次激活作废，令刚激活的线程自止，绝不覆写新一轮状态
                    if !app.adopt_capture(generation, &handle.tx, &handle.stop, pid, &name) {
                        handle.stop.store(true, Ordering::Relaxed);
                        return Err(("已被新的采集请求取代".to_string(), StatusCode::CONFLICT));
                    }
                    crate::debug_log!("[start] pid={pid} name={name}");
                    Ok(())
                })
        })
        .await
    };
    let (error, code) = match result {
        Ok(Ok(())) => {
            let mut body = status_json(&app);
            body["ok"] = json!(true);
            return json_response(body, StatusCode::OK);
        }
        Ok(Err(pair)) => pair,
        Err(join_err) => (
            format!("采集线程启动失败：{join_err}"),
            StatusCode::BAD_REQUEST,
        ),
    };
    crate::debug_log!("[start-failed] pid={pid}: {error}");
    json_response(json!({"ok": false, "error": error}), code)
}

async fn stop(State(state): State<Arc<HttpState>>) -> Response {
    state.app.stop_capture();
    let mut body = status_json(&state.app);
    body["ok"] = json!(true);
    json_response(body, StatusCode::OK)
}

/// PCM 流：48k/2ch/float32 交错，chunked 下发；采集结束即收尾。
/// 慢消费者各自落后丢帧（broadcast 容量 ≈6s），互不影响。
async fn stream(State(state): State<Arc<HttpState>>) -> Response {
    let receiver = state.app.subscribe_stream();
    let body = match receiver {
        Some(receiver) => Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async move {
                loop {
                    match receiver.recv().await {
                        Ok(bytes) => return Some((Ok::<Bytes, std::io::Error>(bytes), receiver)),
                        Err(broadcast::error::RecvError::Lagged(_)) => continue, // 落后：丢旧帧继续
                        Err(broadcast::error::RecvError::Closed) => return None, // 采集结束：正常收尾
                    }
                }
            },
        )),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wants_all_matches_exact_pair() {
        assert!(wants_all(Some("all=1")));
        assert!(wants_all(Some("all=1&x=y")));
        assert!(wants_all(Some("x=y&all=1")));
        assert!(!wants_all(None));
        assert!(!wants_all(Some("")));
        assert!(!wants_all(Some("all=0")));
        assert!(!wants_all(Some("x=all=1")), "须匹配完整键值对，而非子串");
    }

    fn session(pid: u32, active: bool) -> SessionInfo {
        SessionInfo { pid, active }
    }

    #[test]
    fn merge_groups_same_name_and_prefers_active_pid() {
        let sessions = [session(11, false), session(12, true), session(13, false)];
        let mut procs = HashMap::new();
        procs.insert(11u32, ("cloudmusic.exe".to_string(), 100.0));
        procs.insert(12u32, ("cloudmusic.exe".to_string(), 300.0));
        procs.insert(13u32, ("cloudmusic.exe".to_string(), 200.0));
        let value = merge_audio_apps(&sessions, &procs, "");
        let apps = value["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 1);
        let app = &apps[0];
        assert_eq!(
            app["name"].as_str().unwrap(),
            "网易云",
            "展示产品名而非文件名"
        );
        assert!(app["active"].as_bool().unwrap(), "任一 pid 发声即 active");
        assert_eq!(app["mem"].as_f64().unwrap(), 300.0, "mem 取同名进程最大值");
        let pids = app["pids"].as_array().unwrap();
        assert_eq!(pids.len(), 3);
        assert_eq!(pids[0]["pid"].as_u64().unwrap(), 12, "正在发声的进程排最前");
    }

    #[test]
    fn merge_falls_back_to_pid_name_and_sorts_active_first() {
        let sessions = [session(9, false), session(50, true)];
        let mut procs = HashMap::new();
        procs.insert(9u32, ("known.exe".to_string(), 5.0));
        let value = merge_audio_apps(&sessions, &procs, "无默认音频设备");
        assert_eq!(value["fallback"].as_str().unwrap(), "无默认音频设备");
        let apps = value["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 2);
        assert_eq!(
            apps[0]["name"].as_str().unwrap(),
            "PID 50",
            "查不到进程名以 PID 兜底"
        );
        assert!(apps[0]["active"].as_bool().unwrap());
        assert_eq!(
            apps[1]["name"].as_str().unwrap(),
            "known",
            "未知产品去 .exe 后缀"
        );
        assert!(!apps[1]["active"].as_bool().unwrap(), "active 应用排在前面");
    }

    /// 列表卫生：浏览器与本工具自身不入「能发声的应用」名单
    #[test]
    fn merge_excludes_browsers_and_self() {
        let sessions = [
            session(21, true),
            session(22, true),
            session(std::process::id(), true),
            session(23, false),
        ];
        let mut procs = HashMap::new();
        procs.insert(21u32, ("msedge.exe".to_string(), 500.0));
        procs.insert(22u32, ("chrome.exe".to_string(), 400.0));
        procs.insert(
            std::process::id(),
            ("app-audio-bridge.exe".to_string(), 1.0),
        );
        procs.insert(23u32, ("scrcpy.exe".to_string(), 60.0));
        let value = merge_audio_apps(&sessions, &procs, "");
        let apps = value["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 1, "只剩非浏览器的 scrcpy");
        assert_eq!(apps[0]["name"].as_str().unwrap(), "scrcpy");
    }
}
