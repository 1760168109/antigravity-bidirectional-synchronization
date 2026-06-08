/**
 * Antigravity 双向同步引擎 2.2
 * 由阿岚为柳生专属定制
 *
 * 职责：
 *   1. 同步 .gemini 目录下的对话数据（conversations, brain, annotations, implicit, knowledge）
 *   2. 支持删除同步——通过 manifest 追踪文件变化，一端删除的文件会同步删除另一端
 *   3. 合并 AppData\Roaming 中 state.vscdb 里的对话索引
 *   4. 为缺失 annotation 的对话自动生成 .pbtxt 文件
 *
 * 2.2 改进（边界数据丢失 + 体验阻塞修复）：
 *   - syncAnnotations ghost-cleanup 加 `if(!existsSync(convDir)) continue;` 守卫，
 *     用户临时移走 conversations 目录时不再把同端所有 .pbtxt 当 ghost 清空
 *   - acquireLock PID 复用规避：检测到 PID 在跑时进一步用 tasklist /FI 查 image name，
 *     仅当含 "node"/"sync" 才认作真同步进程；否则视为僵尸（应对前次 sync 被 kill
 *     后 OS 把 PID 回收给 chrome.exe/explorer.exe 等的误判）
 *   - 文件名后缀剥离从 `f.replace(".pb","")` 改为 `path.basename(f, ext)`，
 *     避免 "snap.pb_v2.pb" 之类含子串文件名被错切（2.0/2.1 遗留 string-replace 陷阱）
 *   - 注：2.1 引入的锁 `unparseable` 状态已覆盖 "前任写到一半留下 NaN 内容" 场景
 *
 * 2.1 改进（code-review 严重项修复）：
 *   - brain 级联两端都备份：subA、subB 都存在且可能分歧时分别入 trash 的
 *     brain/<convId>__A/ 与 brain/<convId>__B/；只有一端存在时仍用 brain/<convId>/
 *   - acquireLock 严格 PID 解析（/^\d+$/）+ 四状态分类（live/stale/unparseable/unknown）：
 *     瞬时读失败归为 unknown，不删锁只重试；NaN/损坏归为 unparseable，再读复核后清；
 *     stale 清理仍要求 PID 复核匹配；writeSync 改循环保证全量写入；parseInt 加 radix 10
 *   - safeCopy / backupToTrash 用 try 包住 utimesSync / copyFileSync；mtime 失败仅警告，
 *     备份失败返回 false 让调用方跳过删除（保留文件等下次重试）
 *   - mergeStateDB：跟踪 committedA/committedB 与 rollback 成败；外层 catch 仅在确有
 *     已提交写入或事务回滚失败时才 rollbackFromBackup；ROLLBACK 错误明确打印（不再
 *     `catch(_){}`）；rollbackFromBackup 改为每端独立 try，单端失败不影响另一端
 *   - main() 用 try/finally 包住所有 sync 步骤，确保 saveManifest 在异常路径也落盘；
 *     SIGINT/SIGTERM/uncaughtException handler 也尝试保存 manifest 后再退出
 *
 * 2.0 改进（防误删 + 友好检查）：
 *   - 文件级回收站：删除前自动备份到 ~/.gemini/.sync_trash/<runTs>/<domain>/...
 *     一次同步共享一个 runTs，最近 TRASH_KEEP=5 个批次自动保留，更早的淘汰
 *   - 进程前置检测：未关闭 Antigravity / Antigravity IDE 直接拒绝运行
 *     退出码 EXIT_PROCESS_RUNNING=2（语义化区分一般错误）；--skip-process-check 逃生
 *   - syncWithDeleteTracking / syncConversations / syncAnnotations / syncImplicit
 *     新增 runTs 参数下传给删除点；删除日志末尾标 "→ trash" 提示有备份
 *
 * 1.9 改进（精度与原子性优化）：
 *   - safeCopy 复制后继承源 mtime，消除"每个周期重复回复同一文件"的伪冲突
 *   - saveManifest 改原子写（临时文件 → rename），断电/中途崩溃不再损坏 manifest
 *   - acquireLock 改原子独占创建（openSync wx）+ 删除僵尸锁前 PID 复核 + 循环重试，
 *     消除 existsSync→writeFileSync 之间的 TOCTOU 竞态
 *   - 提取魔法数字为常量：MTIME_TOLERANCE_MS、SOVEREIGNTY_THRESHOLD_MS
 *   - 移除遗留死代码（hashBuffer、crypto 依赖）；旧的 ~/.gemini/.sync_hash 可顺手清掉
 *
 * 1.8 改进（健壮性优化）：
 *   - 启动时 Windows 平台检查（非 Windows 平台直接退出并提示）
 *   - 文件锁防止并发运行，含僵尸锁自动清理（应对 Ctrl+C 后未释放的情况）
 *   - manifest 损坏检测：自动备份损坏文件并提示用户
 *   - 备份文件自动清理：每端 state.vscdb 仅保留最近 BACKUP_KEEP 份
 *   - 修正 syncStats.implicit 累加方式不一致问题
 *   - syncAnnotations 增加注释，明确"删 annotation 不删 .pb 会被自动重生成"的设计意图
 *
 * 1.8 已知限制（不影响柳生场景）：
 *   - state.vscdb 在两端"同时独立活跃"时，从属方的独有 protobuf 索引仍会丢失。
 *     用户场景为"同一时间只用一端"，此限制不会触发，故不投入工程量解决。
 *   - 非 protobuf 键两端都有但值不同时，保持各自不变（避免误伤本地 UI 状态）。
 *
 * 1.7 历史改进：
 *   - state.vscdb 非 protobuf 键双向互补（A 独有→B、B 独有→A）
 *   - state.vscdb 写入包裹 BEGIN IMMEDIATE 事务，校验失败 ROLLBACK
 *
 * 1.6 历史改进：
 *   - state.vscdb 主权方改为基于 mtime 判定
 *   - brain 子目录纳入删除追踪 + 对话删除级联清理 brain/<convId>/
 *
 * 1.5 历史改进：
 *   - 废弃 Buffer.concat protobuf 拼接策略
 *   - 新增 manifest 机制实现删除同步
 *   - 增加 --dry-run 模式、时间戳备份、合并后校验
 *
 * 使用：
 *   node --experimental-sqlite sync.js            # 正常同步
 *   node --experimental-sqlite sync.js --dry-run   # 预览模式（不修改文件）
 *
 * 前提：运行前请关闭 Antigravity 和 Antigravity IDE（仅 Windows 平台）
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("child_process");

// ── 平台检查（1.8）──────────────────────────────────────────
// 必须在路径常量定义之前进行，否则非 Windows 平台上 APPDATA=undefined
// 会让 path.join(APPDATA, ...) 在模块加载阶段就崩溃，看不到友好提示。
if (process.platform !== "win32") {
  console.error("\x1b[31m[错误] 此脚本仅支持 Windows 平台\x1b[0m");
  console.error(`\x1b[31m[错误] 当前平台: ${process.platform}\x1b[0m`);
  console.error("\x1b[33m[提示] Antigravity 的数据路径依赖 %APPDATA%，非 Windows 上无意义\x1b[0m");
  process.exit(1);
}

// ── 命令行参数 ──────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_PROCESS_CHECK = process.argv.includes("--skip-process-check");

// ── 路径定义 ────────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME;
const GEMINI_A = path.join(HOME, ".gemini", "antigravity");
const GEMINI_B = path.join(HOME, ".gemini", "antigravity-ide");
const APPDATA = process.env.APPDATA;
const STATE_A = path.join(APPDATA, "Antigravity", "User", "globalStorage", "state.vscdb");
const STATE_B = path.join(APPDATA, "Antigravity IDE", "User", "globalStorage", "state.vscdb");

const MANIFEST_FILE = path.join(HOME, ".gemini", ".sync_manifest.json");
const LOCK_FILE = path.join(HOME, ".gemini", ".sync.lock");
const TRASH_DIR = path.join(HOME, ".gemini", ".sync_trash");
const BACKUP_KEEP = 5;  // 每端 state.vscdb 保留的最近备份数（1.8）
const TRASH_KEEP = 5;   // 文件级回收站保留的最近批次数（2.0）
const MTIME_TOLERANCE_MS = 2000;       // 两端同名文件 mtime 差小于此值视为一致（1.9 提取）
const SOVEREIGNTY_THRESHOLD_MS = 5000; // state.vscdb 主权方判定阈值（1.9 提取）
const EXIT_PROCESS_RUNNING = 2;        // 进程未关闭的语义化退出码（2.0）

// ── 日志 ────────────────────────────────────────────────────
const COLORS = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[90m",
  red: "\x1b[31m", white: "\x1b[37m",
};

let syncStats = {
  copied: 0, deleted: 0, annotations: 0,
  implicit: 0, knowledge: 0, indexMerge: 0,
};

function log(msg, color = "white") {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

// ── 工具函数 ────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    if (DRY_RUN) return;
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeCopy(src, dst) {
  if (DRY_RUN) return;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  // 1.9：继承源 mtime，否则下次同步会因目标"较新"而无谓再复制一次
  // 2.1：utimes 在 AV 短暂锁定 dst 时可能抛 EBUSY/EPERM——仅警告，不阻塞同步
  try {
    const srcStat = fs.statSync(src);
    fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
  } catch (e) {
    log(`    [警告] mtime 保留失败 ${path.basename(dst)}: ${e.code || e.message}`, "yellow");
  }
}

function safeDelete(filePath) {
  if (DRY_RUN) return;
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function safeDeleteDir(dirPath) {
  if (DRY_RUN) return;
  if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
}

/** 递归获取目录下所有文件的相对路径 */
function walkFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// ── Manifest 管理 ───────────────────────────────────────────
// manifest 记录上次同步后两端应共有的文件列表
// 用于区分"新增文件"和"被删除的文件"

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
  } catch (e) {
    // 1.8：损坏检测——备份损坏文件并显式告知用户
    log(`[警告] manifest 文件损坏: ${e.message}`, "red");
    if (!DRY_RUN) {
      const corruptedBackup = MANIFEST_FILE + `.corrupted_${timestamp()}`;
      try {
        fs.copyFileSync(MANIFEST_FILE, corruptedBackup);
        log(`[警告] 已备份损坏文件到: ${path.basename(corruptedBackup)}`, "yellow");
      } catch (_) {}
    }
    log(`[警告] 本次将视所有文件为新增（不会触发删除同步）`, "yellow");
    return {};
  }
}

