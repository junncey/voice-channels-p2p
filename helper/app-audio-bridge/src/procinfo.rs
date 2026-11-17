//! 进程枚举：CreateToolhelp32Snapshot 快照 + 工作集内存。
//!
//! 用快照而非 OpenProcess 存活探测：受保护进程（反作弊游戏等）会拒绝
//! OpenProcess，但快照照常列出它们，避免误判「进程已退出」。

use std::collections::HashMap;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
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
            (counters.WorkingSetSize as f64 / 1048576.0 * 10.0).round() / 10.0
        } else {
            0.0
        }
    }
}

/// 全部进程（pid/名称/内存）——「显示全部进程」开关用：内存降序、名称升序，截 600。
pub fn list_processes() -> Vec<ProcessInfo> {
    let mut items: Vec<ProcessInfo> = scan(true)
        .into_iter()
        .map(|(pid, name, mem)| ProcessInfo { pid, name, mem })
        .collect();
    items.sort_by(|a, b| {
        b.mem.partial_cmp(&a.mem).unwrap_or(std::cmp::Ordering::Equal).then_with(|| {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        })
    });
    items.truncate(600);
    items
}

/// pid → (进程名, 内存)：音频会话列表取名与内存聚合用
pub fn process_map() -> HashMap<u32, (String, f64)> {
    scan(true).into_iter().map(|(pid, name, mem)| (pid, (name, mem))).collect()
}

/// 进程是否仍在（快照查询，500ms 周期调用开销可接受）
pub fn pid_alive(pid: u32) -> bool {
    scan(false).iter().any(|&(p, _, _)| p == pid)
}
