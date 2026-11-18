/*
链路质量引擎 —— 自愈家族的质量半区（1000 行预算时从
recovery.js 拆出，与 channel/relay.js 同族；所需状态经注入
的引用仍由页面持有）。

由恢复引擎的路径轮询喂养（checkPeerPath -> note(info)）：

  - 入向链路质量：累计 RTP 计数器说明不了任何「速率」，所以
    每次轮询都对 packetsLost/packetsReceived/jitter/掩蔽做差分。
    持续高丢包翻转成员卡片的「不稳定」徽章（带迟滞，单次坏
    轮询不会让它闪烁）；逐轮数值喂给路径徽章的悬停详情
    （路径徽章的渲染也在这里）。
  - 出向丢包适应：对端接收端报告（fractionLost）反映的是
    我们发出的流，据此把该链路的发送码率压到地板，直到报告
    转好，再沿探测阶梯爬回。
  - 抖动/掩蔽加深：当听者「听得到」的毛刺持续存在时
    （NetEQ 掩蔽率是 ground truth），抬高接收侧播放缓冲
    目标；平息后恢复浏览器默认。
  - 僵尸链路 + 质量重启：媒体已死却「仍保持连接」的链路
    （入向 RTP 为零 / 严重持续丢包 / 出向黑洞）做一次
    iceRestart —— 是路由本身需要重新打洞，适应只是缓解
    症状。带冷却且防 glare（见 pokeIce）。

处处尊重 peerRecovery 的成员资格：已在恢复阶梯上的链路
交给它处理。
*/

/**
 * 同一窗口内的 NetEQ 掩蔽率（%）：两次轮询的累计计数器差分。
 * 任一计数器未上报（null）或窗口无增量 → null——
 * 所有消费方都视为「无结论」，绝不当作 0。
 */
function windowConcealPct(prev, cur) {
    if (
        prev.concealedSamples === null ||
        cur.concealedSamples === null ||
        prev.totalSamplesReceived === null ||
        cur.totalSamplesReceived === null
    ) {
        return null;
    }
    const dTotal = cur.totalSamplesReceived - prev.totalSamplesReceived;
    if (dTotal <= 0) return null;
    return Math.round(((cur.concealedSamples - prev.concealedSamples) / dTotal) * 1000) / 10;
}

/**
 * 同一窗口内实际达成的播放缓冲延迟（ms）—— 闭环抖动加深：
 * 浏览器真正生效的目标会在这里显现（delay 是累计秒数，
 * count 是累计帧数；窗口比值即平均深度）。未上报或无增量
 * → null。
 */
function windowJbDelayMs(prev, cur) {
    if (
        prev.jitterBufferDelay === null ||
        cur.jitterBufferDelay === null ||
        prev.jitterBufferEmittedCount === null ||
        cur.jitterBufferEmittedCount === null
    ) {
        return null;
    }
    const dCount = cur.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
    if (dCount <= 0) return null;
    return Math.round(((cur.jitterBufferDelay - prev.jitterBufferDelay) / dCount) * 1000);
}

