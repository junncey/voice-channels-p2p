# app-audio-bridge —— 只分享一个桌面应用的声音

频道页「一起听 → **分享本机应用的声音**」直连使用的本机小工具（Rust 单文件
exe）。用 Windows 内置的 **WASAPI 进程级音频回路**（免驱动、免管理员）按进程
树采集指定应用的声音，频道页直接拉流混入发送——**不经本地扬声器**（零重音）、
无需浏览器选择器。

要求：Windows 10 20H1+ / Windows 11（启动时检查，过旧会明确报错退出）。

## 构建与使用

```bash
cd helper/app-audio-bridge
cargo build --release                        # 产物 target/release/app-audio-bridge.exe（约 1.9MB）
./target/release/app-audio-bridge.exe        # 双击或命令行运行均可，自动打开试听页面
```

1. 让目标应用（音乐客户端 / 游戏）出声
2. 频道页 → 点「一起听」→ **分享本机应用的声音** → 列表选它（只列能发声的应用，播放中的排最前）——本地零重音，远端只有该应用的声音

本工具自带的页面（127.0.0.1:8790）只用于**试听确认**：选中应用后本页播放其声音（与源应用本地重音属正常现象），也可作为频道页直连不可用时的备用路径。

## 结构

| 模块              | 职责                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/wasapi.rs`   | 进程回路采集：[`wasapi` crate](https://crates.io/crates/wasapi) 的 `new_application_loopback_client`（EventsShared + AUTOCONVERTPCM，交付固定 48k/2ch/float32） |
| `src/sessions.rs` | 音频会话枚举（音量混合器名单，专职 COM 线程）                                                                                                                   |
| `src/procinfo.rs` | 进程列表/内存/存活（Toolhelp 快照 + `GetProcessMemoryInfo`）                                                                                                    |
| `src/http.rs`     | axum：5 个端点 + CORS/Private-Network 头 + `/stream` broadcast 分块流（慢消费者各自丢帧，上限约 6 秒）                                                          |
| `src/page.html`   | 内嵌试听页面，`include_str!` 打进 exe                                                                                                                           |

## 常见问题

- **频道页提示未检测到小工具**：确认 exe 在跑；频道页探测 127.0.0.1:8790~8794（端口被占自动顺延）。若频道页部署时 CSP 未放行这些地址（本仓库默认已放行），检查 `app/src/server.js` 的 connect-src。
- **应用列表为空**：先让目标应用出声（按活跃音频会话实时枚举），重新展开列表。
- **选中后远端没声**：同名多进程时频道页取「播放中」的会话；个别受保护进程（带反作弊的游戏）拒绝进程回路采集，见 [docs/share-app-audio.md](../../docs/share-app-audio.md) 备选方案。
- **端口说明**：默认 8790——浏览器把 8765 等端口列为受限端口（ERR_UNSAFE_PORT），不能用作服务端口。
