# 07 · 项目结构 / CLI / Roadmap / 验收

## 1. 项目结构

```
gollum/
│
├── skills/
│   ├── core/
│   │   ├── task-run/
│   │   ├── task-resume/
│   │   ├── verify/
│   │   └── recover/
│   │
│   ├── coding/
│   ├── research/
│   ├── android/
│   └── robot/
│
├── mcp/
│   ├── core/
│   ├── browser/
│   ├── android/
│   └── robot/
│
├── workflow/
│   ├── store/         # SQLite + CAS + Lease
│   ├── scheduler/     # 唤醒策略
│   └── model/         # 状态机、事件类型
│
├── adapters/
│   ├── codex/
│   ├── claude-code/
│   └── workbuddy/
│
├── cli/
│
├── tests/
│
└── docs/              # 你正在看的目录
```

## 2. CLI

V0.1：

```bash
gollum init

gollum install codex
gollum install claude
gollum install workbuddy

gollum task create
gollum task show
gollum task run
gollum task resume
gollum task cancel

gollum worker start       # 后台 Worker（轮询 + Event 监听）
gollum scheduler start    # 调度器
```

CLI 不暴露 Workflow 内部细节，只做「建 Task / 跑 Task / 看 Task / 装 Host」。

## 3. 第一个 Demo：Autonomous Coding Task

这是 V0.1 的真正考验。

```
GitHub Issue
  ↓
Gollum Task
  ↓
Codex
  ↓
改代码
  ↓
测试
  ↓
PR
  ↓
WAITING
  ↓
CI Event / Timer
  ↓
Resume
  ↓
修复
  ↓
Verify
  ↓
Complete
```

这个 Demo 验证的关键能力：

- ✅ 跨 Session
- ✅ 状态恢复
- ✅ Verify
- ✅ Failure Recovery
- ✅ Wait / Resume
- ✅ 无人值守

**任何一个失败 = V0.1 不通过。**

## 4. 第二阶段：Phone Agent

新增：

```android
android.observe
android.tap
android.input
android.swipe
android.launch
```

Gollum Workflow 完全不改，只增加 Skills + Tools。

## 5. 第三阶段：Robot Agent

新增：

```robot
robot.observe
robot.navigate
robot.pick
robot.place
robot.camera
robot.iot
```

复用：

```
Task / Workflow / Memory / Skill / Verify / Recovery
```

这就是 Gollum 长期最大的架构价值：

> **Digital Agent 与 Embodied Agent 使用同一套 Workflow Model。**

## 6. V0.1 范围

第一阶段严格控制范围。

### 做

```
Workflow Store (SQLite)
Scheduler
Lease + CAS Version
Task Event Log
4 Core Skills
8 Task Tools
Verify: command / git
Codex Integration
```

### 不做

```
Memory Evolution
Skill 自动生成
Multi-Agent
Distributed Scheduler
Vector DB
Robot
Android
复杂 DAG
Workflow DSL
```

## 7. V0.1 验收标准

准备约 20–30 个真实 Coding Task。

测试：

```
Vanilla Codex
  vs
Codex + Gollum
```

比较维度：

| 维度 | 含义 |
|---|---|
| Success Rate | 完成 / 总任务 |
| False Completion | 自报完成但其实没完成 |
| Recovery Rate | 失败后成功恢复的比例 |
| Cross-session Resume | 跨 Session 恢复成功率 |
| Human Intervention | 平均需要人介入次数 |
| Token Cost | 单 Task token 消耗 |
| 完成时间 | wall-clock |

**第一阶段不要求 Gollum 一定降低 Token。**

最重要：

```
Success ↑
False Completion ↓
Recovery ↑
Human Intervention ↓
```

## 8. 自主性指标

未来 Gollum Benchmark：

| 指标 | 定义 |
|---|---|
| Task Success Rate | 完成 / 总任务 |
| Human-free Duration | 单任务无人介入最长时长 |
| Human Intervention Count | 单任务平均介入次数 |
| Cross-session Resume Success Rate | 跨 Session 恢复成功率 |
| Recovery Rate | 失败后恢复比例 |
| False Completion Rate | 假完成比例 |
| Tool Error Rate | Tool 调用失败率 |
| Average Actions / Task | 单任务平均 Tool 次数 |
| Token Cost | Token 消耗 |
| Wall-clock Completion Time | 实际完成时长 |

不要单纯测「Agent 连续运行了多久」，而要测：

> **它多久不需要人介入，还能持续正确推进任务。**