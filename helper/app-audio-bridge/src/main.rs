//! app-audio-bridge —— 只分享「一个桌面应用」声音的小工具（Rust / 单文件 exe）。
//!
//! WASAPI 进程级音频回路（免驱动、免管理员，Win10 20H1+）按进程树采集指定
//! 应用的声音，在本页试听或供频道页「一起听 → 分享本机应用的声音」直连拉流。
//! HTTP 接口与端口（8790~8794 顺延）是频道页 `share.js` 的对接契约，改动须两测。

mod http;
mod procinfo;
mod sessions;
mod state;
mod wasapi;

use std::sync::Arc;
use std::time::Duration;

use state::App;

/// 进程级音频回路 API 的最低系统要求（Win10 20H1）
const MIN_BUILD: u32 = 19041;

/// 频道页探测序列（public/js/pages/channel/share.js 的 HELPER_PORTS）：
/// 8790 起逐个尝试。8765 等是浏览器受限端口（ERR_UNSAFE_PORT），必须避开。
const PORTS: [u16; 5] = [8790, 8791, 8792, 8793, 8794];

fn main() {
    let build = windows_build();
    if build < MIN_BUILD {
        eprintln!("系统版本过旧（build {build}）：进程级音频采集需要 Windows 10 20H1 或 Windows 11。");
        std::process::exit(1);
    }

    let app = Arc::new(App::new());
    let sessions = sessions::SessionWorker::spawn();

    // 选端口：直接尝试绑定（比探测更无竞态），全被占用则退出
    let listener = PORTS.iter().find_map(|&port| {
        std::net::TcpListener::bind(("127.0.0.1", port)).ok()
    });
    let Some(listener) = listener else {
        eprintln!("{}~{} 端口都被占用，无法启动", PORTS[0], PORTS[PORTS.len() - 1]);
        std::process::exit(1);
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORTS[0]);
    let url = format!("http://127.0.0.1:{port}");

    println!("应用声音桥已启动：{url}  （Ctrl+C 退出）");
    println!("步骤：让目标应用出声 → 频道页「一起听」→ 分享本机应用的声音 → 列表选它");

    // 稍等半秒再自动打开试听页面（等服务完全就绪）
    let open_url = url.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        let _ = webbrowser::open(&open_url);
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("启动 tokio 运行时");
    if let Err(err) = runtime.block_on(run(listener, app, sessions)) {
        eprintln!("服务异常退出：{err}");
        std::process::exit(1);
    }
}

async fn run(
    listener: std::net::TcpListener,
    app: Arc<App>,
    sessions: sessions::SessionWorker,
) -> Result<(), Box<dyn std::error::Error>> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;

    let app_for_shutdown = app.clone();
    axum::serve(listener, http::router(app, sessions))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            app_for_shutdown.stop_capture();
        })
        .await?;
    Ok(())
}

/// 读取系统 build 号（RtlGetVersion 不受应用兼容性清单伪装影响）
fn windows_build() -> u32 {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        if RtlGetVersion(&mut info).0 >= 0 {
            info.dwBuildNumber
        } else {
            0
        }
    }
}
