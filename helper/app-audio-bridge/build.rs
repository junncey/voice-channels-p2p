//! 构建脚本：把应用图标与版本信息编进 exe 资源——资源管理器 / 任务栏 /
//! 任务管理器的品牌呈现。图标为 assets/icon.ico（由仓库根
//! scripts/gen-helper-ico.js 从品牌渲染器生成，与 PWA 图标同源）。

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    // winresource 在 MSVC 下纯 Rust 写资源对象，不依赖 Windows SDK 的 rc.exe
    let version = env!("CARGO_PKG_VERSION");
    let mut resource = winresource::WindowsResource::new();
    resource
        .set_icon("assets/icon.ico")
        .set("FileDescription", "应用声音桥——只分享一个桌面应用的声音")
        .set("ProductName", "app-audio-bridge")
        .set("FileVersion", version)
        .set("ProductVersion", version);
    if let Err(err) = resource.compile() {
        panic!("嵌入 exe 资源失败：{err}");
    }
    println!("cargo:rerun-if-changed=assets/icon.ico");
}
