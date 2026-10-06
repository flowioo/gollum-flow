# 自主运行：当前边界与交付顺序

当前版本包含 **experimental 项目状态层、可选监控循环，以及有预算限制的自主改进实验执行器**。SQLite 是唯一状态源；Skills 是宿主操作协议。`supervisor start` 仍只维护通用任务监控进程；`gollum improve` 单独调用 Claude Code，在隔离仓库执行“复现失败 → 修复 → 独立验证 → 评审 → 保留改进”。配置、恢复与当前边界见 [SELF-IMPROVEMENT.md](./SELF-IMPROVEMENT.md)。进程存活、scheduler 选中任务和任务完成是三个不同的事实。

## 已补齐的基础

- Outcome 必须有 Criterion，全部有效证据 PASS 后才能 VERIFIED。
- 所有恢复类型共享最多 5 次重试预算；恢复中的过期租约也能被 scheduler 释放。
- Task 生命周期、Criterion 写入和 Outcome 完成与对应事件原子提交；支持嵌套事务。
- `task claim --fenced` 生成每次领取独立的 lease token。后续 checkpoint / complete / fail / wait / block / recover / heartbeat ping 必须传 `--lease-token`。被转交或过期的执行者不能继续写入。启用过 fencing 的任务不能通过普通 claim 降级。
- 自动验证记录命令、cwd、verifier 配置与 Git HEAD / 工作树摘要。仓库内容变化后 `remaining-gap` 将旧 PASS 视为 UNKNOWN；原始 Evidence 保留。新增 Criterion 或失败证据会重新打开已完成的 Outcome / Goal。
- 验证命令异步执行，带超时和输出上限；不阻塞 AgentLoop 的心跳计时器。支持预期非零退出码及 stdout / stderr 断言。
- 配额暂停记录自己的等待原因，恢复时不改写其他定时等待，且更新版本号。
- supervisor 使用安装包内的 CLI，后台模式启动父进程；重启预算不会在刚 spawn 时清零，watchdog 检查不会重叠。
- `gollum init` 安装并幂等更新 CLAUDE.md / AGENTS.md 的托管恢复入口，保留用户原文；已有项目再次 init 即可补装。恢复必须先读取 SQLite，不能把其他插件的状态当成未完成任务。
- `gollum status` / `gollum resume` 返回明确的 decision.action（complete/no_work/resume/reverify/wait/needs_attention），并给出当前项目、验收缺口、checkpoint、现场观察和下一步；只读，不领取任务、不执行代码。
- 默认测试不访问真实 GitHub 或个人凭据；网络集成测试显式选择运行。

## 还不能承诺的事情

**fencing 不是沙箱或权限系统。** 旧的手动任务仍兼容无令牌写入。原始 Store API 与数据库访问是受信任接口；任意代码执行器若能写同一数据库，就能绕过上层协议。

**证据是对一次观察的记录。** Git 摘要覆盖 tracked 和 non-ignored untracked 文件，包括内容、模式、路径与 HEAD；不覆盖 ignored 依赖、外部服务、数据库、工具链、环境变量或子模块。无法建立摘要（无 Git、无 HEAD、超过 10,000 个文件 / 32 MiB、读取失败）时 scope 为 null，不能把它当成无人值守的代码版本证明。无人值守的 verifier 配置应设置 `require_scope: true`，摘要不可用时强制返回 UNKNOWN。手工 evidence 是人工声明，并不是独立执行的证明。已 VERIFIED 的状态是历史快照；当前有效性以 remaining-gap / status 的重新检查为准。

**配额计时到期只表示允许探测。** 当前 singleton cooldown 不是供应商“配额已恢复”的证据，也不能隔离不同项目／账户。接通执行器前需改为 provider/account scope，遵循真实 reset / retry-after，探测失败重新退避。

**监控不证明任务在推进。** 心跳只证明事件循环活着；dispatcher 永不返回但心跳正常时仍需独立的任务截止时间和进展预算。

## 接通无人值守前的验收门槛

| 顺序 | 工作 | 必须证明的结果 |
|---|---|---|
| 1 | Host adapter / dispatcher | 用固定 argv 调用一个明确配置的宿主；任务上下文通过文件/stdin 提供；退出码、结构化结果、日志、审批请求可区分；未配置执行器应清楚报告 monitor-only |
| 2 | 项目隔离与运行策略 | 每次 run 绑定 project + repo/worktree + allowlist；只拾取该项目；定义最大任务数、总时长、每次尝试时长、成本/Token 配额和连续无进展上限 |
| 3 | 可取消的执行生命周期 | 独立维护任务心跳；超时/暂停/配额耗尽先停止进程组，再释放执行权；旧进程不能继续修改共享工作区；关机后按 checkpoint 恢复 |
| 4 | 完成判定 | worker 的“完成”进入待验证；独立 verifier 在明确代码版本执行；UNKNOWN 不完成；验证成功后原子完成 Task/Outcome；部分任务按自己的 Criterion 关联验收 |
| 5 | 外部副作用和人工边界 | push、PR、发布、部署各自有策略与幂等键；崩溃发生在外部请求成功、事件未记录之间时，先查询远端再决定重试；需要审批时进入可恢复等待 |
| 6 | 运维与数据寿命 | 每个 run/attempt 保存结构化日志、用量、停止原因；SQLite 在线备份/恢复、迁移兼容测试、日志轮转；singleton supervisor 的互斥启动与 PID 身份校验 |
| 7 | 真实宿主故障演练 | 覆盖进程被杀、网络断开、429、无进展、验证失败、重启、用户暂停；证明无重复外部动作、无串项目、无无限循环；最后再做 24h soak |

这些应分批交付，每批都配故障注入验收。第一批只接一个宿主、一个项目、串行执行，关闭自动发布与自动合并；完成后再扩多宿主/并发。

## 最小自主闭环协议

```text
resolve project → load explicit run policy → inspect workspace/checkpoint
→ select eligible task → fenced claim → create isolated attempt
→ execute host (heartbeat + deadline + cancel)
→ independently verify → persist evidence → complete or bounded recovery
→ reconcile external side effects → next task / durable wait / stop
```

Goal 变更和验收标准放宽必须有显式决策记录，执行器不能为了“全绿”自动降低标准。UNKNOWN 保留为未解决，不用重试掩盖证据不足。

## 本地复现

```bash
npm run build
npm run lint
npm run typecheck
npm test
bash tests/v01-minimal-demo.sh
# 独立网络集成测试，按需显式启用：
GOLLUM_NETWORK_TESTS=1 node --import tsx --test tests/github-cli.test.ts
```

Demo 在临时目录建立 Git 仓库和 SQLite：A 运行失败的真实断言、保存 checkpoint 后异常退出；B 重新打开数据库、回收过期租约、修复代码、执行断言并验证 Goal。过程失败必须非零退出，不修改用户仓库或全局状态。这证明持久化恢复协议，**不等于真实 LLM 自主完成任务或 24h 稳定性验证**。
