// release 构建为 GUI 子系统：无控制台黑窗，托盘运行；debug 构建保留控制台便于开发调试
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! app-audio-bridge —— 只分享「一个桌面应用」声音的小工具（Rust 单文件 exe，托盘应用）。
//!
//! WASAPI 进程级音频回路（免驱动、免管理员，Win10 20H1+）按进程树采集指定
//! 应用的声音，供频道页「一起听 → 分享本机应用的声音」直连拉流，或经内置
//! 试听页面播放。启动后常驻右下角托盘（默认不弹网页），右键图标菜单
//! 「打开页面 / 退出」。HTTP 接口与端口（8790~8794 顺延）是频道页
//! `share.js` 的对接契约，改动须两测。

mod http;
mod procinfo;
mod sessions;
mod state;
mod wasapi;

use std::sync::Arc;

use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::TrayIconBuilder;
use windows::core::HSTRING;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, MessageBoxW, PostThreadMessageW, TranslateMessage, MB_ICONERROR,
    MB_OK, MSG, WM_QUIT,
};

use state::App;

/// 进程级音频回路 API 的最低系统要求（Win10 20H1）
const MIN_BUILD: u32 = 19041;

/// 频道页探测序列（public/js/pages/channel/share.js 的 HELPER_PORTS）：
/// 8790 起逐个尝试。8765 等是浏览器受限端口（ERR_UNSAFE_PORT），必须避开。
const PORTS: [u16; 5] = [8790, 8791, 8792, 8793, 8794];

/// 关键事件日志：debug 构建（带控制台）输出；release（GUI 子系统、无
/// stdout，println 会 panic）为空实现——宏形态保证 release 下调用点的
/// 格式化本身也被消除，但仍引用一次格式参数（format_args! 零开销），
/// 避免 release 下「捕获变量未使用」告警
macro_rules! debug_log {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        {
            println!($($arg)*);
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = format_args!($($arg)*);
        }
    }};
}
pub(crate) use debug_log;

/// 进程级音频回路 API 的最低系统要求（Win10 20H1）是否达标
fn build_supported(build: u32) -> bool {
    build >= MIN_BUILD
}

fn main() {
    install_panic_hook();
    let build = windows_build();
    if !build_supported(build) {
        fatal(&format!(
            "系统版本过旧（build {build}）：进程级音频采集需要 Windows 10 20H1 或 Windows 11。"
        ));
    }

    // 选端口：直接尝试绑定（比探测更无竞态），全被占用则报错退出
    let listener = PORTS
        .iter()
        .find_map(|&port| std::net::TcpListener::bind(("127.0.0.1", port)).ok());
    let Some(listener) = listener else {
        fatal(&format!(
            "{}~{} 端口都被占用，无法启动",
            PORTS[0],
            PORTS[PORTS.len() - 1]
        ));
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORTS[0]);
    let url = format!("http://127.0.0.1:{port}");

    let app = Arc::new(App::new());
    let sessions = sessions::SessionWorker::spawn();

    // HTTP 服务器跑在后台线程（自带 tokio 运行时）；主线程留给托盘消息循环
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("http-server".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => fatal(&format!("创建 HTTP 运行时失败：{err}")),
                };
                if let Err(err) = runtime.block_on(serve(listener, app, sessions)) {
                    debug_log!("HTTP 服务异常：{err}");
                }
            });
        if let Err(err) = spawned {
            fatal(&format!("启动 HTTP 线程失败：{err}"));
        }
    }

    debug_log!("应用声音桥已启动：{url}（托盘运行，右键图标：打开页面/退出）");

    run_tray(url);

    // 托盘「退出」：停掉采集，随主线程返回结束进程
    app.stop_capture();
}

async fn serve(
    listener: std::net::TcpListener,
    app: Arc<App>,
    sessions: sessions::SessionWorker,
) -> Result<(), Box<dyn std::error::Error>> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, http::router(app, sessions)).await?;
    Ok(())
}

