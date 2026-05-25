/**
 * Antigravity 双向同步引擎 v4
 * 由阿岚为柳生专属定制
 *
 * 职责：
 *   1. 同步 .gemini 目录下的对话数据（conversations, brain, annotations, implicit, knowledge）
 *   2. 合并 AppData\Roaming 中 state.vscdb 里的对话索引（仅补入 1.32 独有键，以 IDE 为准）
 *   3. 为缺失 annotation 的对话自动生成 .pbtxt 文件
 *
 * v4 修复：implicit 乒乓效应、protobuf 拼接膨胀风险
 *
 * 使用：node --experimental-sqlite sync.js
 * 前提：运行前请关闭 Antigravity 和 Antigravity IDE
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// ── 路径定义 ───────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME;
const GEMINI_A = path.join(HOME, ".gemini", "antigravity");
const GEMINI_B = path.join(HOME, ".gemini", "antigravity-ide");
const APPDATA = process.env.APPDATA;
const STATE_A = path.join(APPDATA, "Antigravity", "User", "globalStorage", "state.vscdb");
const STATE_B = path.join(APPDATA, "Antigravity IDE", "User", "globalStorage", "state.vscdb");

// ── 日志 ───────────────────────────────────────────────────
const COLORS = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

let syncStats = { conversations: 0, brain: 0, annotations: 0, implicit: 0, knowledge: 0, indexMerge: 0 };

function log(msg, color = "white") {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

// ── 工具函数 ───────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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

/**
 * 文件级双向合并：两边各自独有的文件互相复制，
 * 两边都有的取较新的覆盖较旧的。
 * 返回同步的文件数。
 */
function syncDirectoryMerge(dirA, dirB) {
  ensureDir(dirA);
  ensureDir(dirB);

  const filesA = new Map();
  const filesB = new Map();

  for (const f of walkFiles(dirA)) {
    filesA.set(path.relative(dirA, f), fs.statSync(f));
  }
  for (const f of walkFiles(dirB)) {
    filesB.set(path.relative(dirB, f), fs.statSync(f));
  }

  const allKeys = new Set([...filesA.keys(), ...filesB.keys()]);
  let count = 0;

  for (const rel of allKeys) {
    const inA = filesA.has(rel);
    const inB = filesB.has(rel);
    const fullA = path.join(dirA, rel);
    const fullB = path.join(dirB, rel);

    if (inA && !inB) {
      ensureDir(path.dirname(fullB));
      fs.copyFileSync(fullA, fullB);
      count++;
    } else if (!inA && inB) {
      ensureDir(path.dirname(fullA));
      fs.copyFileSync(fullB, fullA);
      count++;
    } else {
      const tA = filesA.get(rel).mtimeMs;
      const tB = filesB.get(rel).mtimeMs;
      if (Math.abs(tA - tB) > 2000) {
        if (tA > tB) {
          fs.copyFileSync(fullA, fullB);
        } else {
          fs.copyFileSync(fullB, fullA);
        }
        count++;
      }
    }
  }
  return count;
}

// ── 第一步：同步 .gemini 下的对话数据 ────────────────────

