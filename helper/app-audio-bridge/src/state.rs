//! 共享采集状态：单例采集器（频道页与本工具页面可同时拉流）。
//!
//! 采集槽位由 `generation` 计数保护：换源 / 停止递增代次，旧采集线程
//! 晚到的结束回调不覆写新一轮状态；并发 start 的激活结果也经代次校验
//! 落座（`adopt_capture`），被取代者自止、绝不泄漏采集线程。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use tokio::sync::broadcast;

/// 对外统一交付的音频格式（频道页 hardcode 依赖：float32 交错立体声）
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u16 = 2;

/// 单订阅者待发上限（约 6 秒 @10ms/块）：超出即丢最旧，防内存增长
pub const SUB_MAX_CHUNKS: usize = 600;

/// 「能发声的应用」列表缓存时长（页面 3s 自动刷新时不重算会话枚举）
pub const APPS_CACHE_MS: u64 = 1500;

struct Slot {
    generation: u64,
    pid: Option<u32>,
    name: String,
    /// idle | running | stopped
    status: &'static str,
    error: String,
    /// 采集线程的广播出口：drop 即 /stream 全部收尾
    tx: Option<broadcast::Sender<Bytes>>,
    /// 置位后采集线程自行收尾
    stop: Option<Arc<AtomicBool>>,
}

pub struct App {
    slot: Mutex<Slot>,
    /// 「能发声的应用」列表缓存：会话枚举有 COM 开销，页面 3s 自动刷新时不重算
    apps_cache: Mutex<(Instant, Option<serde_json::Value>)>,
}

/// 取锁；中毒（持锁线程 panic 过）时取回数据继续用——槽内是纯数据快照，
/// 无跨锁不变量，无需因一次 panic 作废
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