function saveManifest(data) {
  if (DRY_RUN) return;
  // 1.9：原子写——先落临时文件再 rename，断电/崩溃不会留下半写损坏的 manifest
  const tmp = MANIFEST_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, MANIFEST_FILE);
}

// ── 并发锁（2.1）─────────────────────────────────────────────
// 防止用户不小心双击运行多次。锁文件存 PID。
// 2.1：严格 /^\d+$/ 解析 + 四状态分类（live/stale/unparseable/unknown）：
//   - live：PID 仍在跑 → 直接退出
//   - stale：PID 已不存在 → 复核内容未变后清掉
//   - unparseable：内容空/非数字（崩溃留下的半截写入） → 复核仍非数字后清掉
//   - unknown：读取本身瞬时失败 → 不动锁文件，下轮重试
// 写入 PID 用循环保证全量（fs.writeSync 可能短写）；parseInt 显式 radix=10。
// 2.2：检测到 live 后用 tasklist 复核进程名，OS 回收的 PID 被识别为 stale。

// 通过 tasklist /FI 查 PID 对应的进程名，含 "node"/"sync" 才算真同步进程。
// tasklist 自身失败时保守返回 true（避免误清真锁）。
function isOurProcess(pid) {
  try {
    const out = execFileSync("tasklist", [
      "/FI", `PID eq ${pid}`,
      "/NH", "/FO", "CSV"
    ], { encoding: "utf-8", windowsHide: true });
    const m = out.match(/^"([^"]+)","\d+"/m);
    if (!m) return false;  // 找不到该 PID（实际上该路径不应触达，因为 live 是 process.kill 已确认存活）
    const name = m[1].toLowerCase();
    return name.includes("node") || name.includes("sync");
  } catch (_) {
    return true;  // tasklist 失败 → 保守视为我们的进程
  }
}