export function createLinkQuality({ s, members, peerRecovery, connPaths, $, el, t }) {
    function pathBadgeNode(peerId) {
        const node = el('span', { class: 'badge path-badge' });
        fillPathBadge(node, peerId);
        return node;
    }

    function updatePeerPathBadge(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"] .path-badge`);
        if (node) fillPathBadge(node, peerId);
    }

    function fillPathBadge(node, peerId) {
        const info = connPaths.get(peerId);
        const known = !!info && (info.type === 'p2p' || info.type === 'relay');
        node.classList.toggle('on', known);
        node.classList.toggle('relay', known && info.type === 'relay');
        node.textContent = known ? t(info.type === 'p2p' ? 'channel.pathP2p' : 'channel.pathRelay') : '';
        if (!known) {
            node.removeAttribute('title');
            return;
        }
        // 延迟内联在链路标签之后；null = 选中的候选对报告没有
        // 暴露 currentRoundTripTime —— 徽章保持只有标签。
        // 单独的空格文本节点会被 flex 布局吞掉（gap: 4px 已做
        // 分隔），但让「P2P 45ms」保留为徽章的文本内容
        const quality = lossStreaks.get(peerId);
        if (info.rtt !== null) node.append(' ', el('span', { class: 'rtt', text: `${info.rtt}ms` }));
        // 当前丢包标记：不悬停也能一眼看到
        if (quality && quality.loss !== null && quality.loss >= 5)
            node.append(
                ' ',
                el('span', { class: 'loss', text: t('channel.pathLoss', { n: Math.round(quality.loss) }) })
            );
        // 悬停详情：两端的候选类型（host/srflx/prflx/relay）+ RTT
        // + 入向质量（丢包 / 抖动 / 码率，逐轮差分）
        const parts = [t(info.type === 'p2p' ? 'channel.pathP2pTitle' : 'channel.pathRelayTitle')];
        if (info.local && info.remote) parts.push(`${info.local} ↔ ${info.remote}`);
        if (info.rtt !== null) parts.push(t('channel.pathRtt', { n: info.rtt }));
        if (quality) {
            if (quality.loss !== null) parts.push(t('channel.pathLoss', { n: quality.loss }));
            if (quality.jitter !== null) parts.push(t('channel.pathJitter', { n: quality.jitter }));
            if (quality.conceal !== null && quality.conceal > 0)
                parts.push(t('channel.pathConceal', { n: quality.conceal }));
            // 实际达成的播放缓冲深度 —— 加深目标是否落地
            if (quality.jbDelay !== null && quality.jbDelay > 0)
                parts.push(t('channel.pathPlayout', { n: quality.jbDelay }));
            if (quality.kbps !== null) parts.push(t('channel.pathBitrate', { n: quality.kbps }));
            // 出向孪生指标（对端对我们流的报告 + 我们编码器的
            // 实际输出）—— 画面里的发送侧一半
            if (quality.outLoss !== null && quality.outLoss > 0)
                parts.push(t('channel.pathOutLoss', { n: quality.outLoss }));
            if (quality.outJitter !== null && quality.outJitter >= 5)
                parts.push(t('channel.pathOutJitter', { n: quality.outJitter }));
            if (quality.outKbps !== null) parts.push(t('channel.pathOutBitrate', { n: quality.outKbps }));
        }
        node.title = parts.join(' · ');
    }

    // -------------------------------------------------------------------------
    // 入向链路质量 —— 累计 RTP 计数器说明不了任何「速率」，所以
    // 每次路径轮询都与上一轮差分 packetsLost/packetsReceived。
    // 持续高丢包在成员卡片上翻转「不稳定」徽章
    // （带迟滞，单次坏轮询不会让它闪烁）；
    // 逐轮数值喂给路径徽章的悬停详情。
    // 只评判「活着」的链路 —— 损坏的链路已经显示恢复徽章。
    // -------------------------------------------------------------------------

    const LOSS_BAD_PCT = 10; // 达到/超过此值的一轮算坏
    const LOSS_OK_PCT = 5; // 低于/等于此值算好（介于其间：都不算）
    const UNSTABLE_BAD_POLLS = 3; // 按 5s 轮询节奏约 15s → 徽章点亮
    const UNSTABLE_GOOD_POLLS = 2; // 徽章熄灭前需要的干净轮数
    // 出向丢包（对端接收端报告关于我们的流）→ 发送侧适应，
    // 阈值/迟滞形态与徽章相同
    const ADAPT_BAD_POLLS = 3;
    const ADAPT_GOOD_POLLS = 2;
    const ADAPT_FLOOR_MIN_BPS = 24000; // 适应绝不低于语音码率地板
    // 接收侧播放加深：NetEQ 会自调但以最小延迟为目标，所以
    // 抖动链路会一直毛刺 —— 持续的故障有理由请求更深的
    // jitter buffer 目标，直到路径再次平息。分两级：
    // 先轻度（中等目标够用时少加延迟），
    // 只有轻度生效而毛刺依旧时才深度加深
    const JITTER_BAD_MS = 40;
    const JITTER_OK_MS = 25;
    const JITTER_BOOST_MILD_MS = 60;
    const JITTER_BOOST_MS = 120;
    // NetEQ 掩蔽率：接收到的音频中 NetEQ 不得不合成（PLC）的
    // 比例 —— 听者真正「听到」的毛刺。网络抖动看起来平稳时，
    // 浅缓冲仍可能在突发/乱序时掩蔽（Wi-Fi 省电），所以它作为
    // ground truth 触发条件加入加深判定
    const CONCEAL_BAD_PCT = 3;
    const CONCEAL_OK_PCT = 1.5;
    // 深度加深按实测抖动缩放，而非固定 120ms ——
    // 90ms 抖动的链路需要两倍以上才能停止掩蔽
    const JITTER_BOOST_MAX_MS = 240;
    const JITTER_HONORED_TOL_MS = 15; // 实际延迟与目标相差在此范围内 = 已生效
    // 质量重启：链路「仍保持连接」却严重持续丢包 ——
    // 适应（码率地板 / 缓冲加深）只能缓解症状，路由本身
    // 劣化时只有重新打洞才有救。两个方向都算数：
    // 入向严重丢包，以及出向黑洞（对端接收端报告说我们发送的
    // 几乎全部死掉 —— ICE consent 依然绿色他们却什么都听不到；
    // 僵尸引擎只抓「恰好为零」的入向）。
    const LOSS_SEVERE_PCT = 20;
    const SEVERE_BAD_POLLS = 6; // 按 5s 轮询节奏约 30s
    const OUT_SEVERE_PCT = 90;
    const OUT_BLACKHOLE_POLLS = 3; // 约 15s
    const QUALITY_RESTART_COOLDOWN_MS = 90000;
    // 僵尸链路：已连接 + 对端广播自己在发送，却连续这么多轮
    // RTP 字节与包数「恰好为零」 → 媒体路径被黑洞化而 ICE
    // consent 仍存活（某些 DPI/策略变更正是如此）。
    // Opus DTX 静默仍会发舒适噪声包（约每 400ms 一个），
    // 被静音/PTT 的对端会把 peer_audio_status 翻成 off ——
    // 活跃发送者绝不会长期停在恰好为零，因此该连击不会对
    // 安静的说话者误触发。冷却时间防止真死路径无限循环
    // 重启；ICE consent 最终失败则交给恢复阶梯。
    const ZOMBIE_POLLS = 6; // 按 5s 轮询节奏约 30s
    const ZOMBIE_COOLDOWN_MS = 60000;
    // 协商中被拒的 restart（对向 offer 在途）→ 此后重试一次
    const POKE_RETRY_MS = 6000;
    // peerId -> { last, loss, jitter, kbps, conceal, jbDelay, outLoss, outJitter, outKbps, outLast, outTarget, bad, good, unstable, outTs, obad, ogood, adapted, probing, floorBps, floorWarned, rbad, osev, restartAt, jbad, jgood, jbBoost, jbLevel, zombie, zombieAt, pokeTimer }
    const lossStreaks = new Map();

    function notePeerLoss(peerId, info) {
        const rec = lossStreaks.get(peerId) || {
            last: null,
            loss: null,
            jitter: null,
            kbps: null,
            conceal: null,
            jbDelay: null,
            outLoss: null,
            outJitter: null,
            outKbps: null,
            outLast: null,
            outTarget: null,
            bad: 0,
            good: 0,
            unstable: false,
            outTs: null,
            obad: 0,
            ogood: 0,
            adapted: false,
            probing: false,
            floorBps: null,
            floorWarned: false,
            rbad: 0,
            osev: 0,
            restartAt: 0,
            jbad: 0,
            jgood: 0,
            jbBoost: false,
            jbLevel: 0,
            zombie: 0,
            zombieAt: 0,
            pokeTimer: null,
        };
        const inbound = info?.inbound;
        if (inbound) {
            const prev = rec.last;
            rec.jitter = inbound.jitter !== null ? Math.round(inbound.jitter * 1000) : null;
            if (prev && inbound.timestamp > prev.timestamp) {
                const dLost = inbound.packetsLost - prev.packetsLost;
                const dRecv = inbound.packetsReceived - prev.packetsReceived;
                const dSec = (inbound.timestamp - prev.timestamp) / 1000;
                // 负增量 = 计数器重置（SSRC 切换）：跳过速率，重定基线
                if (dLost >= 0 && dRecv >= 0) {
                    const total = dLost + dRecv;
                    const loss = total > 0 ? (dLost / total) * 100 : 0;
                    rec.loss = Math.round(loss * 10) / 10;
                    rec.kbps =
                        dSec > 0 ? Math.round(((inbound.bytesReceived - prev.bytesReceived) * 8) / dSec / 1000) : null;
                    // 同一窗口内的 NetEQ 掩蔽率；任一计数器未上报
                    // → null（「无结论」），见 windowConcealPct
                    rec.conceal = windowConcealPct(prev, inbound);
                    // 同一窗口内实际达成的播放缓冲延迟（见 windowJbDelayMs）
                    rec.jbDelay = windowJbDelayMs(prev, inbound);
                    if (loss >= LOSS_BAD_PCT) {
                        rec.bad += 1;
                        rec.good = 0;
                    } else if (loss <= LOSS_OK_PCT) {
                        rec.good += 1;
                        rec.bad = 0;
                    }
                    // 供质量重启用的严重丢包连击（常量见上）
                    if (loss >= LOSS_SEVERE_PCT) rec.rbad += 1;
                    else if (loss <= LOSS_OK_PCT) rec.rbad = 0;
                    noteZombie(peerId, rec, info, inbound.bytesReceived - prev.bytesReceived, dRecv);
                } else {
                    rec.zombie = 0; // SSRC/计数器重置（重建）：连击重定基线
                    rec.conceal = null;
                    rec.jbDelay = null;
                    rec.rbad = 0;
                }
            }
            rec.last = inbound;
        }
        // 出向丢包（对端接收端报告关于我们的流）走 RTCP，
        // 在两次路径轮询之间可能「重复出现」—— 同一份过期报告
        // 绝不能给下面的连击重复计数。每份报告只算一次：时间戳
        // 与上一轮相同即为重读，不是新结论。
        const outTs = info?.outboundTs;
        const freshReport = outTs === null || outTs === undefined || outTs !== rec.outTs;
        if (outTs !== null && outTs !== undefined) rec.outTs = outTs;
        const outbound = freshReport ? info?.outboundLoss : null;
        if (freshReport && info?.outboundLoss !== null && info?.outboundLoss !== undefined) {
            rec.outLoss = info.outboundLoss;
        }
        rec.outJitter = info?.outboundJitter ?? null;
        // 我们编码器的实际输出，与入向计数器一样做差分 ——
        // 「码率地板是否真正落地」的 ground truth（见下）
        const outb = info?.outbound;
        if (outb) {
            const prevOut = rec.outLast;
            if (prevOut && outb.timestamp > prevOut.timestamp) {
                const dBytes = outb.bytesSent - prevOut.bytesSent;
                const dSec = (outb.timestamp - prevOut.timestamp) / 1000;
                rec.outKbps = dBytes >= 0 && dSec > 0 ? Math.round((dBytes * 8) / dSec / 1000) : null;
            }
            rec.outLast = outb;
            rec.outTarget = outb.targetBitrate;
        } else {
            rec.outKbps = null;
            rec.outTarget = null;
        }
        // 出向黑洞连击 —— 每种模式都计数：码率地板拒绝生效的
        // 音乐/共享链路同样值得重新打洞
        if (outbound !== null && outbound !== undefined) {
            if (outbound >= OUT_SEVERE_PCT) rec.osev += 1;
            else if (outbound <= LOSS_OK_PCT) rec.osev = 0;
        }
        const was = rec.unstable;
        if (!rec.unstable && rec.bad >= UNSTABLE_BAD_POLLS) rec.unstable = true;
        else if (rec.unstable && rec.good >= UNSTABLE_GOOD_POLLS) rec.unstable = false;
        lossStreaks.set(peerId, rec);
        if (was !== rec.unstable) updatePeerUnstable(peerId);
        noteOutboundAdaptation(peerId, outbound, rec);
        noteJitterBoost(peerId, rec);
        noteQualityRestart(peerId, info, rec);
    }

    /** 自称存活的链路上的零 RTP 连击（见 ZOMBIE_POLLS）。 */
    function noteZombie(peerId, rec, info, dBytes, dPackets) {
        if (info.state !== 'connected' || members.get(peerId)?.peer_audio_status !== true) {
            rec.zombie = 0;
            return;
        }
        if (dBytes !== 0 || dPackets !== 0) {
            rec.zombie = 0;
            return;
        }
        rec.zombie += 1;
        if (rec.zombie < ZOMBIE_POLLS || Date.now() - rec.zombieAt < ZOMBIE_COOLDOWN_MS) return;
        rec.zombie = 0;
        rec.zombieAt = Date.now();
        // 该信号只存在于这一侧（发送方看自己的链路是健康的）：
        // 检测方无视 session-id 顺序直接行动
        pokeIce(peerId, rec, '[mesh] zombie link: connected but no inbound RTP, restarting ICE', {
            detectorOnly: true,
        });
    }

    /**
     * 质量引擎够得着的最后一阶：链路「仍保持连接」而丢包持续
     * 严重，是路由问题而非负载问题 —— 码率地板与缓冲加深
     * 只是缓解症状。一次 iceRestart 会重跑当初提名该候选对的
     * 检查（劣化的 relay 路径或可重绑定的 NAT 往往有更好的
     * 选择）。触发条件：入向严重丢包持续
     * （检测方直接行动，见 pokeIce）与出向黑洞（低 uuid 仲裁
     * —— 对端自己的连击也会在那边触发）；已在恢复阶梯上的
     * 链路交给它处理。
     */
    function noteQualityRestart(peerId, info, rec) {
        if (info?.state !== 'connected' || peerRecovery.has(peerId)) return;
        const now = Date.now();
        if (now - rec.restartAt < QUALITY_RESTART_COOLDOWN_MS) return;
        const inSevere = rec.rbad >= SEVERE_BAD_POLLS;
        const outBlackhole = rec.osev >= OUT_BLACKHOLE_POLLS;
        if (!inSevere && !outBlackhole) return;
        rec.rbad = 0;
        rec.osev = 0;
        rec.restartAt = now;
        // 入向严重丢包只有检测方行动（见 pokeIce）；出向黑洞是
        // 对称信号 —— 对端自己的 rbad 连击会在那边触发 ——
        // 因此保留低 uuid 仲裁以防双重重启
        pokeIce(
            peerId,
            rec,
            `[mesh] quality restart: path unusable, re-punching (${inSevere ? 'inbound loss' : 'outbound black hole'})`,
            { detectorOnly: inSevere && !outBlackhole }
        );
    }

    /** 带一次延迟重试的 iceRestart：这些引擎按 30-90s 冷却触发，
     *  一次在协商中被拒的 restart 就白白烧掉一个冷却周期。
     *  detectorOnly 标记「非对称信号」—— 僵尸链路（对端看自己
     *  的链路是健康的，永远不会主动重启）与入向严重丢包
     *  （发送方的接收端报告永远不会越过它自己的阈值）——
     *  若接收方恰好是较高 uuid，等低 uuid 就等于永远等下去。
     *  检测方直接行动；对端撞车的 offer 走标准完美协商的
     *  glare 路径解决，
     *  而 iceRestart offer 反正会在两端都重启检查。 */
    function pokeIce(peerId, rec, warnMsg, { detectorOnly = false } = {}) {
        if (!s.selfUuid || (!detectorOnly && s.selfUuid >= peerId)) return;
        console.warn(warnMsg, peerId);
        Promise.resolve(s.mesh?.restartIce(peerId).catch(() => false)).then((sent) => {
            if (sent || rec.pokeTimer) return;
            rec.pokeTimer = setTimeout(() => {
                rec.pokeTimer = null;
                if (s.joined && s.mesh?.entries.has(peerId) && !peerRecovery.has(peerId)) {
                    s.mesh.restartIce(peerId).catch(() => {});
                }
            }, POKE_RETRY_MS);
        });
    }

    /**
     * 持续「出向」丢包的发送侧应对（mesh 链路彼此独立：入向
     * 徽章说的是对端难听清，而对端接收端报告里的 fractionLost
     * 说的是我们的流在丢）。把该链路的编码器上限压到配置码率的
     * 一半，直到报告转好 —— 走 setParameters，
     * 不涉及重协商。
     * 回升走探测阶梯（地板 → 3/4 上限 → 全额上限）：从地板
     * 直接跳回配置上限，恰好就是压垮链路的那种负载，
     * 再触发一次，就永远振荡下去。
     * 仅语音模式（usedtx 上限生效时）：音乐/共享的保真是用户
     * 显式选择，徽章本身就足以告知链路糟糕。
     */
    function noteOutboundAdaptation(peerId, outbound, rec) {
        const fmtp = s.mesh?.getOpusFmtp?.();
        if (fmtp?.usedtx === 1 && fmtp?.maxaveragebitrate && outbound !== null && outbound !== undefined) {
            if (outbound >= LOSS_BAD_PCT) {
                rec.obad += 1;
                rec.ogood = 0;
            } else if (outbound <= LOSS_OK_PCT) {
                rec.ogood += 1;
                rec.obad = 0;
            }
            if (!rec.adapted && rec.obad >= ADAPT_BAD_POLLS) {
                rec.adapted = true;
                rec.probing = false;
                const floor = Math.max(ADAPT_FLOOR_MIN_BPS, Math.floor(fmtp.maxaveragebitrate / 2));
                rec.floorBps = floor;
                s.mesh.setPeerBitrateFloor(peerId, floor);
                console.warn('[mesh] loss adaptation: send bitrate floored', peerId, `${floor / 1000}kbps`);
            } else if (rec.adapted && !rec.probing && rec.ogood >= ADAPT_GOOD_POLLS) {
                // 干净得足够久，可以试探了：上探到上限的 3/4，
                // 一份坏报告就把地板直接压回
                rec.probing = true;
                rec.ogood = 0;
                const probe = Math.floor((fmtp.maxaveragebitrate * 3) / 4);
                rec.floorBps = probe;
                s.mesh.setPeerBitrateFloor(peerId, probe);
                console.log('[mesh] loss adaptation: probing higher bitrate', peerId, `${probe / 1000}kbps`);
            } else if (rec.probing && rec.obad >= 1) {
                rec.probing = false;
                const floor = Math.max(ADAPT_FLOOR_MIN_BPS, Math.floor(fmtp.maxaveragebitrate / 2));
                rec.floorBps = floor;
                s.mesh.setPeerBitrateFloor(peerId, floor);
                console.warn('[mesh] loss adaptation: probe failed, floor re-applied', peerId);
            } else if (rec.probing && rec.ogood >= ADAPT_GOOD_POLLS) {
                rec.adapted = false;
                rec.probing = false;
                rec.floorBps = null;
                s.mesh.setPeerBitrateFloor(peerId, null);
                console.log('[mesh] loss adaptation: bitrate restored', peerId);
            }
        } else if (rec.adapted && fmtp?.usedtx !== 1) {
            // 模式离开语音（音乐/共享）：用户的上限重新接管链路
            rec.adapted = false;
            rec.probing = false;
            rec.floorBps = null;
            s.mesh.setPeerBitrateFloor(peerId, null);
        }
        // 回读：地板/探测生效期间，编码器上报的目标应贴近地板 ——
        // 浏览器 resolve 却不执行的 setParameters 会让整个引擎
        // 白转。每个地板只警告一次；宽松的容差是为了吸收
        // 语音模式下 RED 把线上速率抬到编码器自身目标
        // 约两倍的情况。
        if (rec.floorBps && rec.outTarget !== null && rec.outTarget > rec.floorBps * 2.5 && !rec.floorWarned) {
            rec.floorWarned = true;
            console.warn(
                '[mesh] loss adaptation: encoder target ignores the floor',
                peerId,
                `target=${Math.round(rec.outTarget / 1000)}kbps`
            );
        } else if (!rec.floorBps) {
            rec.floorWarned = false;
        }
    }

    /**
     * 对抖动/丢包/毛刺入向链路的接收侧应对：故障持续期间抬高
     * 该链路的音频播放缓冲目标（mesh.setPeerJitterTarget ——
     * 接收侧，无重协商），平息后恢复
     * 浏览器的自适应默认值。迟滞形态与其他引擎相同；与发送侧
     * 码率地板不同，这没有保真代价，
     * 所以每种模式都运行（音乐毛刺更刺耳）。
     */
    function noteJitterBoost(peerId, rec) {
        const jitterBad = rec.jitter !== null && rec.jitter >= JITTER_BAD_MS;
        const lossBad = rec.loss !== null && rec.loss >= LOSS_BAD_PCT;
        // 掩蔽是上面两个网络层信号都可能漏掉的可闻症状 ——
        // 它同时加入迟滞的两侧
        const glitchBad = rec.conceal !== null && rec.conceal >= CONCEAL_BAD_PCT;
        const calm =
            (rec.jitter === null || rec.jitter <= JITTER_OK_MS) &&
            (rec.loss === null || rec.loss <= LOSS_OK_PCT) &&
            (rec.conceal === null || rec.conceal <= CONCEAL_OK_PCT);
        if (jitterBad || lossBad || glitchBad) {
            rec.jbad += 1;
            rec.jgood = 0;
        } else if (calm) {
            rec.jgood += 1;
            rec.jbad = 0;
        } else {
            return; // 介于其间：维持现状
        }
        if (!rec.jbBoost && rec.jbad >= ADAPT_BAD_POLLS) {
            rec.jbBoost = true;
            rec.jbLevel = 1;
            s.mesh?.setPeerJitterTarget(peerId, JITTER_BOOST_MILD_MS);
            console.warn('[mesh] jitter boost: playout target raised', peerId, `${JITTER_BOOST_MILD_MS}ms`);
        } else if (rec.jbBoost && rec.jbLevel === 1 && rec.jbad >= ADAPT_BAD_POLLS * 2) {
            // 用实际达成延迟闭环：只有轻度目标真正落地（或无法
            // 观测）时才叠加更深目标 —— 无视 60ms 的浏览器
            // 同样会无视 120ms
            const honored = rec.jbDelay === null || rec.jbDelay >= JITTER_BOOST_MILD_MS - JITTER_HONORED_TOL_MS;
            if (!honored) return;
            rec.jbLevel = 2;
            // 深度目标按实测抖动缩放（取整到 10ms），并夹在
            // 合理的音频界限内 —— 90ms 抖动的链路需要超过固定
            // 120ms 才能停止掩蔽，35ms 的则不需要更多
            const deep = Math.min(
                JITTER_BOOST_MAX_MS,
                Math.max(JITTER_BOOST_MS, Math.ceil(((rec.jitter || 0) * 3) / 10) * 10)
            );
            s.mesh?.setPeerJitterTarget(peerId, deep);
            console.warn('[mesh] jitter boost: sustained trouble, deep target', peerId, `${deep}ms`);
        } else if (rec.jbBoost && rec.jgood >= ADAPT_GOOD_POLLS) {
            rec.jbBoost = false;
            rec.jbLevel = 0;
            s.mesh?.setPeerJitterTarget(peerId, null);
            console.log('[mesh] jitter boost: playout target restored', peerId);
        }
    }

    function updatePeerUnstable(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('unstable', !!lossStreaks.get(peerId)?.unstable);
    }
    /** 遗忘离场成员的质量记录（含延迟重试定时器）。 */
    function forget(peerId) {
        const rec = lossStreaks.get(peerId);
        if (rec?.pokeTimer) clearTimeout(rec.pokeTimer);
        lossStreaks.delete(peerId);
    }

    return {
        note: notePeerLoss,
        updateBadge: updatePeerPathBadge,
        pathBadgeNode,
        forget,
        reset: () => lossStreaks.clear(),
        lossStreaks,
    };
}
