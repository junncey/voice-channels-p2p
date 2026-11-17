//! 进程枚举：sysinfo（Windows 底层为系统级进程快照，不逐个打开进程句柄——
//! 受保护进程（反作弊游戏等）照常列出，避免误判「进程已退出」）。

use std::collections::HashMap;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// 工作集内存（MB，保留 1 位小数）——列表排序权重
    pub mem: f64,
}

/// 全部进程列表上限（与内嵌页展示一致）
const MAX_PROCESSES: usize = 600;

/// 浏览器进程名（小写、不含 .exe）。浏览器有自己的标签页分享方案，且其
/// 常驻活跃会话会霸占「正在发声」排序头部，从「能发声的应用」列表排除
/// （`?all=1` 全量列表不受影响）。补充名单直接在此追加。
const BROWSER_EXES: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "opera",
    "brave",
    "vivaldi",
    "librewolf",
    "waterfox",
    "arc",
    "qqbrowser",
    "360se",
    "360chrome",
    "2345explorer",
    "sogouexplorer",
    "maxthon",
];

/// 常见应用的产品名映射（exe 小写 → 展示名）：列表展示产品名而非文件名
const FRIENDLY_NAMES: &[(&str, &str)] = &[
    ("cloudmusic", "网易云"),
    ("qqmusic", "QQ音乐"),
    ("kugou", "酷狗音乐"),
    ("kuwo", "酷我音乐"),
    ("kwmusic", "酷我音乐"),
    ("weixin", "微信"),
    ("wxwork", "企业微信"),
    ("feishu", "飞书"),
    ("dingtalk", "钉钉"),
];

/// 去掉大小写不敏感的 .exe 后缀
fn exe_stem(exe: &str) -> &str {
    if exe.len() > 4 && exe[exe.len() - 4..].eq_ignore_ascii_case(".exe") {
        &exe[..exe.len() - 4]
    } else {
        exe
    }
}

/// 是否浏览器进程（「能发声的应用」列表排除用）
pub fn is_browser(exe: &str) -> bool {
    BROWSER_EXES
        .iter()
        .any(|browser| browser.eq_ignore_ascii_case(exe_stem(exe)))
}

/// 进程名的展示形态：已知产品映射为产品名（cloudmusic.exe → 网易云），
/// 其余去 .exe 后缀（Weixin.exe → Weixin）
pub fn display_name(exe: &str) -> String {
    let stem = exe_stem(exe);
    match FRIENDLY_NAMES
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(stem))
    {
        Some((_, name)) => (*name).to_string(),
        None => stem.to_string(),
    }
}

/// 全量进程快照（pid/名称/内存）。`with_mem=false` 只刷名单（存活探测的
/// 500ms 周期路径）；名称在快照中始终自带，内存按需刷新。
fn scan(with_mem: bool) -> Vec<(u32, String, f64)> {
    let Ok(mut system) = System::new() else {
        return Vec::new();
    };
    let mut refresh = ProcessRefreshKind::nothing();
    if with_mem {
        refresh = refresh.with_memory();
    }
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let name = process.name().to_string_lossy().into_owned();
            let mem = if with_mem {
                round_mb(process.memory())
            } else {
                0.0
            };
            (pid.as_u32(), name, mem)
        })
        .filter(|&(pid, ref name, _)| pid != 0 && !name.is_empty())
        .collect()
}

/// 工作集字节数 → MB（保留 1 位小数）
fn round_mb(bytes: u64) -> f64 {
    (bytes as f64 / 1048576.0 * 10.0).round() / 10.0
}

/// 全部进程（pid/名称/内存）——「显示全部进程」开关用：内存降序、名称升序，截 600。
pub fn list_processes() -> Vec<ProcessInfo> {
    sort_and_truncate(
        scan(true)
            .into_iter()
            .map(|(pid, name, mem)| ProcessInfo { pid, name, mem })
            .collect(),
    )
}

/// 内存降序 → 名称小写升序 → 截断（total_cmp：NaN 安全）
fn sort_and_truncate(mut items: Vec<ProcessInfo>) -> Vec<ProcessInfo> {
    items.sort_by(|a, b| {
        b.mem
            .total_cmp(&a.mem)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    items.truncate(MAX_PROCESSES);
    items
}

/// pid → (进程名, 内存)：音频会话列表取名与内存聚合用
pub fn process_map() -> HashMap<u32, (String, f64)> {
    scan(true)
        .into_iter()
        .map(|(pid, name, mem)| (pid, (name, mem)))
        .collect()
}

/// 进程是否仍在（快照查询，500ms 周期调用开销可接受）
pub fn pid_alive(pid: u32) -> bool {
    scan(false).iter().any(|&(p, _, _)| p == pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(pid: u32, name: &str, mem: f64) -> ProcessInfo {
        ProcessInfo {
            pid,
            name: name.to_string(),
            mem,
        }
    }

    #[test]
    fn sorts_by_mem_desc_then_name_asc_and_truncates() {
        let mut items: Vec<_> = (0..700)
            .map(|i| info(i as u32 + 1, &format!("p{i:03}"), 1.0))
            .collect();
        items.push(info(1000, "big.exe", 999.0));
        items.push(info(1001, "a.exe", 5.0));
        items.push(info(1002, "b.exe", 5.0));
        let sorted = sort_and_truncate(items);
        assert_eq!(sorted.len(), MAX_PROCESSES);
        assert_eq!(sorted[0].name, "big.exe", "内存降序");
        assert_eq!(sorted[1].name, "a.exe");
        assert_eq!(sorted[2].name, "b.exe", "同内存按名称小写升序");
    }

    #[test]
    fn round_mb_keeps_one_decimal() {
        assert_eq!(round_mb(0), 0.0);
        assert_eq!(round_mb(1048576), 1.0);
        assert_eq!(round_mb(15 * 1048576 + 100 * 1024), 15.1);
    }

    /// 真实快照冒烟：本进程必须在场（sysinfo 快照含自身，无需打开句柄）
    #[test]
    fn snapshot_lists_running_processes() {
        let items = list_processes();
        assert!(!items.is_empty());
        assert!(items.iter().all(|p| p.pid > 0 && !p.name.is_empty()));
        assert!(items.iter().any(|p| p.pid == std::process::id()));
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn browser_detection_covers_common_browsers() {
        assert!(is_browser("chrome.exe"));
        assert!(is_browser("msedge.exe"));
        assert!(is_browser("QQBrowser.EXE"), "大小写不敏感");
        assert!(is_browser("360chrome.exe"));
        assert!(!is_browser("cloudmusic.exe"));
        assert!(
            !is_browser("msedgewebview2.exe"),
            "WebView2 宿主载着真实应用的声音，保留"
        );
    }

    #[test]
    fn display_name_maps_products_and_strips_exe() {
        assert_eq!(display_name("cloudmusic.exe"), "网易云");
        assert_eq!(display_name("QQMusic.exe"), "QQ音乐");
        assert_eq!(display_name("Weixin.exe"), "微信");
        assert_eq!(
            display_name("Scrcpy.EXE"),
            "Scrcpy",
            "未知产品去 .exe 后缀、保留原大小写"
        );
        assert_eq!(display_name("foobar2000"), "foobar2000", "无后缀原样返回");
    }
}
