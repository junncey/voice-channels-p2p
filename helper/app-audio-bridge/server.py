# -*- coding: utf-8 -*-
"""app-audio-bridge —— 只分享「一个桌面应用」声音的小工具。

配合频道页「一起听 → 分享标签页的声音」使用：本工具把指定进程树
的声音通过 Windows 内置的 WASAPI 进程级音频回路采出来（免驱动、
免管理员，Win10 20H1+ / Win11），在本页播放；频道页再像分享网页版
音乐一样分享「本标签页」，频道里就只有该应用的声音。

用法：
    python -m pip install -r requirements.txt
    python server.py            # 自动打开 http://127.0.0.1:8790
"""

import json
import platform
import queue
import sys
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psutil
    from proctap import ProcessAudioCapture
except ImportError:
    print('缺少依赖：请先执行  python -m pip install -r requirements.txt')
    sys.exit(1)

# proctap 在 Windows 的标准输出：48kHz 立体声 float32 交错
SAMPLE_RATE = 48000
CHANNELS = 2
HOST = '127.0.0.1'


def check_windows_build():
    """进程级音频回路 API 的最低系统要求。"""
    if platform.system() != 'Windows':
        print('本工具仅支持 Windows。')
        sys.exit(1)
    build = sys.getwindowsversion().build
    if build < 19041:  # Win10 2004 / 20H1
        print(f'系统版本过旧（build {build}）：进程级音频采集需要 Windows 10 20H1 或 Windows 11。')
        sys.exit(1)


class Capture:
    """单例采集器：持有 ProcessAudioCapture，向所有 /stream 订阅者供数。

    频道页与本工具页面可能同时拉流（直连 + 试听），每个 /stream 连接
    挂一条独立队列；慢消费者各自丢旧帧，互不影响。
    """

    # 单订阅者待发上限（约 6 秒 @10ms/块）：超出即丢最旧，防内存增长
    SUB_MAX_CHUNKS = 600

    def __init__(self):
        self.tap = None
        self.lock = threading.Lock()
        self.subs = {}  # id -> deque（该连接待发的 pcm 块）
        self.sub_seq = 0
        self.pid = None
        self.name = ''
        self.status = 'idle'  # idle | running | stopped
        self.error = ''

    def subscribe(self):
        with self.lock:
            self.sub_seq += 1
            dq = deque()
            self.subs[self.sub_seq] = dq
            return self.sub_seq, dq

    def unsubscribe(self, sid):
        with self.lock:
            self.subs.pop(sid, None)

    def start(self, pid, name):
        self.stop()
        tap = ProcessAudioCapture(pid=pid, on_data=self._on_data)
        try:
            tap.start()
        except Exception as exc:  # 进程不存在 / 已退出 / 设备初始化失败
            try:
                tap.close()
            except Exception:
                pass
            raise RuntimeError(str(exc)) from exc
        with self.lock:
            for dq in self.subs.values():
                dq.clear()  # 换源：旧数据作废
            self.tap = tap
            self.pid = pid
            self.name = name
            self.status = 'running'
            self.error = ''
        threading.Thread(target=self._monitor, daemon=True).start()

    def stop(self):
        with self.lock:
            tap, self.tap = self.tap, None
            self.pid = None
            self.name = ''
            self.status = 'idle'
            self.error = ''
            for dq in self.subs.values():
                dq.clear()
        if tap:
            try:
                tap.stop()
            except Exception:
                pass
            try:
                tap.close()
            except Exception:
                pass

    def _on_data(self, pcm, frames):
        with self.lock:
            for dq in self.subs.values():
                dq.append(pcm)
                while len(dq) > self.SUB_MAX_CHUNKS:
                    dq.popleft()

    def _monitor(self):
        """进程退出 / 底层异常时自动收尾并置状态。"""
        tap = self.tap
        while tap is not None and tap is self.tap:
            try:
                if not tap.is_running:  # property：内部采集线程是否存活
                    with self.lock:
                        if self.tap is tap:
                            self.tap = None
                            self.status = 'stopped'
                    try:
                        tap.close()
                    except Exception:
                        pass
                    return
            except Exception as exc:
                with self.lock:
                    if self.tap is tap:
                        self.tap = None
                        self.status = 'stopped'
                        self.error = str(exc)
                return
            time.sleep(0.5)

    def snapshot(self):
        with self.lock:
            return {
                'status': self.status,
                'pid': self.pid,
                'name': self.name,
                'error': self.error,
                'rate': SAMPLE_RATE,
                'channels': CHANNELS,
            }


