//! 进程枚举：CreateToolhelp32Snapshot 快照 + 工作集内存。
//!
//! 用快照而非 OpenProcess 存活探测：受保护进程（反作弊游戏等）会拒绝
//! OpenProcess，但快照照常列出它们，避免误判「进程已退出」。

use std::collections::HashMap;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// 工作集内存（MB，保留 1 位小数）——列表排序权重
    pub mem: f64,
}

/// 全部进程列表上限（与内嵌页展示一致）
const MAX_PROCESSES: usize = 600;

/// 一次性列出全部进程（可附带逐 pid 的工作集内存）
fn scan(with_mem: bool) -> Vec<(u32, String, f64)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let pid = entry.th32ProcessID;
            let name_len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if pid != 0 && !name.is_empty() {
                let mem = if with_mem { rss_mb(pid) } else { 0.0 };
                out.push((pid, name, mem));
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// 单进程工作集内存（MB）。打不开（权限/已退出）记 0，不阻塞列表。
fn rss_mb(pid: u32) -> f64 {
    unsafe {
        let Ok(process) = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        ) else {
            return 0.0;
        };
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let ok = GetProcessMemoryInfo(
            process,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if ok {
            round_mb(counters.WorkingSetSize as u64)
        } else {
            0.0
        }
    }
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
}
