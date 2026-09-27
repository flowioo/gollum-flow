# 05 · Tool 架构与 ToolResult 协议

## 1. MCP 拆分

Tools 通过 MCP 暴露，按 Domain 拆：

```
gollum-core-mcp        task.*  verify.command  verify.git  memory.*
gollum-browser-mcp     verify.browser  browser.*
gollum-android-mcp    android.*  verify.android
gollum-robot-mcp      robot.*  verify.robot
```

Domain 拆分的好处：

- 单进程崩溃不会拖垮所有 Tool
- 不同 Agent Host 可按需加载
- 安全边界更清晰

## 2. Core MCP Tools（V0.1 首批）

```
task.create
task.get
task.claim

task.checkpoint

task.wait
task.block
task.complete
task.fail
```

后续补：

```
task.list
task.release
task.retry
task.cancel
```

## 3. Verify Tools（统一接口）

```
verify.command
verify.file
verify.http
verify.git
verify.browser
verify.android
verify.robot
```

每个 Tool 都返回统一结构：

### PASS

```json
{
  "status": "PASS",
  "assertion": "all tests pass",
  "evidence": {
    "command": "./gradlew test",
    "exit_code": 0,
    "summary": "428 tests passed"
  }
}
```

### FAIL

```json
{
  "status": "FAIL",
  "assertion": "target app is foreground",
  "evidence": {
    "expected": "com.autonavi.minimap",
    "actual": "com.android.launcher"
  },
  "reason": "foreground package mismatch"
}
```

## 4. ToolResult 协议

所有 Gollum Tool 统一响应：

```json
{
  "ok": true,
  "data": {},
  "observation": "...",
  "evidence": [],
  "error": null
}
```

失败：

```json
{
  "ok": false,
  "data": null,
  "observation": "...",
  "error": {
    "type": "ENVIRONMENT_CHANGED",
    "message": "...",
    "retryable": true
  }
}
```

### 核心原则

```
Tool
  = Action
  + Observation
  + Evidence
  + Failure Semantics
```

不是「执行 + 返回值」，而是「执行 + 客观观察 + 物证 + 失败分类」。

### 错误分类（V1 建议）

| type | retryable | 含义 |
|---|---|---|
| `ENVIRONMENT_CHANGED` | true | 目标状态变了，需要 re-observe |
| `CAS_CONFLICT` | true | Version 不匹配，需要 task.get 重新决策 |
| `LEASE_LOST` | true | lease 已被回收，应放弃 |
| `ASSERTION_FAILED` | false | 验证不通过，走 recover |
| `PERMISSION_DENIED` | false | 走 task.block |
| `TIMEOUT` | true | 可能网络/系统慢，重试或 escalate |
| `INTERNAL_ERROR` | false | Tool bug，走 task.fail |
| `USER_INPUT_NEEDED` | false | 走 task.block |