//! 共享采集状态：单例采集器（频道页与本工具页面可同时拉流）。
//!
//! 采集槽位由 `generation` 计数保护：换源 / 停止都会递增代次，
//! 旧采集线程的结束回调若晚到，不会覆写新一轮的状态。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Bytes;
use tokio::sync::broadcast;

/// 对外统一交付的音频格式（频道页 hardcode 依赖：float32 交错立体声）
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u16 = 2;

/// 单订阅者待发上限（约 6 秒 @10ms/块）：超出即丢最旧，防内存增长
pub const SUB_MAX_CHUNKS: usize = 600;

pub struct Slot {
    pub generation: u64,
    pub pid: Option<u32>,
    pub name: String,
    /// idle | running | stopped
    pub status: &'static str,
    pub error: String,
    /// 采集线程的广播出口：drop 即 /stream 全部收尾
    pub tx: Option<broadcast::Sender<Bytes>>,
    /// 置位后采集线程自行收尾
    pub stop: Option<Arc<AtomicBool>>,
}

pub struct App {
    pub slot: Mutex<Slot>,
    /// 「能发声的应用」列表缓存：会话枚举有 COM 开销，页面 3s 自动刷新时不重算
    pub apps_cache: Mutex<(Instant, Option<serde_json::Value>)>,
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

    /// 停止当前采集（主动路径：/api/stop 或换源）。返回当前代次，供启动方配对回调。
    pub fn stop_capture(&self) {
        let mut slot = self.slot.lock().unwrap();
        if let Some(flag) = &slot.stop {
            flag.store(true, Ordering::Relaxed);
        }
        // 旧采集线程的结束回调不能再覆写状态
        slot.generation += 1;
        slot.tx = None;
        slot.stop = None;
        slot.pid = None;
        slot.name.clear();
        slot.status = "idle";
        slot.error.clear();
    }

    /// /api/status 的快照（短暂持锁拷贝出全量字段）
    pub fn snapshot(&self) -> (String, Option<u32>, String, String) {
        let slot = self.slot.lock().unwrap();
        (
            slot.status.to_string(),
            slot.pid,
            slot.name.clone(),
            slot.error.clone(),
        )
    }
}