impl App {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(Slot {
                generation: 0,
                pid: None,
                name: String::new(),
                status: "idle",
                error: String::new(),
                tx: None,
                stop: None,
            }),
            apps_cache: Mutex::new((Instant::now(), None)),
        }
    }

    /// 停止当前采集（主动路径：/api/stop 或换源）：置停止标志、清空槽位并
    /// 递增代次——旧采集线程的结束回调从此不得覆写状态。
    pub fn stop_capture(&self) {
        let mut slot = lock(&self.slot);
        if let Some(flag) = &slot.stop {
            flag.store(true, Ordering::Relaxed);
        }
        slot.generation += 1;
        slot.tx = None;
        slot.stop = None;
        slot.pid = None;
        slot.name.clear();
        slot.status = "idle";
        slot.error.clear();
    }

    /// 当前代次（start 流程配对结束回调与落座校验用）
    pub fn current_generation(&self) -> u64 {
        lock(&self.slot).generation
    }

    /// 激活成功的采集线程落座。false = 等待激活期间来了新的 start（代次已
    /// 变）：本次激活作废，调用方须置位 stop 令该线程自止。
    pub fn adopt_capture(
        &self,
        generation: u64,
        tx: &broadcast::Sender<Bytes>,
        stop: &Arc<AtomicBool>,
        pid: u32,
        name: &str,
    ) -> bool {
        let mut slot = lock(&self.slot);
        if slot.generation != generation {
            return false;
        }
        slot.tx = Some(tx.clone());
        slot.stop = Some(stop.clone());
        slot.pid = Some(pid);
        slot.name = name.to_string();
        slot.status = "running";
        slot.error.clear();
        true
    }

    /// 采集结束回调的落状态：只有当前代次且仍处 running 时才落——
    /// 晚到的旧回调 / 并发换源期间的回调不得覆写新一轮状态。
    pub fn end_capture(&self, generation: u64, reason: &str) {
        let mut slot = lock(&self.slot);
        if slot.generation == generation && slot.status == "running" {
            slot.status = "stopped";
            slot.error = reason.to_string();
            slot.tx = None;
            slot.stop = None;
        }
    }

    /// running 时订阅当前采集的广播（/stream 用）
    pub fn subscribe_stream(&self) -> Option<broadcast::Receiver<Bytes>> {
        let slot = lock(&self.slot);
        if slot.status != "running" {
            return None;
        }
        slot.tx.as_ref().map(|tx| tx.subscribe())
    }

    /// /api/status 的快照（短暂持锁拷贝出全量字段）
    pub fn snapshot(&self) -> (String, Option<u32>, String, String) {
        let slot = lock(&self.slot);
        (
            slot.status.to_string(),
            slot.pid,
            slot.name.clone(),
            slot.error.clone(),
        )
    }

    /// 命中新鲜缓存时返回「能发声的应用」列表（克隆）
    pub fn take_apps_cache(&self) -> Option<serde_json::Value> {
        let cache = lock(&self.apps_cache);
        if cache.0.elapsed() < Duration::from_millis(APPS_CACHE_MS) {
            cache.1.clone()
        } else {
            None
        }
    }

    /// 写入「能发声的应用」列表缓存
    pub fn store_apps_cache(&self, data: serde_json::Value) {
        *lock(&self.apps_cache) = (Instant::now(), Some(data));
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一对「采集线程句柄」素材（广播出口 + 停止标志）
    fn handle_parts() -> (broadcast::Sender<Bytes>, Arc<AtomicBool>) {
        (
            broadcast::channel(SUB_MAX_CHUNKS).0,
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn stop_capture_signals_thread_and_resets() {
        let app = App::new();
        let (tx, stop) = handle_parts();
        assert!(app.adopt_capture(app.current_generation(), &tx, &stop, 42, "test"));

        app.stop_capture();
        assert!(
            stop.load(Ordering::Relaxed),
            "stop_capture 须置位采集线程的停止标志"
        );
        let (st, pid, name, error) = app.snapshot();
        assert_eq!(
            (st.as_str(), pid, name.as_str(), error.as_str()),
            ("idle", None, "", "")
        );
        assert_eq!(app.current_generation(), 1, "代次递增使旧回调作废");
        assert!(app.subscribe_stream().is_none());
    }

    #[test]
    fn adopt_capture_rejects_superseded_generation() {
        let app = App::new();
        let (tx, stop) = handle_parts();
        assert!(app.adopt_capture(app.current_generation(), &tx, &stop, 1, "a"));

        let stale = app.current_generation();
        app.stop_capture(); // 并发的新请求换源：代次 +1
        let (tx2, stop2) = handle_parts();
        assert!(
            !app.adopt_capture(stale, &tx2, &stop2, 2, "b"),
            "旧代次的激活必须被拒"
        );
        let (st, _, name, _) = app.snapshot();
        assert_eq!(
            (st.as_str(), name.as_str()),
            ("idle", ""),
            "被拒后不得覆写状态"
        );
    }

    #[test]
    fn end_capture_lands_only_for_current_generation_while_running() {
        let app = App::new();
        let gen = app.current_generation();
        let (tx, stop) = handle_parts();
        assert!(app.adopt_capture(gen, &tx, &stop, 7, "x"));

        app.end_capture(gen + 1, "晚到的旧回调");
        assert_eq!(app.snapshot().0, "running", "旧代次回调不得落状态");

        app.end_capture(gen, "目标进程已退出");
        let (st, _, _, error) = app.snapshot();
        assert_eq!((st.as_str(), error.as_str()), ("stopped", "目标进程已退出"));

        app.end_capture(gen, "再次回调");
        assert_eq!(app.snapshot().0, "stopped", "非 running 时不得重复落状态");
    }

    #[test]
    fn apps_cache_roundtrip() {
        let app = App::new();
        assert!(app.take_apps_cache().is_none());
        app.store_apps_cache(serde_json::json!({"apps": []}));
        assert_eq!(
            app.take_apps_cache()
                .and_then(|v| v["apps"].as_array().cloned()),
            Some(Vec::new())
        );
    }

    /// 轻量并发压测：并发 adopt/end/stop 交替不 panic、不产生不一致状态
    #[test]
    fn concurrent_lifecycle_stays_consistent() {
        let app = Arc::new(App::new());
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let app = app.clone();
                std::thread::spawn(move || {
                    for i in 0..500u64 {
                        let gen = app.current_generation();
                        let (tx, stop) = handle_parts();
                        if app.adopt_capture(gen, &tx, &stop, 1, "t") {
                            app.end_capture(gen, "end");
                        } else {
                            stop.store(true, Ordering::Relaxed);
                        }
                        if i % 7 == 0 {
                            app.stop_capture();
                        }
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
    }
}
