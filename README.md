# Antigravity 双向同步引擎

在 **Antigravity 1.23.2 端** 与 **Antigravity IDE 端** 之间双向同步对话数据，并合并 `state.vscdb` 侧边栏对话索引。同步覆盖 `conversations / brain / annotations / implicit / knowledge`：复制新增、传播删除、合并索引，并为缺失注解的对话自动补 `.pbtxt`。

> 当前版本 **2.2** · 由阿岚为柳生专属定制。

---

## ⚠️ 先读这里：本工具会删除数据

这是**带删除同步**的工具——一端删掉的文件，同步时会被删到另一端。动手前务必了解：

- **首次运行前，手动完整备份 `%USERPROFILE%\.gemini\` 目录。** 首次运行没有 manifest，会把两端文件全部视作新增，两端同名文件**较新的直接覆盖较旧的（旧内容无提示丢失）**。详见 [首次运行](#首次运行)。
- **运行前完全关闭两端 IDE。** 关窗口 ≠ 进程已退出，否则可能损坏 `state.vscdb`。
- **被删文件不会立刻消失**：删除前自动进回收站 `~/.gemini/.sync_trash/`（保留最近 **5** 个批次）。发现误删要尽早恢复，见 [误删恢复](#误删恢复)。
- **两端都被手动删除的文件无法恢复**（内容已不可得，回收站也救不回）。
- 拿不准时，先跑 `--dry-run` 预览，不会动任何文件。

---

## 运行前提

- **Windows 平台**（依赖 `%APPDATA%` 路径，非 Windows 直接退出）。
- **Node.js 22.5+**（`node:sqlite` 模块所需）。
- 运行需带 `--experimental-sqlite` 参数（`sync.bat` 已内置）。

## 用法

1. **完全关闭** Antigravity 与 Antigravity IDE 两端。
2. 进入 `本体/` 目录，双击 `sync.bat`。
3. 按提示按任意键开始。

关窗口**不一定代表进程已退出**。脚本启动时调用 `tasklist` 枚举以 `Antigravity` / `Antigravity IDE` 为前缀的主进程与子进程，检测到仍在运行则拒绝执行、打印各组 PID 并返回**退出码 2**（区别于一般错误码 1）。手动结束：任务管理器（Ctrl+Shift+Esc）→ 右键条目 → 结束任务。

### 命令行参数

在仓库的 `本体/` 目录下执行：

```cmd
node --experimental-sqlite sync.js                          # 正常同步
node --experimental-sqlite sync.js --dry-run                # 预览模式
node --experimental-sqlite sync.js --dry-run --skip-process-check
```

| 参数 | 说明 |
|---|---|
| `--dry-run` | 预览模式，不修改任何文件（含锁、回收站、备份）。可与下方参数叠加 |
| `--skip-process-check` | 跳过进程前置检测，仅在系统 `tasklist` 故障时使用 |

### 首次运行

首次运行（或删除 `~/.gemini/.sync_manifest.json` 后），脚本把两端文件视作**全部新增**：

- 一端独有的文件 → 复制到另一端。
- 两端同名的文件 → **较新的覆盖较旧的**（旧版本静默丢失）。

manifest 在首次同步后才生成，之后才能正确识别"删除"。**强烈建议首次运行前手动备份整个 `%USERPROFILE%\.gemini\` 目录**，以防覆盖到不该覆盖的内容。

---

## 同步范围

| 数据 | 增加 | 删除 | 备注 |
|---|:---:|---|---|
| `conversations/*.pb` | ✅ | ✅ + 入回收站 | 对话内容 |
| `brain/<convId>/*` | ✅ | ✅ + 级联清理 + 入回收站 | 对话被删时整目录清掉 |
| `annotations/*.pbtxt` | ✅ | ⚠️ 自维护 | 见设计取舍 |
| `implicit/*` | ✅ | ✅ + 入回收站 | 隐性上下文 |
| `knowledge/*` | ✅ | ❌ **只增不删** | 见设计取舍 |
| `state.vscdb` 索引 | ✅ | ✅ 间接 | 侧边栏对话列表 |

### 设计取舍（重要）

1. **`knowledge` 只增不删** —— 知识库是积累型，单端删除后跑同步会被另一端复制回来（有意保护，非 bug）。要真正清理：在**两端同时**手动删除目标文件后再跑同步。
2. **`annotations` 自维护** —— `.pbtxt` 是 `.pb` 的元数据。只删 `.pbtxt` 而保留 `.pb`，下次同步会**自动重新生成**。要让注解真正消失，请删对应的 `.pb`。
3. **`state.vscdb` 主权方按 mtime 判定** —— 两端中较新的一方为主权方（两端时间极接近时默认以 1.23.2 端为主），protobuf 索引以它为准覆盖另一端。因此约定 **同一时间只用一端**：用完一端 → 关闭 → 跑同步 → 再切到另一端。若两端"同时独立活跃"（同步前各自都产生了新对话），从属方独有的对话索引可能丢失。

---

## 安全机制

每次同步自动执行：

1. **备份两端 `state.vscdb`**（`.backup_<时间戳>` 后缀，每端保留最近 5 份）。
2. SQLite 写入包裹 `BEGIN IMMEDIATE` **事务**，校验失败自动 ROLLBACK；事务回滚也失败时，从文件备份恢复（每端独立）。
3. **删除前先入回收站** `~/.gemini/.sync_trash/<时间戳>/<域>/<原相对路径>`（同一次同步的所有删除共享一个时间戳，保留最近 5 个批次，更早整批淘汰）。
4. **并发锁**防止重复运行（PID 文件 + 僵尸锁自动清理；2.2 起用 `tasklist` 复核进程名，抵御 OS 把 PID 回收给 chrome/explorer 等的误判）。
5. **进程前置检测**：检测到任一端仍在运行直接拒绝执行，退出码 2。
6. manifest 原子写 + 损坏自动备份为 `.corrupted_<时间戳>`；异常路径（含 Ctrl+C）也保证 manifest 落盘。

### 误删恢复

被同步删除的文件落在：

```
~/.gemini/.sync_trash/<时间戳>/<域>/<原相对路径>
```

恢复步骤：找到对应批次（时间戳最新在最上）→ 按原路径复制回 `~/.gemini/antigravity/` 或 `antigravity-ide/` → 再跑一次同步，传播到另一端。brain 目录若两端内容分歧，会分别归档为 `<convId>__A/`（1.23.2 端）与 `<convId>__B/`（IDE 端），复制回去时去掉 `__A`/`__B` 后缀。

> ⚠️ 回收站只保留最近 **5** 个批次，超过 5 次同步后旧批次被淘汰——发现误删要尽早恢复。**两端都被手动删除的文件没有备份**，不可恢复。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `database is locked` / `operation failed` | 进程未完全退出。任务管理器结束所有相关进程后重试。 |
| 神秘路径错误（找不到文件、解析失败） | 中文 Windows 用户名可能命中 Node / SQLite 的中文路径兼容性边界。复制完整错误栈给阿岚。 |
| `另一个同步进程正在运行 (PID=X)` | 上次未正常退出。确认无其他进程后手动删除 `~/.gemini/.sync.lock` 重试（通常会自动清僵尸锁，极端情况需手动）。 |
| `manifest 文件损坏` | 自动备份为 `.corrupted_<时间戳>`，本次视所有文件为新增，**不触发删除同步**。 |
| 警告 `tasklist 调用失败` | 系统 `tasklist` 异常（极少见，可能被组策略限制）。打印警告后继续，请自行确认两端已关闭；长期问题可固定加 `--skip-process-check`。 |
| `检测到 Antigravity 进程仍在运行`（退出码 2） | 子进程没退干净。结束所有相关进程后重试；紧急可加 `--skip-process-check` 绕过，但**务必确保两端真的已关闭**，否则可能损坏数据。 |

---

## 路径参考

| 项 | 路径 |
|---|---|
| 工作目录 A（1.23.2 端） | `%USERPROFILE%\.gemini\antigravity\` |
| 工作目录 B（IDE 端） | `%USERPROFILE%\.gemini\antigravity-ide\` |
| 索引 A | `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` |
| 索引 B | `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` |
| Manifest | `%USERPROFILE%\.gemini\.sync_manifest.json` |
| 锁文件 | `%USERPROFILE%\.gemini\.sync.lock` |
| 回收站 | `%USERPROFILE%\.gemini\.sync_trash\<时间戳>\<域>\` |

---

## LINUX DO
<p align="center">
    <a href="https://linux.do" alt="LINUX DO">
        <img
            src="https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+" /></a>
</p>

## 版本历史

<details>
<summary>展开查看 1.5 → 2.2</summary>

- **2.2（当前）**：ghost-annotation 清理加 conversations 缺失守卫（临时移走目录不再误清空 `.pbtxt`）；`acquireLock` 用 `tasklist` 复核 PID 进程名（仅 `node`/`sync` 才认作真同步进程），抵御 OS 把 PID 回收给 chrome/explorer 等的误判；`.pb`/`.pbtxt` 后缀剥离改用 `path.basename` 防子串错切。
- **2.1**：brain 级联双侧备份（`<id>__A` / `<id>__B`）；锁四状态分类（live / stale / unparseable / unknown，未知态不删锁、仅重试）；安全错误隔离（safeCopy / backupToTrash 失败不中断同步、保留文件待重试）；mergeStateDB 条件化文件回滚 + 显式打印 ROLLBACK 错误；main 用 try/finally 保 manifest 落盘。
- **2.0**：文件级回收站（删除前入 `.sync_trash`，保留最近 5 批）；进程前置检测（退出码 2）；`--skip-process-check` 逃生通道。
- **1.9**：safeCopy 继承源 mtime（消除伪冲突）；manifest 原子写；锁原子创建 + PID 复核 + 循环重试；提取魔法常量；清理死代码。
- **1.8**：Windows 平台检查；并发锁 + 僵尸锁清理；manifest 损坏检测；state.vscdb 备份自动清理（每端留 5 份）。
- **1.7**：state.vscdb 非 protobuf 键双向互补；SQLite 写入事务保护。
- **1.6**：state.vscdb 主权方改按 mtime 判定；brain 删除追踪 + 对话删除级联清理。
- **1.5**：废弃 protobuf 拼接策略；引入 manifest 实现删除同步；新增 `--dry-run`、时间戳备份、合并后校验。

</details>
