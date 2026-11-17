//! 音频会话枚举（即音量混合器里那份名单）。
//!
//! 全链路走 wasapi crate 的安全封装（DeviceEnumerator → 默认设备 →
//! AudioSessionManager → AudioSessionEnumerator，unsafe 收在 crate 内部）。
//! COM 对象复用固定在下面的专职线程上（请求-应答通道），HTTP 侧经
//! spawn_blocking 调入。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use wasapi::{DeviceEnumerator, Direction, SessionState};

pub struct SessionInfo {
    pub pid: u32,
    /// 会话正在发声（SessionState::Active）
    pub active: bool,
}

enum Request {
    List(Sender<Result<Vec<SessionInfo>, String>>),
}

/// 会话枚举的句柄：Clone 后可传入 spawn_blocking（底层是线程安全的通道）
#[derive(Clone)]
pub struct SessionWorker {
    tx: Sender<Request>,
}

impl SessionWorker {
    pub fn spawn() -> Self {
        let (tx, rx) = channel::<Request>();
        let spawned = std::thread::Builder::new()
            .name("audio-enum".into())
            .spawn(move || worker(rx));
        if spawned.is_err() {
            crate::fatal("启动音频会话枚举线程失败");
        }
        Self { tx }
    }

    /// 在专职线程上枚举音频会话（阻塞调用，须在 spawn_blocking 里用）
    pub fn list_blocking(&self, timeout: Duration) -> Result<Vec<SessionInfo>, String> {
        let (reply_tx, reply_rx) = channel();
        self.tx
            .send(Request::List(reply_tx))
            .map_err(|_| "枚举线程已退出".to_string())?;
        match reply_rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => Err("音频会话枚举超时".to_string()),
        }
    }
}

fn worker(rx: Receiver<Request>) {
    // MTA：wasapi::initialize_mta 即 CoInitializeEx(MTA) 的安全包装。线程
    // 常驻到通道关闭，刻意不配对 CoUninitialize（进程退出由 COM 收尾，
    // 与采集线程同一取舍）
    if wasapi::initialize_mta().is_err() {
        while let Ok(Request::List(reply)) = rx.recv() {
            let _ = reply.send(Err("COM 初始化失败".to_string()));
        }
        return;
    }
    // 设备枚举器在本线程内创建并复用（与采集侧同一模式）
    let enumerator = match DeviceEnumerator::new() {
        Ok(enumerator) => enumerator,
        Err(err) => {
            let msg = format!("创建设备枚举器失败：{err}");
            while let Ok(Request::List(reply)) = rx.recv() {
                let _ = reply.send(Err(msg.clone()));
            }
            return;
        }
    };
    while let Ok(Request::List(reply)) = rx.recv() {
        let _ = reply.send(enumerate(&enumerator));
    }
}

/// 默认播放设备上的全部音频会话（无进程会话如系统声音会被跳过）
fn enumerate(enumerator: &DeviceEnumerator) -> Result<Vec<SessionInfo>, String> {
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(|err| format!("无默认音频设备或获取失败：{err}"))?;
    let sessions = device
        .get_iaudiosessionmanager()
        .map_err(|err| format!("激活会话管理器失败：{err}"))?
        .get_audiosessionenumerator()
        .map_err(|err| format!("获取会话枚举器失败：{err}"))?;
    let count = sessions.get_count().map_err(|err| format!("{err}"))?;
    let mut out = Vec::new();
    for index in 0..count {
        let control = match sessions.get_session(index) {
            Ok(it) => it,
            Err(_) => continue,
        };
        // 无进程会话（系统声音）取不到 pid：跳过
        let Ok(pid) = control.get_process_id() else {
            continue;
        };
        if pid == 0 {
            continue;
        }
        let active = matches!(control.get_state(), Ok(SessionState::Active));
        out.push(SessionInfo { pid, active });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 专职线程请求-应答管线：真实设备环境给出名单，无音频设备的环境
    /// （CI runner）也应快速返回明确错误而非挂起/panic
    #[test]
    fn worker_responds_via_channel() {
        let worker = SessionWorker::spawn();
        match worker.list_blocking(Duration::from_secs(5)) {
            Ok(list) => assert!(list.iter().all(|s| s.pid > 0)),
            Err(err) => assert!(!err.is_empty()),
        }
    }
}