function syncConversations() {
  log("\n  同步对话文件 (.pb)...", "yellow");
  const convA = path.join(GEMINI_A, "conversations");
  const convB = path.join(GEMINI_B, "conversations");
  ensureDir(convA);
  ensureDir(convB);

  const pbsA = new Map();
  const pbsB = new Map();

  for (const f of fs.readdirSync(convA).filter((n) => n.endsWith(".pb"))) {
    pbsA.set(f, fs.statSync(path.join(convA, f)));
  }
  for (const f of fs.readdirSync(convB).filter((n) => n.endsWith(".pb"))) {
    pbsB.set(f, fs.statSync(path.join(convB, f)));
  }

  const allPbs = new Set([...pbsA.keys(), ...pbsB.keys()]);

  for (const name of allPbs) {
    const inA = pbsA.has(name);
    const inB = pbsB.has(name);
    const fullA = path.join(convA, name);
    const fullB = path.join(convB, name);
    const convId = name.replace(".pb", "");
    let action = null; // "AtoB" | "BtoA" | null

    if (inA && !inB) {
      action = "AtoB";
      log(`    [+] 1.32 独有: ${convId} → IDE`, "green");
    } else if (!inA && inB) {
      action = "BtoA";
      log(`    [+] IDE 独有: ${convId} → 1.32`, "green");
    } else {
      const tA = pbsA.get(name).mtimeMs;
      const tB = pbsB.get(name).mtimeMs;
      if (Math.abs(tA - tB) > 2000) {
        if (tA > tB) {
          action = "AtoB";
          log(`    [↑] ${convId} 1.32 较新 → IDE`, "yellow");
        } else {
          action = "BtoA";
          log(`    [↑] ${convId} IDE 较新 → 1.32`, "yellow");
        }
      }
    }

    if (action === "AtoB") {
      fs.copyFileSync(fullA, fullB);
      syncStats.conversations++;
    } else if (action === "BtoA") {
      fs.copyFileSync(fullB, fullA);
      syncStats.conversations++;
    }

    // brain: 始终文件级合并
    const brainA = path.join(GEMINI_A, "brain", convId);
    const brainB = path.join(GEMINI_B, "brain", convId);
    if (fs.existsSync(brainA) || fs.existsSync(brainB)) {
      const merged = syncDirectoryMerge(brainA, brainB);
      if (merged > 0) {
        log(`      └─ brain/${convId}: ${merged} 个文件合并`, "gray");
        syncStats.brain += merged;
      }
    }

    // annotations: 双向同步
    syncAnnotationFile(convId);
  }
}

function syncAnnotationFile(convId) {
  const annA = path.join(GEMINI_A, "annotations", `${convId}.pbtxt`);
  const annB = path.join(GEMINI_B, "annotations", `${convId}.pbtxt`);
  const hasA = fs.existsSync(annA);
  const hasB = fs.existsSync(annB);

  if (hasA && !hasB) {
    ensureDir(path.dirname(annB));
    fs.copyFileSync(annA, annB);
  } else if (!hasA && hasB) {
    ensureDir(path.dirname(annA));
    fs.copyFileSync(annB, annA);
  } else if (hasA && hasB) {
    const tA = fs.statSync(annA).mtimeMs;
    const tB = fs.statSync(annB).mtimeMs;
    if (Math.abs(tA - tB) > 2000) {
      if (tA > tB) fs.copyFileSync(annA, annB);
      else fs.copyFileSync(annB, annA);
    }
  }
}

// ── 第二步：为缺失 annotation 的对话生成 .pbtxt ──────────

function fixMissingAnnotations() {
  log("\n  检查并修复缺失的 annotation...", "yellow");

  for (const [label, geminiDir] of [["1.32", GEMINI_A], ["IDE", GEMINI_B]]) {
    const convDir = path.join(geminiDir, "conversations");
    const annDir = path.join(geminiDir, "annotations");
    ensureDir(annDir);

    if (!fs.existsSync(convDir)) continue;

    for (const f of fs.readdirSync(convDir).filter((n) => n.endsWith(".pb"))) {
      const convId = f.replace(".pb", "");
      const annPath = path.join(annDir, `${convId}.pbtxt`);

      if (!fs.existsSync(annPath)) {
        const stat = fs.statSync(path.join(convDir, f));
        const epochSec = Math.floor(stat.mtimeMs / 1000);
        const content = `last_user_view_time:{seconds:${epochSec}  nanos:0}`;
        fs.writeFileSync(annPath, content, "utf-8");
        log(`    [✦] [${label}] 生成 annotation: ${convId}`, "magenta");
        syncStats.annotations++;
      }
    }
  }

  // 生成后再确保两边一致
  for (const [src, dst] of [[GEMINI_A, GEMINI_B], [GEMINI_B, GEMINI_A]]) {
    const srcAnn = path.join(src, "annotations");
    const dstAnn = path.join(dst, "annotations");
    ensureDir(dstAnn);
    if (!fs.existsSync(srcAnn)) continue;
    for (const f of fs.readdirSync(srcAnn).filter((n) => n.endsWith(".pbtxt"))) {
      const target = path.join(dstAnn, f);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(srcAnn, f), target);
      }
    }
  }
}