CAP = Capture()

# 音频应用列表缓存：会话枚举有 COM 开销，页面 3s 自动刷新时不重算
_APPS_CACHE = {'at': 0.0, 'data': None}

# pycaw 的 COM 对象（设备枚举器等）绑定创建线程，跨线程复用会失败——
# ThreadingHTTPServer 每连接一个新线程，因此把枚举固定到下面这个专职线程
_ENUM_Q = queue.Queue()


def _enum_worker():
    from pycaw.pycaw import AudioUtilities

    while True:
        reply = _ENUM_Q.get()
        try:
            sessions = []
            for sess in AudioUtilities.GetAllSessions():
                proc = sess.Process
                if not proc or not proc.pid:
                    continue  # 系统声音等无进程会话
                try:
                    sessions.append(
                        (proc.pid, proc.name() or f'PID {proc.pid}', int(sess.State) == 1)
                    )
                except Exception:
                    continue
            reply.put(('ok', sessions))
        except Exception as exc:
            reply.put(('err', str(exc)))


def audio_sessions(timeout=3.0):
    """在专职线程上枚举音频会话，返回 [(pid, name, active)]。"""
    reply = queue.Queue()
    _ENUM_Q.put(reply)
    status, payload = reply.get(timeout=timeout)
    if status != 'ok':
        raise RuntimeError(payload)
    return payload


def list_audio_apps():
    """有音频会话的应用（即音量混合器里那份名单）——按应用名分组。

    每项含该应用的全部会话进程（正在发声的排前面），页面端点击时
    优先选 active 的 PID；同名多进程（Electron 类）自动轮换重试。
    """
    apps = {}
    fallback = ''
    try:
        for pid, name, active in audio_sessions():
            entry = apps.setdefault(name, {'pids': {}})
            entry['pids'][pid] = entry['pids'].get(pid, False) or active
    except Exception as exc:  # 无默认音频设备 / COM 失败：交给全量回退
        fallback = str(exc)
    result = []
    for name, entry in apps.items():
        pids, mem = [], 0.0
        for pid, active in entry['pids'].items():
            try:
                mem = max(mem, psutil.Process(pid).memory_info().rss / 1048576)
            except Exception:
                pass
            pids.append({'pid': pid, 'active': active})
        pids.sort(key=lambda x: not x['active'])  # 正在发声的优先被选中
        result.append({'name': name, 'mem': round(mem, 1), 'pids': pids, 'active': pids[0]['active']})
    result.sort(key=lambda x: (not x['active'], -x['mem']))
    data = {'apps': result, 'fallback': fallback}
    _APPS_CACHE['data'] = data
    _APPS_CACHE['at'] = time.time()
    return data


def cached_audio_apps():
    if _APPS_CACHE['data'] is not None and time.time() - _APPS_CACHE['at'] < 1.5:
        return _APPS_CACHE['data']
    return list_audio_apps()


def list_processes():
    """全部进程（pid/名称/内存）——「显示全部进程」开关与回退用。"""
    items = {}
    for proc in psutil.process_iter(['pid', 'name', 'memory_info']):
        info = proc.info
        name = info.get('name') or ''
        pid = info.get('pid')
        if not name or pid is None:
            continue
        mem_info = info.get('memory_info')
        mem = round(mem_info.rss / 1048576, 1) if mem_info else 0
        items[(name.lower(), pid)] = {'pid': pid, 'name': name, 'mem': mem}
    return sorted(items.values(), key=lambda x: (-x['mem'], x['name'].lower()))[:600]