/// 主线程托盘：图标 + 右键菜单（打开页面 / 退出）+ Win32 消息循环。
/// 返回即「退出」被点选（消息循环收到 WM_QUIT）。
fn run_tray(url: String) {
    let menu = Menu::new();
    let open_item = MenuItem::with_id("open", "打开页面", true, None);
    let quit_item = MenuItem::with_id("quit", "退出", true, None);
    // 菜单构建失败则只剩一个无菜单的图标，用户只能任务管理器杀进程——直接报致命
    if let Err(err) = menu.append_items(&[&open_item, &quit_item]) {
        fatal(&format!("构建托盘菜单失败：{err}"));
    }

    let tray = match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(format!("应用声音桥 · {url}"))
        .with_icon(load_icon())
        .build()
    {
        Ok(tray) => tray,
        Err(err) => fatal(&format!("创建托盘图标失败：{err}")),
    };

    // 菜单事件在消息循环线程上回调：打开页面 → 浏览器；退出 → 投递 WM_QUIT 收循环
    let open_url = url;
    let loop_thread = unsafe { GetCurrentThreadId() };
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| match event.id.0.as_str() {
        "open" => {
            let _ = webbrowser::open(&open_url);
        }
        "quit" => unsafe {
            let _ = PostThreadMessageW(
                loop_thread,
                WM_QUIT,
                windows::Win32::Foundation::WPARAM(0),
                windows::Win32::Foundation::LPARAM(0),
            );
        },
        _ => {}
    }));

    // tray-icon 在本线程内自建隐藏窗口：持续泵消息即可收到托盘/菜单事件
    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    drop(tray); // Drop 即 NIM_DELETE：从通知区移除图标
    std::thread::sleep(std::time::Duration::from_millis(150)); // 留时间送达移除消息
}

/// 解码内嵌品牌图标（assets/icon-192.png，源自 public/images，RGBA8）。
/// 资产是编译期内嵌的，失败即程序损坏——报致命而非静默 panic。
fn load_icon() -> tray_icon::Icon {
    const ICON_PNG: &[u8] = include_bytes!("../assets/icon-192.png");
    let decoder = png::Decoder::new(std::io::Cursor::new(ICON_PNG));
    let mut reader = match decoder.read_info() {
        Ok(reader) => reader,
        Err(err) => fatal(&format!("图标解码失败：{err}")),
    };
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = match reader.next_frame(&mut buffer) {
        Ok(info) => info,
        Err(err) => fatal(&format!("读取图标像素失败：{err}")),
    };
    match tray_icon::Icon::from_rgba(
        buffer[..info.buffer_size()].to_vec(),
        info.width,
        info.height,
    ) {
        Ok(icon) => icon,
        Err(err) => fatal(&format!("构造托盘图标失败：{err}")),
    }
}

/// release 为 GUI 子系统、无控制台：panic 默认无声无息地终结进程。hook 把
/// panic 信息 best-effort 追加到 exe 旁 panic.log（写不进就跳过），给现场
/// 排查留线索。不弹窗：采集线程经 catch_unwind 捕获的 panic 同样会过本
/// hook，弹窗会误扰正常收尾路径。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let msg = format!("[unix:{unix}] panic: {info}\n");
        #[cfg(debug_assertions)]
        println!("{msg}");
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let Some(dir) = exe.parent() else { return };
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("panic.log"))
        {
            use std::io::Write as _;
            let _ = file.write_all(msg.as_bytes());
        }
    }));
}

/// GUI 子系统没有控制台：致命错误用消息框呈现后退出
pub(crate) fn fatal(msg: &str) -> ! {
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(msg),
            &HSTRING::from("应用声音桥"),
            MB_OK | MB_ICONERROR,
        );
    }
    std::process::exit(1);
}

/// 读取系统 build 号。windows-version 是 windows-rs 官方配套 crate（内部
/// 即 RtlGetVersion，不受应用兼容性清单伪装影响），免去手写 unsafe
fn windows_build() -> u32 {
    windows_version::OsVersion::current().build
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进程级音频回路 API 门槛（Win10 20H1，build 19041）边界；windows_build
    /// 失败时返回 0，同样应被拦下
    #[test]
    fn build_supported_boundary() {
        assert!(!build_supported(0));
        assert!(!build_supported(MIN_BUILD - 1));
        assert!(build_supported(MIN_BUILD));
        assert!(build_supported(u32::MAX));
    }
}