// ── 第三步：同步 implicit / knowledge ────────────────────

function syncImplicit() {
  log("\n  同步 implicit 上下文...", "yellow");
  const dirA = path.join(GEMINI_A, "implicit");
  const dirB = path.join(GEMINI_B, "implicit");
  ensureDir(dirA);
  ensureDir(dirB);

  // 先收集两边文件信息，再统一判断方向（避免乒乓效应）
  const filesA = new Map();
  const filesB = new Map();

  if (fs.existsSync(dirA)) {
    for (const f of fs.readdirSync(dirA).filter((n) => n.endsWith(".pb"))) {
      filesA.set(f, fs.statSync(path.join(dirA, f)));
    }
  }
  if (fs.existsSync(dirB)) {
    for (const f of fs.readdirSync(dirB).filter((n) => n.endsWith(".pb"))) {
      filesB.set(f, fs.statSync(path.join(dirB, f)));
    }
  }

  const allFiles = new Set([...filesA.keys(), ...filesB.keys()]);

  for (const f of allFiles) {
    const inA = filesA.has(f);
    const inB = filesB.has(f);
    const fullA = path.join(dirA, f);
    const fullB = path.join(dirB, f);

    if (inA && !inB) {
      fs.copyFileSync(fullA, fullB);
      log(`    └─ 1.32→IDE: ${f}`, "gray");
      syncStats.implicit++;
    } else if (!inA && inB) {
      fs.copyFileSync(fullB, fullA);
      log(`    └─ IDE→1.32: ${f}`, "gray");
      syncStats.implicit++;
    } else {
      // 两边都有：加 2000ms 容差，取较新的覆盖较旧的
      const tA = filesA.get(f).mtimeMs;
      const tB = filesB.get(f).mtimeMs;
      if (Math.abs(tA - tB) > 2000) {
        if (tA > tB) {
          fs.copyFileSync(fullA, fullB);
          log(`    └─ 1.32→IDE (较新): ${f}`, "gray");
        } else {
          fs.copyFileSync(fullB, fullA);
          log(`    └─ IDE→1.32 (较新): ${f}`, "gray");
        }
        syncStats.implicit++;
      }
    }
  }
  if (syncStats.implicit === 0) log("    └─ 已一致", "gray");
}

function syncKnowledge() {
  log("\n  同步 knowledge 知识库...", "yellow");
  const n = syncDirectoryMerge(path.join(GEMINI_A, "knowledge"), path.join(GEMINI_B, "knowledge"));
  syncStats.knowledge = n;
  log(n > 0 ? `    └─ 合并了 ${n} 个文件` : "    └─ 已一致", "gray");
}

// ── 第四步：合并 state.vscdb 中的对话索引 ────────────────
//
// 策略（v4）：以 IDE 端为准，仅补入 1.32 端独有的键。
// 不做 protobuf 二进制拼接——反复同步会导致条目重复膨胀，甚至反序列化崩溃。
// 只要 .gemini 目录下有 .pb + annotation，IDE 打开后会自行重建索引。