PAGE = r"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>应用声音桥 · 只分享一个应用的声音</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif;
         background: #10151c; color: #e8edf2; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #9fb0c0; margin-bottom: 18px; }
  .guide { border: 1px solid #2a3a4a; background: #16202b; border-radius: 10px;
           padding: 10px 14px; margin-bottom: 18px; }
  .guide ol { margin: 6px 0 2px; padding-left: 20px; }
  .guide b { color: #7fd1a8; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  input[type=search] { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #2a3a4a;
        background: #0d141c; color: #e8edf2; font-size: 14px; }
  #status { padding: 8px 12px; border-radius: 8px; background: #0d141c;
            border: 1px solid #2a3a4a; }
  #status.running { border-color: #2f7d4f; color: #7fd1a8; }
  #status.stopped { border-color: #8a5a2a; color: #e0b070; }
  #meter { height: 6px; border-radius: 3px; background: #0d141c; overflow: hidden;
           border: 1px solid #2a3a4a; margin-bottom: 12px; }
  #meterBar { height: 100%; width: 0%; background: linear-gradient(90deg,#2f7d4f,#c9b458); }
  #plist { border: 1px solid #2a3a4a; border-radius: 10px; overflow: hidden; }
  .prow { display: flex; gap: 10px; padding: 7px 12px; cursor: pointer; border-bottom: 1px solid #1c2937; }
  .prow:hover { background: #1a2937; }
  .prow .pid { color: #9fb0c0; width: 64px; flex: none; }
  .prow .mem { color: #6c8095; width: 84px; flex: none; text-align: right; }
  .badge { margin-left: auto; font-size: 12px; padding: 1px 8px; border-radius: 10px; flex: none; }
  .badge.on { background: #1d4030; color: #7fd1a8; }
  .badge.off { background: #2a2f36; color: #8a97a3; }
  button { padding: 8px 14px; border-radius: 8px; border: 1px solid #2a3a4a;
           background: #16202b; color: #e8edf2; cursor: pointer; }
  button:hover { border-color: #3d5670; }
  .hint { color: #9fb0c0; font-size: 12.5px; margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>应用声音桥</h1>
  <div class="sub">选中一个应用，它的声音（含子进程）只在本页播放；回频道页「一起听」分享「本标签页」即可</div>
  <div class="guide">
    <b>推荐：频道页直连（无重音）</b>
    <ol>
      <li>让目标应用（音乐客户端 / 游戏）出声</li>
      <li>频道页 → 点「一起听」→ 选<b>分享本机应用的声音</b> → 列表选它（需本工具在后台运行即可，无需分享本页）</li>
    </ol>
    <b>本页仅用于试听确认</b>：选中应用后本页会播放它的声音——注意与源应用本地重音属正常现象。
  </div>
  <div id="status">未在采集</div>
  <div id="meter"><div id="meterBar"></div></div>
  <div class="row">
    <input id="q" type="search" placeholder="搜索应用名或 PID，如 cloudmusic / 1234" autofocus />
    <button id="allBtn" type="button">显示全部进程</button>
    <button id="stopBtn" type="button">停止</button>
  </div>
  <div id="plist"></div>
  <div class="hint">列表只显示能发声的应用（同 Windows 音量混合器），正在播放的排最前、点它即可。同名多进程时点击会自动轮换重试。</div>
</div>
<script>
'use strict';
const $ = (id) => document.getElementById(id);
let mode = 'apps';            // apps = 只列能发声的应用；all = 全部进程
let data = { apps: [], all: [] };
const rotation = {};          // 应用名 -> 已点击次数（同名多进程轮换重试）
const fmt = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB');

async function refreshList() {
  try {
    const res = await fetch('/api/processes' + (mode === 'all' ? '?all=1' : ''));
    const next = await res.json();
    if (next.apps) data.apps = next.apps;
    if (next.all) data.all = next.all;
    render();
  } catch { /* 服务重启瞬间忽略 */ }
}
function emptyRow(text) {
  const d = document.createElement('div');
  d.className = 'prow';
  d.style.cursor = 'default';
  d.textContent = text;
  return d;
}
function render() {
  const q = $('q').value.trim().toLowerCase();
  const box = $('plist');
  if (mode === 'apps') {
    const list = data.apps.filter((a) =>
      !q || a.name.toLowerCase().includes(q) || a.pids.some((p) => String(p.pid).includes(q)));
    if (!list.length) {
      const why = data.fallback ? `（枚举失败：${data.fallback}）` : '';
      box.replaceChildren(emptyRow(`没有检测到能发声的应用——先让目标应用播放声音${why}`));
      return;
    }
    box.replaceChildren(...list.map((a) => {
      const row = document.createElement('div');
      row.className = 'prow';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = a.name;
      const mem = document.createElement('span'); mem.className = 'mem'; mem.textContent = fmt(a.mem);
      const badge = document.createElement('span');
      badge.className = 'badge ' + (a.active ? 'on' : 'off');
      badge.textContent = (a.active ? '播放中' : '空闲') + (a.pids.length > 1 ? ' ×' + a.pids.length : '');
      row.append(name, mem, badge);
      row.title = a.pids.map((p) => `PID ${p.pid}${p.active ? '（播放中）' : ''}`).join('\n');
      row.onclick = () => {
        // 正在发声的进程已排在最前；同名多进程时点击轮换重试
        const idx = (rotation[a.name] || 0) % a.pids.length;
        rotation[a.name] = idx + 1;
        start({ pid: a.pids[idx].pid, name: a.name });
      };
      return row;
    }));
  } else {
    const list = data.all.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q)).slice(0, 300);
    box.replaceChildren(...(list.length ? list.map((p) => {
      const row = document.createElement('div');
      row.className = 'prow';
      const pid = document.createElement('span'); pid.className = 'pid'; pid.textContent = p.pid;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = p.name;
      const mem = document.createElement('span'); mem.className = 'mem'; mem.textContent = fmt(p.mem);
      row.append(pid, name, mem);
      row.onclick = () => start(p);
      return row;
    }) : [emptyRow('没有匹配的进程')]));
  }
}
async function start(p) {
  stopPlayback();
  const res = await fetch('/api/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: p.pid, name: p.name }),
  });
  const data = await res.json();
  if (!data.ok) { setStatus('启动失败：' + (data.error || '未知错误'), 'stopped'); return; }
  setStatus(`采集中：${p.name}（PID ${p.pid}），正在播放它的声音`, 'running');
  beginPlayback();
}
async function stopAll() {
  stopPlayback();
  await fetch('/api/stop', { method: 'POST' });
  setStatus('已停止', '');
}
function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}
$('stopBtn').onclick = stopAll;
$('q').oninput = render;
$('allBtn').onclick = () => {
  mode = mode === 'apps' ? 'all' : 'apps';
  $('allBtn').textContent = mode === 'apps' ? '显示全部进程' : '只显示能发声的';
  refreshList();
};

// ---- 播放：fetch /stream 二进制 float32 → WebAudio 队列 ----
let playAbort = null;
let ctx = null, analyser = null, meterRAF = 0;
function stopPlayback() {
  if (playAbort) { playAbort.abort(); playAbort = null; }
  if (meterRAF) { cancelAnimationFrame(meterRAF); meterRAF = 0; }
}
async function beginPlayback() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ctx.destination);
  }
  await ctx.resume();  // 由「点选进程」的手势激活
  runMeter();
  playAbort = new AbortController();
  try {
    const res = await fetch('/stream', { signal: playAbort.signal });
    const reader = res.body.getReader();
    let nextTime = 0;
    let pending = new Uint8Array(0); // read() 按网络任意切割，跨段累积对齐到整帧（8 字节）
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(pending.length + value.byteLength);
      merged.set(pending);
      merged.set(value, pending.length);
      const usable = Math.floor(merged.byteLength / 8) * 8;
      pending = merged.slice(usable);
      const frames = usable / 8;
      if (!frames) continue;
      const work = merged.slice(0, usable); // 独立副本，byteOffset 归零保证 Float32 对齐
      const interleaved = new Float32Array(work.buffer, 0, frames * 2);
      const buf = ctx.createBuffer(2, frames, 48000);
      const l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) { l[i] = interleaved[i * 2]; r[i] = interleaved[i * 2 + 1]; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      const now = ctx.currentTime;
      if (nextTime < now + 0.03) nextTime = now + 0.03;   // 30ms 起播余量
      if (nextTime > now + 0.35) nextTime = now + 0.06;   // 落后过多：丢帧追上
      src.start(nextTime);
      nextTime += buf.duration;
    }
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('播放中断：' + err.message, 'stopped');
    return;
  }
  setStatus('采集已结束（进程退出或被停止）', 'stopped');
}
function runMeter() {
  if (!analyser) return;
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
    $('meterBar').style.width = Math.min(100, (peak / 128) * 100 * 1.4) + '%';
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

// 状态轮询：进程退出时服务端会结束 /stream，这里兜底刷新显示
setInterval(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.status !== 'running' && playAbort) {
      stopPlayback();
      setStatus('采集已结束（进程退出或被停止）', 'stopped');
    }
  } catch { /* 服务不在了 */ }
}, 1500);

