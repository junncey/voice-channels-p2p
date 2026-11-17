//! WASAPI 进程级音频回路采集（Windows 10 20H1+，免驱动免管理员）。
//!
//! 基于 `wasapi` crate（HEnquist/wasapi-rs）的
//! `AudioClient::new_application_loopback_client`：激活回调只发信号、等待
//! 线程上取结果（`GetActivateResult`），EventsShared + AUTOCONVERTPCM 直取
//! float32/48k/立体声——引擎保证交付所请求的格式，无需软件转换。
//! 对外交付 48k/2ch/float32 交错字节流（频道页 hardcode 依赖）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use axum::body::Bytes;
use tokio::sync::broadcast;
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

use crate::state::{CHANNELS, SAMPLE_RATE, SUB_MAX_CHUNKS};

/// 每帧字节数（float32 × 声道数）——由交付格式常量推导，杜绝手抄漂移
const BLOCK_ALIGN: usize = CHANNELS as usize * std::mem::size_of::<f32>();

/// 激活结果同步等待上限。须短于频道页 share.js 的 start 客户端超时（8s）：
/// 保证服务端总是先一步返回真实错误，客户端提前放弃不留下无主采集。
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(6);

pub struct CaptureHandle {
    pub tx: broadcast::Sender<Bytes>,
    pub stop: Arc<AtomicBool>,
}

/// 启动采集线程：激活成功后立即返回句柄，失败同步返回错误；
/// 采集结束（进程退出 / 底层错误 / stop 置位）后回调 `on_end(原因)`。
pub fn spawn(
    pid: u32,
    on_end: impl Fn(&str) + Send + Sync + 'static,
) -> Result<CaptureHandle, String> {
    // 预检：对已退出的 pid，激活回调可能永远不来（wasapi crate 无限等待），
    // 先拦下最常见的「应用已关闭」
    if !crate::procinfo::pid_alive(pid) {
        return Err("目标进程不存在或已退出".to_string());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, _) = broadcast::channel(SUB_MAX_CHUNKS);
    let (result_tx, result_rx) = std_mpsc::channel::<Result<(), String>>();
    {
        let stop = stop.clone();
        let tx = tx.clone();
        let on_end = Arc::new(on_end);
        let on_end_late = on_end.clone();
        thread::Builder::new()
            .name("wasapi-capture".into())
            .spawn(move || {
                // 激活阶段：成功即向调用方回传，失败也回传（不进采集循环）
                let outcome =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| setup_capture(pid)));
                let stream = match outcome {
                    Ok(Ok(stream)) => {
                        let _ = result_tx.send(Ok(()));
                        // 等待方已超时弃养（stop 已置位）：不进采集循环，直接收尾
                        if stop.load(Ordering::Relaxed) {
                            let _ = stream.audio_client.stop_stream();
                            return;
                        }
                        stream
                    }
                    Ok(Err(err)) => {
                        let _ = result_tx.send(Err(err.clone()));
                        on_end_late(&err);
                        return;
                    }
                    Err(_) => {
                        let err = "采集线程启动时崩溃".to_string();
                        let _ = result_tx.send(Err(err.clone()));
                        on_end_late(&err);
                        return;
                    }
                };
                // 采集循环：结束（停止/进程退出/底层错误/panic）后统一回调收尾
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    capture_loop(pid, &stream, &tx, &stop)
                }));
                let _ = stream.audio_client.stop_stream();
                let reason = match outcome {
                    Ok(Ok(reason)) => reason,
                    Ok(Err(err)) => err, // 激活已成功：错误原因同样经 on_end 呈现
                    Err(_) => "采集线程异常退出".to_string(),
                };
                on_end_late(&reason);
            })
            .map_err(|err| err.to_string())?;
    }
    // 同步等待激活结果（进程不存在 / 设备初始化失败等在此暴露给调用方）；
    // 超时即弃养——先置位 stop：若激活随后才成功，采集线程见标志自行收尾
    // （见上方激活成功分支），不留无主线程
    match result_rx.recv_timeout(ACTIVATE_TIMEOUT) {
        Ok(Ok(())) => Ok(CaptureHandle { tx, stop }),
        Ok(Err(err)) => Err(err),
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            Err("音频设备激活超时".to_string())
        }
    }
}

fn capture_thread_init() -> Result<(), String> {
    // MTA；刻意不配对 deinitialize：线程退出由 COM 自行收尾
    let hr = wasapi::initialize_mta();
    if hr.is_err() {
        Err(format!("COM 初始化失败：0x{:08X}", hr.0))
    } else {
        Ok(())
    }
}

/// 已就绪的采集流（激活 + 初始化 + 启动全部成功）
struct Stream {
    audio_client: AudioClient,
    capture_client: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
}

/// 激活并启动采集。Err 为激活/初始化失败。
fn setup_capture(pid: u32) -> Result<Stream, String> {
    capture_thread_init()?;
    // 请求 float32/48k/立体声 + AUTOCONVERTPCM：引擎保证按此格式交付
    // （格式常量与频道页契约同源：state.rs 的 SAMPLE_RATE / CHANNELS）
    let desired_format = WaveFormat::new(
        32,
        32,
        SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS as usize,
        None,
    );
    let mut audio_client = AudioClient::new_application_loopback_client(pid, true)
        .map_err(|err| format!("进程回路激活失败（目标进程不存在或拒绝采集）：{err}"))?;
    audio_client
        .initialize_client(
            &desired_format,
            Direction::Capture,
            StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: 0,
            },
            None,
        )
        .map_err(|err| format!("初始化采集客户端失败：{err}"))?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|err| format!("创建采集事件失败：{err}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|err| format!("获取采集客户端失败：{err}"))?;
    audio_client
        .start_stream()
        .map_err(|err| format!("启动采集失败：{err}"))?;
    Ok(Stream {
        audio_client,
        capture_client,
        event,
    })
}

/// Ok(原因) = 正常收尾（停止/进程退出）；Err = 底层错误。
fn capture_loop(
    pid: u32,
    stream: &Stream,
    tx: &broadcast::Sender<Bytes>,
    stop: &Arc<AtomicBool>,
) -> Result<String, String> {
    // 单包最大 1 秒音频（SAMPLE_RATE 帧）：GetBuffer 的包帧数不会超过引擎缓冲
    let mut scratch = vec![0u8; SAMPLE_RATE as usize * BLOCK_ALIGN];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok("已停止".to_string());
        }
        // 排空当前所有包
        loop {
            let frames = stream
                .capture_client
                .get_next_packet_size()
                .map_err(|err| format!("读取包大小失败：{err}"))?
                .unwrap_or(0);
            if frames == 0 {
                break;
            }
            let (frames, _info) = stream
                .capture_client
                .read_from_device(&mut scratch)
                .map_err(|err| format!("读取音频缓冲失败（进程可能已退出）：{err}"))?;
            let len = frames as usize * BLOCK_ALIGN;
            let _ = tx.send(Bytes::copy_from_slice(&scratch[..len])); // 无订阅者时忽略
        }
        // 事件等待（500ms 超时：空闲会话也可能长时间无包），核对进程是否还在
        if stream.event.wait_for_event(500).is_err() && !crate::procinfo::pid_alive(pid) {
            return Ok("目标进程已退出".to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 交付格式契约：频道页 share.js / 内嵌页 hardcode 48k 立体声 float32（8 字节帧）
    #[test]
    fn stream_format_constants() {
        assert_eq!((SAMPLE_RATE, CHANNELS), (48000, 2));
        assert_eq!(BLOCK_ALIGN, 8);
    }
}