function mergeStateDB() {
  log("\n  合并 state.vscdb 对话索引...", "yellow");

  if (!fs.existsSync(STATE_A)) {
    log("    [!] 1.32 端 state.vscdb 不存在，跳过", "red");
    return;
  }
  if (!fs.existsSync(STATE_B)) {
    log("    [!] IDE 端 state.vscdb 不存在，跳过", "red");
    return;
  }

  // 备份
  const backupB = STATE_B + ".sync_backup";
  fs.copyFileSync(STATE_B, backupB);
  log(`    └─ 已备份 IDE state.vscdb → ${path.basename(backupB)}`, "gray");

  // protobuf 索引键——不做拼接，以 IDE 端为准
  const PROTOBUF_KEYS = new Set([
    "antigravityUnifiedStateSync.trajectorySummaries",
    "antigravityUnifiedStateSync.sidebarWorkspaces",
  ]);

  try {
    const dbA = new DatabaseSync(STATE_A, { readOnly: true });
    const dbB = new DatabaseSync(STATE_B);

    const rowsA = new Map();
    const keysB = new Set();

    for (const row of dbA.prepare("SELECT key, value FROM ItemTable").all()) {
      rowsA.set(row.key, row.value);
    }
    for (const row of dbB.prepare("SELECT key FROM ItemTable").all()) {
      keysB.add(row.key);
    }

    dbA.close();

    // 合并策略：
    // - protobuf 键：跳过（以 IDE 端为准，不拼接不覆盖）
    // - 其他键：仅补入 IDE 端不存在的

    let keysInserted = 0;
    let protobufSkipped = 0;

    for (const [key, valA] of rowsA) {
      if (PROTOBUF_KEYS.has(key)) {
        // protobuf 键：以 IDE 为准，不动
        if (!keysB.has(key)) {
          // IDE 端完全没有这个键——补入
          dbB.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valA);
          log(`    [+] 补入 protobuf 键: ${key}`, "magenta");
          keysInserted++;
        } else {
          protobufSkipped++;
        }
      } else if (!keysB.has(key)) {
        // 普通键：IDE 端没有的才补入
        dbB.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(key, valA);
        keysInserted++;
      }
    }

    dbB.close();

    syncStats.indexMerge = keysInserted;

    if (keysInserted > 0) {
      log(`    └─ 补入了 ${keysInserted} 个 1.32 独有键`, "green");
    }
    if (protobufSkipped > 0) {
      log(`    └─ 跳过 ${protobufSkipped} 个 protobuf 键（以 IDE 为准）`, "gray");
    }
    if (keysInserted === 0 && protobufSkipped === 0) {
      log("    └─ 两端索引已一致", "gray");
    }
  } catch (e) {
    log(`    [!] state.vscdb 操作失败: ${e.message}`, "red");
    log("    [!] 已回滚（备份文件可手动恢复）", "red");
    if (fs.existsSync(backupB)) {
      fs.copyFileSync(backupB, STATE_B);
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────

function main() {
  log("=========================================", "cyan");
  log("     少女阿岚的专属同步引擎 v4", "cyan");
  log("=========================================", "cyan");
  log(`环境 A (1.32): ${GEMINI_A}`, "gray");
  log(`环境 B (IDE) : ${GEMINI_B}`, "gray");
  log(`索引 A: ${STATE_A}`, "gray");
  log(`索引 B: ${STATE_B}`, "gray");
  log("-----------------------------------------", "gray");

  // 前置检查
  if (!fs.existsSync(GEMINI_A) || !fs.existsSync(GEMINI_B)) {
    log("[错误] 找不到对应的 Antigravity 数据目录！", "red");
    process.exit(1);
  }

  syncConversations();
  fixMissingAnnotations();
  syncImplicit();
  syncKnowledge();
  mergeStateDB();

  // 汇总
  const total = Object.values(syncStats).reduce((a, b) => a + b, 0);

  log("\n-----------------------------------------", "gray");
  if (total > 0) {
    log("【完成】双向同步成功！", "green");
    if (syncStats.conversations > 0) log(`  对话文件:   ${syncStats.conversations} 个更新`, "green");
    if (syncStats.brain > 0) log(`  脑区记忆:   ${syncStats.brain} 个文件合并`, "green");
    if (syncStats.annotations > 0) log(`  索引修复:   ${syncStats.annotations} 个 annotation 补全`, "magenta");
    if (syncStats.implicit > 0) log(`  隐性上下文: ${syncStats.implicit} 个更新`, "green");
    if (syncStats.knowledge > 0) log(`  知识库:     ${syncStats.knowledge} 个文件合并`, "green");
    if (syncStats.indexMerge > 0) log(`  数据库索引: ${syncStats.indexMerge} 个键合并`, "magenta");
  } else {
    log("【提示】两边数据完全一致，已是最新状态！", "green");
  }
  log("=========================================", "cyan");
}

main();