// 空闲时自动刷新「能发声的应用」列表（播放状态会变化）
setInterval(() => { if (!playAbort && mode === 'apps') refreshList(); }, 3000);

refreshList();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass  # 静默访问日志，只留关键事件

    def end_headers(self):
        # 频道页跨域直连（http(s) 页面 → 127.0.0.1）：全部响应带 CORS；
        # Private-Network 头应对 Chrome 专属预检（https 页面访问本机）
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _json(self, obj, code = 200):
        body = json.dumps(obj, ensure_ascii = False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/':
            body = PAGE.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith('/api/processes'):
            try:
                if 'all=1' in self.path:
                    self._json({'all': list_processes()})
                else:
                    self._json(cached_audio_apps())
            except Exception as exc:
                self._json({'error': str(exc)}, 500)
        elif self.path == '/api/status':
            self._json(CAP.snapshot())
        elif self.path == '/stream':
            self._stream()
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b'{}'
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except ValueError:
            self._json({'ok': False, 'error': 'bad json'}, 400)
            return
        if self.path == '/api/start':
            pid = payload.get('pid')
            name = str(payload.get('name') or '')
            if not isinstance(pid, int) or pid <= 0:
                self._json({'ok': False, 'error': '无效的 PID'}, 400)
                return
            try:
                CAP.start(pid, name)
                print(f'[start] pid={pid} name={name}')
                self._json({'ok': True, **CAP.snapshot()})
            except Exception as exc:
                print(f'[start-failed] pid={pid}: {exc}')
                self._json({'ok': False, 'error': str(exc)}, 400)
        elif self.path == '/api/stop':
            CAP.stop()
            self._json({'ok': True, **CAP.snapshot()})
        else:
            self._json({'ok': False, 'error': 'not found'}, 404)

    def _stream(self):
        sid, dq = CAP.subscribe()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            while True:
                with CAP.lock:
                    chunks = list(dq)
                    dq.clear()
                    running = CAP.status == 'running'
                for chunk in chunks:
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                if not chunks:
                    if not running:
                        break
                    time.sleep(0.01)
                    continue
            self.wfile.write(b'0\r\n\r\n')
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 页面关闭/刷新：正常退出
        finally:
            CAP.unsubscribe(sid)


def pick_port(start=8790, count=6):
    """8790 起：浏览器把 8765 等端口列为受限端口（ERR_UNSAFE_PORT），
    频道页直连时 fetch 会静默失败，必须避开。"""
    import socket

    for port in range(start, start + count):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex((HOST, port)) != 0:
                return port
    raise SystemExit(f'{start}~{start + count - 1} 端口都被占用，无法启动')


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        """页面关闭/刷新导致的连接中断是常态，不打堆栈。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    check_windows_build()
    threading.Thread(target=_enum_worker, daemon=True, name='audio-enum').start()
    port = pick_port()
    server = QuietServer((HOST, port), Handler)
    url = f'http://{HOST}:{port}'
    print(f'应用声音桥已启动：{url}  （Ctrl+C 退出）')
    print('步骤：选目标进程 → 回频道页「一起听」→ 分享本标签页并勾选「分享标签页声音」')
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        CAP.stop()
        server.server_close()


if __name__ == '__main__':
    main()