function acquireLock() {
  const MAX_ATTEMPTS = 3;
  const PID_RE = /^\d+$/;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (fs.existsSync(LOCK_FILE)) {
      let lockState = "unknown";
      let existingPid = null;
      try {
        const content = fs.readFileSync(LOCK_FILE, "utf-8").trim();
        if (PID_RE.test(content)) {
          existingPid = parseInt(content, 10);
          let processAlive = false;
          try {
            process.kill(existingPid, 0);  // 信号 0：仅探测
            processAlive = true;
          } catch (e) {
            // EPERM = 进程存在但拒访问；其他 = 不存在
            processAlive = (e.code === "EPERM");
          }
          if (processAlive) {
            // 2.2：用 tasklist 复核进程名，规避 OS PID 回收
            if (isOurProcess(existingPid)) {
              lockState = "live";
            } else {
              log(`[警告] PID ${existingPid} 存在但非 node/sync 进程（疑似 OS 回收），视为僵尸`, "yellow");
              lockState = "stale";
            }
          } else {
            lockState = "stale";
          }
        } else {
          // 空 / 非数字 / 含"0x"等乱码 → 损坏锁
          lockState = "unparseable";
        }
      } catch (_) {
        // 文件存在但读不动（AV 瞬时锁、磁盘瞬时异常）→ 不删，重试
        lockState = "unknown";
      }

      if (lockState === "live") {
        log(`[错误] 另一个同步进程正在运行 (PID=${existingPid})`, "red");
        log(`[提示] 如果确认无误，可手动删除: ${LOCK_FILE}`, "yellow");
        process.exit(1);
      }

      if (lockState === "stale" && !DRY_RUN) {
        log(`[警告] 检测到僵尸锁（PID=${existingPid} 已不存在），自动清理`, "yellow");
        // 复核：再读一次，确认仍是同一个 PID（防止删掉别人新写的合法锁）
        try {
          const current = fs.readFileSync(LOCK_FILE, "utf-8").trim();
          if (PID_RE.test(current) && parseInt(current, 10) === existingPid) {
            fs.unlinkSync(LOCK_FILE);
          }
          // PID 变了 → 让下一轮 wx 重新判定
        } catch (_) { /* 文件已不在或不可读，下一轮重试 */ }
      } else if (lockState === "unparseable" && !DRY_RUN) {
        log("[警告] 锁文件内容损坏，复核后清理", "yellow");
        // 复核：仅当内容仍非数字时清理（避免误删别人刚写入的合法 PID）
        try {
          const current = fs.readFileSync(LOCK_FILE, "utf-8").trim();
          if (!PID_RE.test(current)) {
            fs.unlinkSync(LOCK_FILE);
          }
        } catch (_) { /* 文件已不在 */ }
      } else if (lockState === "unknown") {
        log(`[警告] 锁状态无法判定（第 ${attempt}/${MAX_ATTEMPTS} 次），稍后重试`, "yellow");
        continue;  // 不删除，重新观察
      }
    }

    if (DRY_RUN) return;  // DRY_RUN 不创建锁

    // 原子独占创建 + 循环写入保证全量
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      try {
        const pidStr = String(process.pid);
        let written = 0;
        while (written < pidStr.length) {
          written += fs.writeSync(fd, pidStr, written);
        }
      } finally {
        fs.closeSync(fd);
      }
      return;  // 成功获取
    } catch (e) {
      if (e.code !== "EEXIST") {
        log(`[错误] 无法创建锁文件: ${e.message}`, "red");
        process.exit(1);
      }
      // EEXIST：文件被别人抢先创建，下一轮重新判定
    }
  }

  log(`[错误] 多次尝试后仍无法获取锁（已尝试 ${MAX_ATTEMPTS} 次）`, "red");
  process.exit(1);
}

function releaseLock() {
  if (DRY_RUN) return;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      // 2.1：严格匹配，且 radix=10，避免 "0x10" / "1234abc" 之类被误判
      if (/^\d+$/.test(content) && parseInt(content, 10) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
      // 否则：内容不是我们写的（被覆盖/部分写/外部改）→ 不动，下次按 unparseable 清
    }
  } catch (_) {}
}

// ── 备份清理（1.8）───────────────────────────────────────────
// 每端 state.vscdb 保留最近 BACKUP_KEEP 份备份，删除更早的。
// 每次跑同步会产生 1 份新备份；不清理的话长期会占用大量磁盘。

