# app-audio-bridge —— 只分享一个桌面应用的声音

频道页「一起听 → **分享本机应用的声音**」直连使用的本机小工具（Rust 单文件
exe，托盘应用）。用 Windows 内置的 **WASAPI 进程级音频回路**（免驱动、免管理
员）按进程树采集指定应用的声音，频道页直接拉流混入发送——**不经本地扬声器**
（零重音）、无需浏览器选择器。

要求：Windows 10 20H1+ / Windows 11（启动时检查，过旧会弹窗报错退出）。

## 构建与使用

```bash
cd helper/app-audio-bridge
cargo build --release   # 产物 target/release/app-audio-bridge.exe（约 2MB），可拷走直接双击
```

**托盘运行**：exe 为 GUI 子系统——没有控制台黑窗，启动后常驻右下角托盘
（默认不弹网页）。exe 内嵌品牌图标与版本信息（资源管理器/任务栏/任务管理器
显示「应用声音桥」）。右键托盘图标：**打开页面**（浏览器访问
`http://127.0.0.1:8790`）/ **退出**。致命错误（系统过旧、端口全被占用）以
弹窗提示。debug 构建（`cargo build`）保留控制台并输出关键事件日志，便于排查。

1. 让目标应用（音乐客户端 / 游戏）出声
2. 频道页 → 点「一起听」→ **分享本机应用的声音** → 列表选它（只列能发声的应用，播放中的排最前）——本地零重音，远端只有该应用的声音

自带的页面（127.0.0.1:8790）只用于**试听确认**：选中应用后本页播放其声音（与源应用本地重音属正常现象），也可作为频道页直连不可用时的备用路径。

## 结构

| 模块              | 职责                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/wasapi.rs`   | 进程回路采集：[`wasapi` crate](https://crates.io/crates/wasapi) 的 `new_application_loopback_client`（EventsShared + AUTOCONVERTPCM，交付固定 48k/2ch/float32） |
| `src/sessions.rs` | 音频会话枚举（音量混合器名单）：wasapi 安全封装链（DeviceEnumerator → AudioSessionEnumerator），专职 COM 线程，零 unsafe                                        |
| `src/procinfo.rs` | 进程列表/内存/存活（`sysinfo`：系统级快照、免 unsafe，受保护进程照常列出）                                                                                      |
| `src/http.rs`     | axum：5 个端点 + CORS/Private-Network 头 + `/stream` broadcast 分块流（慢消费者各自丢帧，上限约 6 秒）                                                          |
| `src/state.rs`    | 共享采集状态机：`generation` 代次保护换源/停止/晚到回调，并发 start 经代次校验落座（被取代者自止，不泄漏采集线程）                                              |
| `src/main.rs`     | 托盘（`tray-icon` + `winit` 事件循环：图标/右键菜单/退出，主线程）、HTTP 后台线程、致命错误弹窗（winsafe）、panic 记录——**全项目零 unsafe**                     |
| `src/page.html`   | 内嵌试听页面，`include_str!` 打进 exe                                                                                                                           |
| `build.rs`        | exe 资源嵌入（图标 + 版本信息，`winresource` 纯 Rust 写资源、无需 rc.exe）                                                                                      |

## 开发

```bash
cd helper/app-audio-bridge
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test          # 单元测试（状态机 / 列表合并排序 / 契约常量），CI 在 windows-latest 上同款执行
```

改品牌图形后，同步再生成 PWA 图标与 exe 图标（同源渲染器）：

```bash
node scripts/gen-pwa-icons.js    # public/images/icon-*.png
node scripts/gen-helper-ico.js   # helper/app-audio-bridge/assets/icon.ico（多尺寸 ICO，构建时嵌入）
```

注意：`[profile.release]` **不能加 `panic = "abort"`**——`wasapi.rs` 用
`catch_unwind` 把采集线程 panic 转为正常收尾，abort 会让任何线程 panic 直接
带走整个进程。

## 契约与安全

- **端口双源**：本工具 `src/main.rs` 的 `PORTS`（8790~8794 顺延）与频道页
  `public/js/pages/channel/share.js` 的 `HELPER_PORTS` 是两份手抄，改动须两处
  同步。`/stream` 固定 48k/2ch/float32 交错（`src/state.rs` 常量），频道页与
  内嵌页均按 8 字节帧解析。
- **超时对齐**：`/api/start` 服务端激活等待 6s（`wasapi.rs` 的
  `ACTIVATE_TIMEOUT`），频道页客户端超时 8s——服务端必须先返回真实错误，
  客户端提前放弃会留下无主采集（现在双层防护：超时置位 stop + 落座代次校验）。
- **威胁模型（有意接受的权衡）**：CORS 对任意来源开放（ACAO `*` +
  Private-Network）——工具运行期间，任意网页都能枚举本机进程、启停采集、
  拉取音频。接受的前提是工具仅在使用者主动启动、做「一起听」分享的时段
  运行，进程名单与音频本就要交给频道页，以此换取单文件零配置。不用时退出
  托盘即可。若未来要收紧（Origin 白名单 / 一次性 token），须本工具 +
  `share.js` + 内嵌页三端同步改。
- **panic 排查**：release 无控制台，panic 信息会 best-effort 追加到 exe 旁
  `panic.log`（写不进则静默跳过）。

## 常见问题

- **频道页提示未检测到小工具**：确认托盘图标在（右下角，可能收进溢出折叠区）；频道页探测 127.0.0.1:8790~8794（端口被占自动顺延）。若频道页部署时 CSP 未放行这些地址（本仓库默认已放行），检查 `app/src/server.js` 的 connect-src。
- **应用列表为空**：先让目标应用出声（按活跃音频会话实时枚举），重新展开列表。
- **选中后远端没声**：同名多进程时频道页取「播放中」的会话；个别受保护进程（带反作弊的游戏）拒绝进程回路采集，见 [docs/share-app-audio.md](../../docs/share-app-audio.md) 备选方案。
- **端口说明**：默认 8790——浏览器把 8765 等端口列为受限端口（ERR_UNSAFE_PORT），不能用作服务端口。
