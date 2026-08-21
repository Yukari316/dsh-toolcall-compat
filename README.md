# dsh-toolcall-compat

> 注意！这是大肥鱼100%纯vibe出来的插件，没有人类了，因为我不会写ts和前端（

DSH 插件，解决第三方模型（GPT 等）用 DSH ToolCall 时的两个问题：

1. 模型错误解析tool call schema中的 `sandbox_permissions` / `justification` 参数，导致每次重试都带入了这些不必要的参数导致tool call失败； ~~尤其是GPT-5.6-sol！~~
2. 某些工具调用长时间不返回，整个回合卡住，并且无法跳过只能干等。

- npm：https://www.npmjs.com/package/@yukari316/dsh-toolcall-compat

## 功能一：兼容模式（schema-fix）

由于 DSH 对tool call的升级参数校验很严格：

- `sandbox_permissions` 和 `justification` 必须成对出现，且 `justification` 必须是非空句子，否则报错 `invalid justification: expected a non-empty sentence`；
- 请求的 `sandbox_permissions` 必须严格宽于当前生效模式，否则报错 `sandbox escalation to "..." is not strictly wider than this call's current "..." mode`。

GPT 这类模型经常把这两个字段塞进每一次调用，结果就是每次重试都在同一个错误上失败。工具参数在派发时会被 deepFreeze，下游 hook 改不了，所以这个插件在更上游的 `llm/stream` 流里修改错误的tool call请求：agent loop 是用流里的 `block-end` chunk 组装 assistant 消息的，在这里改写 `tool-call` 块的 `arguments`。

开关默认开启。只影响带这两个键的tool call，一般为修改文件的这类tool，其余参数、调用 ID、工具名没有修改。

参数被剥离的那次调用，卡片上会有一个黄色的 `compat bypass` 徽标，方便你看出这次调用被改过。

## 功能二：跳过卡住的调用（stuck-skip）

对于一部分会直接卡死对话的tool call，dsh目前还不能直接中断tool call或者设置tool call超时，导致session除了手动停止之外只能一直被卡住，这个功能在tool call超出一定时间后（默认15s）在tool call上方提示疑似执行时间过长，并添加跳过按钮

> ⚠ 工具调用长时间未响应：bash（已运行 42s）[跳过]

在点「跳过」之后：

没有响应的tool call会被终止，LLM会在下一步看到提示：`skipped because unresponsive ... do not retry`，并且能够继续任务执行。

## 安装

装好 DSH 之后，一条命令搞定，不用改任何配置文件。

### 方式一：官方命令（需要 pnpm）

```powershell
dsh plugin --profile web add @yukari316/dsh-toolcall-compat
```

### 方式二：没有 pnpm，用 npm

```powershell
npx -y @yukari316/dsh-toolcall-compat
```

这个命令会：把包装进 web profile 的 `node_modules`、自动在 profile 的 `dsh.profile.bundles` 里注册插件并提示重启。想装到别的 profile 就加 `--profile <名字>`。

### 怎么确认生效

让模型（比如 GPT 5.6 Sol）执行一次会触发沙箱权限的工具调用：

- 不再报 `invalid justification` / `sandbox escalation ... not strictly wider`，说明兼容模式在工作；
- 装了插件前后的调用日志里，带 `sandbox_permissions` / `justification` 的调用数量会明显减少。

### 更新 / 卸载

更新：

```powershell
dsh plugin --profile web update @yukari316/dsh-toolcall-compat   # pnpm
# 或者
npx -y @yukari316/dsh-toolcall-compat                            # npm，重复执行即更新
```

卸载：从 profile 的 `package.json` 里删掉 `dsh.profile.bundles` 中的 `@yukari316/dsh-toolcall-compat` 和 `dependencies` 里的对应项，再重启 `dsh web`。

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 兼容模式总开关 |
| `renderEscapes` | `true` | 展开卡片时把转义序列显示成字符 |
| `stuckAfterMs` | `15000` | 调用运行超过多久才提示可跳过（1–600s） |

设置界面随包发布。想改默认值，可以在 `$DSH_HOME\settings.yaml` 里加一段：

```yaml
toolcall-compat:
  enabled: true
  renderEscapes: true
  stuckAfterMs: 15000
```

## 从源码构建（开发者）

```bash
npm install
npm run build   # tsc → lib/，再把 client 半部打成 DSH 浏览器 bundle
npm test        # 契约测试
```

`npm publish` 前会自动重新构建（`prepack`）。

## License

MIT © Yukari316