function pruneBackups(dbPath, keepCount = BACKUP_KEEP) {
  const dir = path.dirname(dbPath);
  const baseName = path.basename(dbPath);
  const prefix = `${baseName}.backup_`;

  if (!fs.existsSync(dir)) return 0;

  let backups;
  try {
    backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .map(f => ({
        path: path.join(dir, f),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);  // 最新优先
  } catch (_) {
    return 0;
  }

  let deleted = 0;
  for (let i = keepCount; i < backups.length; i++) {
    if (DRY_RUN) {
      deleted++;
    } else {
      try {
        fs.unlinkSync(backups[i].path);
        deleted++;
      } catch (_) {}
    }
  }
  return deleted;
}

// ── 文件级回收站（2.0）─────────────────────────────────────
// 删除前把文件备份到 ~/.gemini/.sync_trash/<runTs>/<subdomain>/<relPath>，
// 每次同步共享一个 runTs，最近 TRASH_KEEP 个批次自动保留，更早的整批淘汰。
// 设计取舍：
//   - 仅"单边删除→需同步删除对侧"时备份，因为此时对侧还有内容可备份
//   - "两端都被手动删除"无备份（内容已不可得）
//   - knowledge 走 syncDirectoryMerge 不触发删除，与回收站无交集

// 2.1：返回 boolean 表示备份是否成功；调用方据此决定要不要 safeDelete
function backupToTrash(srcPath, relPath, runTs, subdomain) {
  if (DRY_RUN) return true;
  if (!fs.existsSync(srcPath)) return true;  // 源已消失，无需备份视为成功
  const dst = path.join(TRASH_DIR, runTs, subdomain, relPath);
  try {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(srcPath, dst);
  } catch (e) {
    log(`    [警告] 备份到 trash 失败，跳过删除: ${relPath} (${e.code || e.message})`, "red");
    return false;
  }
  // 继承源 mtime（与 1.9 safeCopy 策略一致），便于辨识原始时间；失败不致命
  try {
    const srcStat = fs.statSync(srcPath);
    fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
  } catch (_) { /* trash 文件的 mtime 不是关键 */ }
  return true;
}

// 备份目录下所有文件到 trash；用于 brain 级联清理前的整目录抢救
// 2.1：返回 boolean 表示所有文件备份均成功（任何一个失败即返回 false）
function backupDirToTrash(srcDir, relDirPrefix, runTs, subdomain) {
  if (DRY_RUN) return true;
  if (!fs.existsSync(srcDir)) return true;
  let allOk = true;
  for (const f of walkFiles(srcDir)) {
    const rel = path.join(relDirPrefix, path.relative(srcDir, f));
    if (!backupToTrash(f, rel, runTs, subdomain)) {
      allOk = false;
    }
  }
  return allOk;
}

function pruneTrash(keepCount = TRASH_KEEP) {
  if (!fs.existsSync(TRASH_DIR)) return 0;
  let names;
  try {
    names = fs.readdirSync(TRASH_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();  // 时间戳字典序倒序=时间倒序
  } catch (_) { return 0; }

  let pruned = 0;
  for (const name of names.slice(keepCount)) {
    if (!DRY_RUN) {
      try { fs.rmSync(path.join(TRASH_DIR, name), { recursive: true, force: true }); }
      catch (_) { continue; }
    }
    pruned++;
  }
  return pruned;
}

// ── 进程前置检测（2.0）─────────────────────────────────────
// 检查 Antigravity.exe / Antigravity IDE.exe 主进程或同名子进程是否在跑。
// 子进程命名规律：1.23.2 端所有进程名都以 "Antigravity" 开头；IDE 端以 "Antigravity IDE" 开头。
// 实现：单次 tasklist 拉全表，按 IMAGENAME 前缀分类（先判 IDE 再判 1.23.2，避免 IDE 被
//      "Antigravity" 前缀误吞）。tasklist 自身故障时 fail open，仅警告不阻塞。

function checkAppsRunning() {
  let csv;
  try {
    csv = execFileSync("tasklist", ["/NH", "/FO", "CSV"], {
      encoding: "utf-8",
      windowsHide: true,
    });
  } catch (e) {
    log(`[警告] tasklist 调用失败：${e.message}`, "yellow");
    log("[警告] 无法验证 Antigravity 进程状态，跳过检查继续执行", "yellow");
    return [];  // fail open
  }

  const main = { name: "Antigravity", pids: [] };
  const ide  = { name: "Antigravity IDE", pids: [] };

  for (const line of csv.split(/\r?\n/)) {
    // 行格式: "ImageName","PID","SessionName","Session#","MemUsage"
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    const [, imageName, pid] = m;
    if (imageName.startsWith("Antigravity IDE")) {
      ide.pids.push(pid);
    } else if (imageName.startsWith("Antigravity")) {
      main.pids.push(pid);
    }
  }

  const result = [];
  if (main.pids.length > 0) result.push(main);
  if (ide.pids.length  > 0) result.push(ide);
  return result;
}

// ── 核心同步：带删除追踪的双向合并 ─────────────────────────
/**
 * 文件级双向合并 + 删除同步。
 *
 * 逻辑：
 * - manifest 中存在 + A 端缺失 → A 端删除了 → 删除 B 端 + 移出 manifest
 * - manifest 中存在 + B 端缺失 → B 端删除了 → 删除 A 端 + 移出 manifest
 * - manifest 中不存在 + A 端存在 → 新文件 → 复制到 B 端 + 加入 manifest
 * - manifest 中不存在 + B 端存在 → 新文件 → 复制到 A 端 + 加入 manifest
 * - 两端都有 → 取较新的覆盖较旧的
 *
 * @returns {{ copied: number, deleted: number, deletedKeys: string[] }}
 *          deletedKeys 包含本次被删除的相对路径（包括两端均已删除的）
 */
function syncWithDeleteTracking(dirA, dirB, manifestKey, manifest, runTs) {
  ensureDir(dirA);
  ensureDir(dirB);

  const prevFiles = new Set(manifest[manifestKey] || []);
  const filesA = new Map();
  const filesB = new Map();

  for (const f of walkFiles(dirA)) {
    filesA.set(path.relative(dirA, f), fs.statSync(f));
  }
  for (const f of walkFiles(dirB)) {
    filesB.set(path.relative(dirB, f), fs.statSync(f));
  }

  const allKeys = new Set([...filesA.keys(), ...filesB.keys(), ...prevFiles]);
  const newManifest = [];
  const deletedKeys = [];
  let copied = 0;
  let deleted = 0;

  for (const rel of allKeys) {
    const inA = filesA.has(rel);
    const inB = filesB.has(rel);
    const inPrev = prevFiles.has(rel);
    const fullA = path.join(dirA, rel);
    const fullB = path.join(dirB, rel);

    if (inA && inB) {
      // 两端都有：取较新覆盖较旧
      const tA = filesA.get(rel).mtimeMs;
      const tB = filesB.get(rel).mtimeMs;
      if (Math.abs(tA - tB) > MTIME_TOLERANCE_MS) {
        if (tA > tB) {
          safeCopy(fullA, fullB);
          log(`    [↑] ${rel} (A较新→B)`, "yellow");
        } else {
          safeCopy(fullB, fullA);
          log(`    [↑] ${rel} (B较新→A)`, "yellow");
        }
        copied++;
      }
      newManifest.push(rel);
    } else if (inA && !inB) {
      if (inPrev) {
        // B 端删除了 → 备份 A 端内容 → 同步删除 A 端（2.0：删前入 trash）
        // 2.1：备份失败则保留文件，下次再试，避免无备份的删除
        if (backupToTrash(fullA, rel, runTs, manifestKey)) {
          safeDelete(fullA);
          log(`    [✕] ${rel} (B端已删→删除A端) → trash`, "gray");
          deleted++;
          deletedKeys.push(rel);
        } else {
          newManifest.push(rel);  // 保留在 manifest，下轮重试
        }
      } else {
        // A 端新增 → 复制到 B 端
        safeCopy(fullA, fullB);
        log(`    [+] ${rel} (A→B)`, "green");
        copied++;
        newManifest.push(rel);
      }
    } else if (!inA && inB) {
      if (inPrev) {
        // A 端删除了 → 备份 B 端内容 → 同步删除 B 端（2.0：删前入 trash）
        // 2.1：备份失败则保留文件，下次再试
        if (backupToTrash(fullB, rel, runTs, manifestKey)) {
          safeDelete(fullB);
          log(`    [✕] ${rel} (A端已删→删除B端) → trash`, "gray");
          deleted++;
          deletedKeys.push(rel);
        } else {
          newManifest.push(rel);  // 保留在 manifest，下轮重试
        }
      } else {
        // B 端新增 → 复制到 A 端
        safeCopy(fullB, fullA);
        log(`    [+] ${rel} (B→A)`, "green");
        copied++;
        newManifest.push(rel);
      }
    } else if (!inA && !inB && inPrev) {
      // 两端都被手动删除 → 自然移出 manifest，并记入 deletedKeys（用于级联）
      deletedKeys.push(rel);
    }
  }

  manifest[manifestKey] = newManifest;
  return { copied, deleted, deletedKeys };
}

// ── 简单双向合并（无删除追踪，用于 knowledge 等不需要删除同步的目录） ──
function syncDirectoryMerge(dirA, dirB) {
  ensureDir(dirA);
  ensureDir(dirB);

  const filesA = new Map();
  const filesB = new Map();

  for (const f of walkFiles(dirA)) filesA.set(path.relative(dirA, f), fs.statSync(f));
  for (const f of walkFiles(dirB)) filesB.set(path.relative(dirB, f), fs.statSync(f));

  const allKeys = new Set([...filesA.keys(), ...filesB.keys()]);
  let count = 0;

  for (const rel of allKeys) {
    const inA = filesA.has(rel);
    const inB = filesB.has(rel);
    const fullA = path.join(dirA, rel);
    const fullB = path.join(dirB, rel);

    if (inA && !inB) {
      safeCopy(fullA, fullB);
      count++;
    } else if (!inA && inB) {
      safeCopy(fullB, fullA);
      count++;
    } else {
      const tA = filesA.get(rel).mtimeMs;
      const tB = filesB.get(rel).mtimeMs;
      if (Math.abs(tA - tB) > MTIME_TOLERANCE_MS) {
        if (tA > tB) safeCopy(fullA, fullB);
        else safeCopy(fullB, fullA);
        count++;
      }
    }
  }
  return count;
}

// ── 第一步：同步对话文件与 brain ─────────────────────────────

function syncConversations(manifest, runTs) {
  log("\n  ① 同步对话文件 (.pb) + brain...", "yellow");

  const convA = path.join(GEMINI_A, "conversations");
  const convB = path.join(GEMINI_B, "conversations");
  ensureDir(convA);
  ensureDir(convB);

  // conversations 用带删除追踪的同步
  const result = syncWithDeleteTracking(convA, convB, "conversations", manifest, runTs);
  syncStats.copied += result.copied;
  syncStats.deleted += result.deleted;

  // brain 子目录同步（1.6：纳入删除追踪）
  const brainA = path.join(GEMINI_A, "brain");
  const brainB = path.join(GEMINI_B, "brain");
  ensureDir(brainA);
  ensureDir(brainB);

  // 级联清理：对话被删除时，主动清掉两端对应的 brain/<convId>/ 目录
  // 这一步必须在 brain 走 syncWithDeleteTracking 之前完成，
  // 否则 brain manifest 里的残留条目会被错误判定为"被某一端删除"而引发混乱。
  // 2.1：两端都存在时分别备份（subA → brain/<id>__A/, subB → brain/<id>__B/），
  //      避免内容分歧场景下另一侧独有文件被无声丢失。
  //      备份失败则跳过本次级联清理，等下次再试。
  let cascadeCleanedDirs = 0;
  for (const rel of result.deletedKeys) {
    if (!rel.endsWith(".pb")) continue;
    const convId = path.basename(rel, ".pb");
    const subA = path.join(brainA, convId);
    const subB = path.join(brainB, convId);
    const hasA = fs.existsSync(subA);
    const hasB = fs.existsSync(subB);
    if (!hasA && !hasB) continue;

    let backupOk = true;
    if (hasA && hasB) {
      // 两端都有：可能内容分歧，分别归档
      if (!backupDirToTrash(subA, convId + "__A", runTs, "brain")) backupOk = false;
      if (!backupDirToTrash(subB, convId + "__B", runTs, "brain")) backupOk = false;
    } else if (hasA) {
      if (!backupDirToTrash(subA, convId, runTs, "brain")) backupOk = false;
    } else {
      if (!backupDirToTrash(subB, convId, runTs, "brain")) backupOk = false;
    }

    if (!backupOk) {
      log(`    [!] 跳过级联清理 brain/${convId}/（备份失败，下次重试）`, "red");
      continue;
    }

    if (hasA) safeDeleteDir(subA);
    if (hasB) safeDeleteDir(subB);
    log(`    [✕] 级联清理 brain/${convId}/ → trash${hasA && hasB ? "（双侧）" : ""}`, "gray");
    cascadeCleanedDirs++;
    syncStats.deleted++;
  }

  // brain 整体走带删除追踪的同步（处理用户在 brain 内手动增删文件的场景）
  const brainResult = syncWithDeleteTracking(brainA, brainB, "brain", manifest, runTs);
  syncStats.copied += brainResult.copied;
  syncStats.deleted += brainResult.deleted;

  if (brainResult.copied > 0 || brainResult.deleted > 0) {
    log(`    └─ brain: 复制 ${brainResult.copied} 个，删除 ${brainResult.deleted} 个`, "gray");
  }

  if (
    result.copied === 0 &&
    result.deleted === 0 &&
    brainResult.copied === 0 &&
    brainResult.deleted === 0 &&
    cascadeCleanedDirs === 0
  ) {
    log("    └─ 对话文件已一致", "gray");
  }
}

// ── 第二步：同步 annotations ─────────────────────────────────

function syncAnnotations(manifest, runTs) {
  log("\n  ② 同步 annotations...", "yellow");

  const annA = path.join(GEMINI_A, "annotations");
  const annB = path.join(GEMINI_B, "annotations");
  ensureDir(annA);
  ensureDir(annB);

  const result = syncWithDeleteTracking(annA, annB, "annotations", manifest, runTs);
  syncStats.copied += result.copied;
  syncStats.deleted += result.deleted;

  // 为缺失 annotation 的对话生成 .pbtxt
  // 注：annotation 是元数据，由本脚本自动维护——
  //     如果用户单独删除了某个 .pbtxt 但保留了对应的 .pb 文件，
  //     下次同步会在此处重新生成。要让 annotation 真正消失，请删除对应的 .pb 文件。
  for (const [label, geminiDir] of [["1.23.2", GEMINI_A], ["IDE", GEMINI_B]]) {
    const convDir = path.join(geminiDir, "conversations");
    const annDir = path.join(geminiDir, "annotations");
    ensureDir(annDir);
    if (!fs.existsSync(convDir)) continue;

    for (const f of fs.readdirSync(convDir).filter(n => n.endsWith(".pb"))) {
      const convId = path.basename(f, ".pb");  // 2.2：path.basename 安全剥离尾部 .pb
      const annPath = path.join(annDir, `${convId}.pbtxt`);

      if (!fs.existsSync(annPath)) {
        const stat = fs.statSync(path.join(convDir, f));
        const epochSec = Math.floor(stat.mtimeMs / 1000);
        const content = `last_user_view_time:{seconds:${epochSec}  nanos:0}`;
        if (!DRY_RUN) fs.writeFileSync(annPath, content, "utf-8");
        log(`    [✦] [${label}] 生成 annotation: ${convId}`, "magenta");
        syncStats.annotations++;
      }
    }
  }

  // 生成后确保两边一致
  for (const [src, dst] of [[annA, annB], [annB, annA]]) {
    if (!fs.existsSync(src)) continue;
    for (const f of fs.readdirSync(src).filter(n => n.endsWith(".pbtxt"))) {
      const target = path.join(dst, f);
      if (!fs.existsSync(target)) {
        safeCopy(path.join(src, f), target);
      }
    }
  }

  // 清理幽灵 annotation
  let ghostsCleaned = 0;
  for (const [label, geminiDir] of [["1.23.2", GEMINI_A], ["IDE", GEMINI_B]]) {
    const convDir = path.join(geminiDir, "conversations");
    const annDir = path.join(geminiDir, "annotations");
    if (!fs.existsSync(annDir)) continue;
    // 2.2：conversations 缺失时不做 ghost-cleanup——否则会把同端所有 .pbtxt 当 ghost 全删
    if (!fs.existsSync(convDir)) {
      log(`    [!] [${label}] conversations 目录缺失，跳过 ghost annotation 清理`, "yellow");
      continue;
    }

    for (const f of fs.readdirSync(annDir).filter(n => n.endsWith(".pbtxt"))) {
      const convId = path.basename(f, ".pbtxt");  // 2.2：安全剥离尾部 .pbtxt
      const pbPath = path.join(convDir, `${convId}.pb`);
      if (!fs.existsSync(pbPath)) {
        safeDelete(path.join(annDir, f));
        log(`    [✕] [${label}] 清理幽灵 annotation: ${convId}`, "gray");
        ghostsCleaned++;
      }
    }
  }
  if (ghostsCleaned > 0) {
    log(`    └─ 清理了 ${ghostsCleaned} 个无效 annotation`, "gray");
  }
}

// ── 第三步：同步 implicit / knowledge ────────────────────────

function syncImplicit(manifest, runTs) {
  log("\n  ③ 同步 implicit 上下文...", "yellow");
  const dirA = path.join(GEMINI_A, "implicit");
  const dirB = path.join(GEMINI_B, "implicit");

  const result = syncWithDeleteTracking(dirA, dirB, "implicit", manifest, runTs);
  syncStats.implicit += result.copied + result.deleted;
  if (syncStats.implicit === 0) log("    └─ 已一致", "gray");
}

function syncKnowledge() {
  log("\n  ④ 同步 knowledge 知识库...", "yellow");
  const n = syncDirectoryMerge(
    path.join(GEMINI_A, "knowledge"),
    path.join(GEMINI_B, "knowledge")
  );
  syncStats.knowledge = n;
  log(n > 0 ? `    └─ 合并了 ${n} 个文件` : "    └─ 已一致", "gray");
}

// ── 第四步：安全合并 state.vscdb 索引 ────────────────────────
//
// 1.7 策略：
//   - 主权方判定：比较两端 state.vscdb 的 mtime，差距 > 5s 时取较新一端为主权方；
//                 差距较近时退化为"1.23.2 端优先"（保持向后兼容，避免无谓扰动）
//   - protobuf 键：从主权方覆盖从属方；任一端为 0 字节时用另一端恢复
//   - 非 protobuf 键：A 独有→B、B 独有→A（双向互补）；两端都有但值不同时保持各自不变
//   - 事务保护：两端均以 BEGIN IMMEDIATE 包裹读写，校验失败时 ROLLBACK 保证原子性
//   - 安全措施：两端时间戳备份（事务回滚失败时的最终兜底）+ 写入后校验
//
// 已知风险：当两端"同时独立活跃"时，从属方独有的 protobuf 对话索引仍会丢失。
//            彻底解决需 protobuf schema 解析与按对话 ID 合并。

function mergeStateDB() {
  log("\n  ⑤ 合并 state.vscdb 对话索引...", "yellow");

  if (!fs.existsSync(STATE_A)) {
    log("    [!] 1.23.2 端 state.vscdb 不存在，跳过", "red");
    return;
  }
  if (!fs.existsSync(STATE_B)) {
    log("    [!] IDE 端 state.vscdb 不存在，跳过", "red");
    return;
  }

  // ── 主权方判定（基于 mtime）──
  const mtA = fs.statSync(STATE_A).mtimeMs;
  const mtB = fs.statSync(STATE_B).mtimeMs;
  const diffMs = mtA - mtB;

  // primary: "A" 表示 1.23.2 是主权方；"B" 表示 IDE 是主权方
  let primary;
  if (Math.abs(diffMs) <= SOVEREIGNTY_THRESHOLD_MS) {
    primary = "A";
    log(`    └─ 两端 mtime 接近(差 ${Math.round(Math.abs(diffMs))}ms)，默认以 1.23.2 端为主`, "gray");
  } else if (diffMs > 0) {
    primary = "A";
    log(`    └─ 1.23.2 端较新(差 ${Math.round(diffMs / 1000)}秒)，以 1.23.2 为主权方`, "yellow");
  } else {
    primary = "B";
    log(`    └─ IDE 端较新(差 ${Math.round(-diffMs / 1000)}秒)，以 IDE 为主权方`, "yellow");
  }
  const primaryLabel = primary === "A" ? "1.23.2" : "IDE";
  const secondaryLabel = primary === "A" ? "IDE" : "1.23.2";

  // ── 备份两端（事务回滚失败时的最终兜底）──
  const ts = timestamp();
  const backupA = STATE_A + `.backup_${ts}`;
  const backupB = STATE_B + `.backup_${ts}`;

  if (!DRY_RUN) {
    fs.copyFileSync(STATE_A, backupA);
    fs.copyFileSync(STATE_B, backupB);
    log(`    └─ 备份 1.23.2 → ${path.basename(backupA)}`, "gray");
    log(`    └─ 备份 IDE  → ${path.basename(backupB)}`, "gray");
  }

  // 1.8：清理过旧的备份（每端保留最近 BACKUP_KEEP 份）
  const prunedA = pruneBackups(STATE_A);
  const prunedB = pruneBackups(STATE_B);
  if (prunedA + prunedB > 0) {
    log(`    └─ 清理了 ${prunedA + prunedB} 个旧备份（每端保留最近 ${BACKUP_KEEP} 份）`, "gray");
  }

  const PROTOBUF_KEYS = [
    "antigravityUnifiedStateSync.trajectorySummaries",
    "antigravityUnifiedStateSync.sidebarWorkspaces",
  ];

  // 文件级回滚（仅在事务回滚也失败或一侧已提交时作为兜底）
  // 2.1：每端独立 try，单端失败不影响另一端；失败明确打印
  const rollbackFromBackup = () => {
    if (DRY_RUN) return;
    let restored = 0;
    let failed = 0;
    if (fs.existsSync(backupA)) {
      try {
        fs.copyFileSync(backupA, STATE_A);
        restored++;
      } catch (e) {
        log(`    [!!] STATE_A 文件回滚失败: ${e.code || e.message}`, "red");
        failed++;
      }
    }
    if (fs.existsSync(backupB)) {
      try {
        fs.copyFileSync(backupB, STATE_B);
        restored++;
      } catch (e) {
        log(`    [!!] STATE_B 文件回滚失败: ${e.code || e.message}`, "red");
        failed++;
      }
    }
    if (restored > 0) {
      log(`    [!!] 已从备份回滚 ${restored} 个 state.vscdb${failed > 0 ? `，另 ${failed} 个失败` : ""}`, "red");
    }
  };

  let dbA = null;
  let dbB = null;
  let txStartedA = false;
  let txStartedB = false;
  let committedA = false;  // 2.1：跟踪每端是否已 COMMIT，决定是否需要文件级回滚
  let committedB = false;

  try {
    // dry-run 下两端只读打开；实际同步时两端均需可写
    const openOpts = DRY_RUN ? { readOnly: true } : {};
    dbA = new DatabaseSync(STATE_A, openOpts);
    dbB = new DatabaseSync(STATE_B, openOpts);

    // ── 启动事务（1.7：BEGIN IMMEDIATE 立即获取写锁）──
    if (!DRY_RUN) {
      dbA.exec("BEGIN IMMEDIATE");
      txStartedA = true;
      dbB.exec("BEGIN IMMEDIATE");
      txStartedB = true;
    }

    // ── 在事务内读取（保证读写一致性）──
    const rowsA = new Map();
    const rowsB = new Map();

    for (const row of dbA.prepare("SELECT key, value FROM ItemTable").all()) {
      rowsA.set(row.key, row.value);
    }
    for (const row of dbB.prepare("SELECT key, value FROM ItemTable").all()) {
      rowsB.set(row.key, row.value);
    }

    // 根据主权方决定写入方向
    const rowsPrimary = primary === "A" ? rowsA : rowsB;
    const rowsSecondary = primary === "A" ? rowsB : rowsA;
    const dbPrimary = primary === "A" ? dbA : dbB;
    const dbSecondary = primary === "A" ? dbB : dbA;

    let keysUpdated = 0;

    // ── protobuf 键：以主权方为准 ──
    for (const key of PROTOBUF_KEYS) {
      const valP = rowsPrimary.get(key);
      const valS = rowsSecondary.get(key);
      const lenP = valP ? (Buffer.isBuffer(valP) ? valP.length : Buffer.from(valP).length) : 0;
      const lenS = valS ? (Buffer.isBuffer(valS) ? valS.length : Buffer.from(valS).length) : 0;

      if (lenP === 0 && lenS === 0) {
        log(`    [!] ${key}: 两端均为空`, "red");
        continue;
      }

      if (lenP === 0 && lenS > 0) {
        // 主权方为空，从属方有值 → 反向恢复主权方
        if (!DRY_RUN) {
          dbPrimary.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valS);
        }
        log(`    [★] ${key}: ${primaryLabel}端为空(0B)，用${secondaryLabel}端恢复(${lenS}B)`, "magenta");
        keysUpdated++;
        continue;
      }

      if (lenS === 0 && lenP > 0) {
        // 从属方为空 → 用主权方填补
        if (!DRY_RUN) {
          dbSecondary.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valP);
        }
        log(`    [★] ${key}: ${secondaryLabel}端为空(0B)，用${primaryLabel}端填补(${lenP}B)`, "magenta");
        keysUpdated++;
        continue;
      }

      // 两端都有值
      const bufP = Buffer.isBuffer(valP) ? valP : Buffer.from(valP);
      const bufS = Buffer.isBuffer(valS) ? valS : Buffer.from(valS);

      if (Buffer.compare(bufP, bufS) === 0) {
        log(`    [=] ${key}: 两端一致(${lenP}B)`, "gray");
      } else {
        if (!DRY_RUN) {
          dbSecondary.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valP);
        }
        log(`    [→] ${key}: 以${primaryLabel}端(${lenP}B)覆盖${secondaryLabel}端(${lenS}B)`, "yellow");
        keysUpdated++;
      }
    }

    // ── 非 protobuf 键：双向互补（1.7 修复 #3）──
    // 策略：仅补"独有"的键；两端都有但值不同时保持各自不变（避免误伤本地状态）
    let aToB = 0;
    let bToA = 0;

    // A 独有 → 写入 B
    for (const [key, valA] of rowsA) {
      if (PROTOBUF_KEYS.includes(key)) continue;
      if (!rowsB.has(key)) {
        if (!DRY_RUN) {
          dbB.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valA);
        }
        keysUpdated++;
        aToB++;
      }
    }

    // B 独有 → 写入 A（1.7 新增）
    for (const [key, valB] of rowsB) {
      if (PROTOBUF_KEYS.includes(key)) continue;
      if (!rowsA.has(key)) {
        if (!DRY_RUN) {
          dbA.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valB);
        }
        keysUpdated++;
        bToA++;
      }
    }

    if (aToB + bToA > 0) {
      log(`    [↔] 非 protobuf 键互补: 1.23.2→IDE ${aToB} 个，IDE→1.23.2 ${bToA} 个`, "gray");
    }

    // ── 写入后校验：两端 protobuf 键长度均不可为 0 ──
    if (!DRY_RUN) {
      let failureMsg = null;
      for (const [db, label] of [[dbA, "1.23.2"], [dbB, "IDE"]]) {
        for (const key of PROTOBUF_KEYS) {
          const row = db.prepare("SELECT length(value) as len FROM ItemTable WHERE key = ?").get(key);
          if (row && row.len === 0) {
            failureMsg = `${label} 端 ${key} 为 0 字节`;
            break;
          }
        }
        if (failureMsg) break;
      }

      if (failureMsg) {
        // ── 校验失败：事务回滚（2.1：明确打印 ROLLBACK 失败，事务回滚失败时回退到文件级）──
        log(`    [!!] 写入后校验失败: ${failureMsg}`, "red");
        let rollbackOk = true;
        try {
          dbA.exec("ROLLBACK");
        } catch (rbe) {
          log(`    [!!] dbA ROLLBACK 失败: ${rbe.code || rbe.message}`, "red");
          rollbackOk = false;
        }
        try {
          dbB.exec("ROLLBACK");
        } catch (rbe) {
          log(`    [!!] dbB ROLLBACK 失败: ${rbe.code || rbe.message}`, "red");
          rollbackOk = false;
        }
        txStartedA = false;
        txStartedB = false;
        try { dbA.close(); } catch (_) {}
        try { dbB.close(); } catch (_) {}
        dbA = null; dbB = null;
        if (rollbackOk) {
          log("    [!!] 事务已回滚，两端 state.vscdb 状态等同备份前", "yellow");
        } else {
          log("    [!!] 事务回滚失败，启动文件级回滚", "red");
          rollbackFromBackup();
        }
        return;
      }

      // ── 校验通过，提交事务 ──
      dbA.exec("COMMIT");
      txStartedA = false;
      committedA = true;
      dbB.exec("COMMIT");
      txStartedB = false;
      committedB = true;
    }

    dbA.close();
    dbB.close();
    dbA = null; dbB = null;
    syncStats.indexMerge = keysUpdated;

    if (keysUpdated > 0) {
      log(`    └─ 更新了 ${keysUpdated} 个键`, "green");
    } else {
      log("    └─ 两端索引已一致", "gray");
    }
  } catch (e) {
    log(`    [!] state.vscdb 操作失败: ${e.message}`, "red");
    // 2.1：明确打印 ROLLBACK 失败；仅在已有 COMMIT 或 ROLLBACK 自身失败时才文件级回滚
    let rollbackFailed = false;
    if (txStartedA && dbA) {
      try { dbA.exec("ROLLBACK"); }
      catch (rbe) {
        log(`    [!] dbA ROLLBACK 失败: ${rbe.code || rbe.message}`, "red");
        rollbackFailed = true;
      }
    }
    if (txStartedB && dbB) {
      try { dbB.exec("ROLLBACK"); }
      catch (rbe) {
        log(`    [!] dbB ROLLBACK 失败: ${rbe.code || rbe.message}`, "red");
        rollbackFailed = true;
      }
    }
    txStartedA = false;
    txStartedB = false;
    try { if (dbA) dbA.close(); } catch (_) {}
    try { if (dbB) dbB.close(); } catch (_) {}
    if (committedA || committedB || rollbackFailed) {
      // 一侧已提交需撤销（用文件回滚），或事务回滚自身失败 → 启动文件级回滚
      log("    [!] 启动文件级回滚兜底", "yellow");
      rollbackFromBackup();
    } else {
      log("    [!] 事务已回滚，文件级回滚不必要", "gray");
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────────

function main() {
  // 2.1：manifest 用闭包变量持有，让信号/异常 handler 在异常退出时也能保存
  let manifest = null;
  const trySaveManifest = () => {
    if (manifest) {
      try { saveManifest(manifest); } catch (_) {}
    }
  };

  // 退出钩子：保证锁文件释放 + manifest 落盘
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { trySaveManifest(); releaseLock(); process.exit(130); });
  process.on("SIGTERM", () => { trySaveManifest(); releaseLock(); process.exit(143); });
  process.on("uncaughtException", (e) => {
    log(`[未捕获异常] ${e.message}`, "red");
    if (e.stack) log(e.stack, "gray");
    trySaveManifest();
    releaseLock();
    process.exit(1);
  });

  // 1.8：获取并发锁
  acquireLock();

  log("==========================================", "cyan");
  log("      少女阿岚的专属同步引擎 2.2", "cyan");
  if (DRY_RUN) log("      ⚠ DRY-RUN 模式（不修改文件）", "yellow");
  log("==========================================", "cyan");
  log(`环境 A (1.23.2): ${GEMINI_A}`, "gray");
  log(`环境 B (IDE) : ${GEMINI_B}`, "gray");
  log(`索引 A: ${STATE_A}`, "gray");
  log(`索引 B: ${STATE_B}`, "gray");
  log("------------------------------------------", "gray");

  // 前置检查
  if (!fs.existsSync(GEMINI_A) || !fs.existsSync(GEMINI_B)) {
    log("[错误] 找不到对应的 Antigravity 数据目录！", "red");
    process.exit(1);
  }

  // 2.0：进程前置检测——未关闭两端时拒绝运行（语义化退出码 2）
  if (!SKIP_PROCESS_CHECK) {
    const running = checkAppsRunning();
    if (running.length > 0) {
      log("[错误] 检测到 Antigravity 进程仍在运行：", "red");
      for (const r of running) {
        const shown = r.pids.slice(0, 3).join(", ");
        const more  = r.pids.length > 3 ? `, ...等共 ${r.pids.length} 个` : "";
        log(`        - ${r.name}（PID ${shown}${more}）`, "red");
      }
      log("[提示] 请先在任务管理器结束这些进程后重试。", "yellow");
      log("[提示] 如确认需要忽略此检查，可加 --skip-process-check 参数。", "yellow");
      process.exit(EXIT_PROCESS_RUNNING);
    }
    log("[i] 进程检测通过", "gray");
  } else {
    log("[警告] --skip-process-check 已启用，跳过进程检测", "yellow");
  }

  manifest = loadManifest();
  const runTs = timestamp();  // 2.0：整次运行共享一个时间戳，trash 批次按它归类

  // 2.1：try/finally 包住整个同步块，保证 manifest 在任何异常路径都尝试落盘
  try {
    syncConversations(manifest, runTs);
    syncAnnotations(manifest, runTs);
    syncImplicit(manifest, runTs);
    syncKnowledge();
    mergeStateDB();

    // 2.0：清理过期的回收站批次（保留最近 TRASH_KEEP 个）
    const prunedTrash = pruneTrash();
    if (prunedTrash > 0) {
      log(`\n[i] 清理了 ${prunedTrash} 个旧回收批次（保留最近 ${TRASH_KEEP} 个）`, "gray");
    }
  } finally {
    // 即便上方抛错，也至少把已记录的删除/复制状态写进 manifest
    saveManifest(manifest);
  }

  // 汇总
  const total = Object.values(syncStats).reduce((a, b) => a + b, 0);

  log("\n------------------------------------------", "gray");
  if (total > 0) {
    log("【完成】双向同步成功！", "green");
    if (syncStats.copied > 0) log(`  文件复制:   ${syncStats.copied} 个`, "green");
    if (syncStats.deleted > 0) log(`  删除同步:   ${syncStats.deleted} 个`, "yellow");
    if (syncStats.annotations > 0) log(`  索引修复:   ${syncStats.annotations} 个 annotation 补全`, "magenta");
    if (syncStats.implicit > 0) log(`  隐性上下文: ${syncStats.implicit} 个更新`, "green");
    if (syncStats.knowledge > 0) log(`  知识库:     ${syncStats.knowledge} 个文件合并`, "green");
    if (syncStats.indexMerge > 0) log(`  数据库索引: ${syncStats.indexMerge} 个键更新`, "magenta");
  } else {
    log("【提示】两边数据完全一致，已是最新状态！", "green");
  }
  log("==========================================", "cyan");
}

main();
