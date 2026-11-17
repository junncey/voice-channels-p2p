//! 音频会话枚举（即音量混合器里那份名单）。
//!
//! COM 对象（设备枚举器等）绑定创建线程，跨线程复用会失败，因此把
//! 枚举固定在下面的专职线程上（请求-应答通道），HTTP 侧经
//! spawn_blocking 调入。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionEnumerator,
    IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

pub struct SessionInfo {
    pub pid: u32,
    /// 会话正在发声（AudioSessionStateActive）
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
        std::thread::Builder::new()
            .name("audio-enum".into())
            .spawn(move || worker(rx))
            .expect("启动音频会话枚举线程");
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
    // MTA：枚举器等 COM 对象在本线程内反复复用
    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        while let Ok(Request::List(reply)) = rx.recv() {
            let _ = reply.send(Err("COM 初始化失败".to_string()));
        }
        return;
    }
    let enumerator: IMMDeviceEnumerator =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(it) => it,
            Err(err) => {
                let msg = format!("创建设备枚举器失败：{err}");
                while let Ok(Request::List(reply)) = rx.recv() {
                    let _ = reply.send(Err(msg.clone()));
                }
                unsafe { CoUninitialize() };
                return;
            }
        };
    while let Ok(Request::List(reply)) = rx.recv() {
        let _ = reply.send(enumerate(&enumerator));
    }
    unsafe { CoUninitialize() };
}

/// 默认播放设备上的全部音频会话（无进程会话如系统声音会被跳过）
fn enumerate(enumerator: &IMMDeviceEnumerator) -> Result<Vec<SessionInfo>, String> {
    unsafe {
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|err| format!("无默认音频设备或获取失败：{err}"))?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|err| format!("激活会话管理器失败：{err}"))?;
        let sessions: IAudioSessionEnumerator = manager
            .GetSessionEnumerator()
            .map_err(|err| format!("获取会话枚举器失败：{err}"))?;
        let count = sessions.GetCount().map_err(|err| format!("{err}"))?;
        let mut out = Vec::new();
        for index in 0..count {
            let control = match sessions.GetSession(index) {
                Ok(it) => it,
                Err(_) => continue,
            };
            // 无进程会话（系统声音）取不到 pid：跳过
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = control2.GetProcessId() else {
                continue;
            };
            if pid == 0 {
                continue;
            }
            let active = matches!(control.GetState(), Ok(state) if state == AudioSessionStateActive);
            out.push(SessionInfo { pid, active });
        }
        Ok(out)
    }
}
