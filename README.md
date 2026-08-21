# dsh-toolcall-compat

> 注意！这是大肥鱼100%纯vibe出来的插件，没有人类了，因为我不会写ts和前端（

DSH 插件，解决第三方模型（GPT 等）用 DSH ToolCall 时的两个问题：

1. 模型在工具调用参数里乱带 `sandbox_permissions` / `justification`，每次重试都撞上同一个校验错误；
2. 某些工具调用长时间不返回，整个回合卡住，没有跳过的办法。

- npm：https://www.npmjs.com/package/@yukari316/dsh-toolcall-compat
- 源码：https://github.com/Yukari316/dsh-toolcall-compat

## 功能一：兼容模式（schema-fix）

DSH 对工具调用的升级参数校验很严格：

- `sandbox_permissions` 和 `justification` 必须成对出现，且 `justification` 必须是非空句子，否则报 `invalid justification: expected a non-empty sentence`；
- 请求的 `sandbox_permissions` 必须严格宽于当前生效模式，否则报 `sandbox escalation to "..." is not strictly wider than this call's current "..." mode`。

GPT 这类模型经常把这两个字段塞进每一次调用，结果就是每次重试都在同一个错误上失败。工具参数在派发时会被 deepFreeze，下游 hook 改不了，所以这个插件在更上游的 `llm/stream` 流里动手：agent loop 是用流里的 `block-end` chunk 组装 assistant 消息的，在这里改写 `tool-call` 块的 `arguments`，派发、日志、回放一次全修好。

怎么判，看本次调用生效的沙箱模式（`sandboxPolicy.resolve({ session }).mode`，按 DSH 自己的严格更宽阶梯）：

- **Full access**：阶梯顶端没有更宽的模式，`sandbox_permissions` 传什么都冗余，一律剥离（GPT 反复失败主要就是这种情况）；
- **受限模式（read-only / workspace-write）**：
  - 参数对畸形（两个键不成对、理由为空或非字符串、目标不是合法模式）→ 剥离，避免执行时报校验错；
  - 合法提权（非空理由 + 目标严格更宽于当前模式）→ 原样保留，走 DSH 正常的用户审批流程；
- 模式解析不出来时（没有 sandboxPolicy 服务、找不到会话等）→ 保守处理：只剥离畸形和冗余的，不猜。

开关默认开启。只影响带这两个键的调用，其余参数、调用 ID、工具名原样不动；非 JSON 参数直接放行，不会破坏流。

## 功能二：跳过卡住的调用（stuck-skip）

Host 侧在 `tools/execute` 外层记录每个 in-flight 调用，把真实派发和"用户跳过"信号做 race。浏览器端自绘了 `tool-call` 节点（`conversation.chat.node` 是单胜者插槽，要在官方卡片上方插提示条只能替换整个渲染器，官方专用视图就看不到了），当某个调用运行超过阈值（默认 15s），卡片上方会出现提示条：

> ⚠ 工具调用长时间未响应：bash（已运行 42s）[跳过]

点「跳过」之后：

1. Host 中止该调用的融合 signal（能配合的工具会终止底层进程）；
2. race 用错误形状的结果完结这次调用，LLM 下一步会看到类似 `skipped because unresponsive ... do not retry` 的说明；
3. 派发管线照常提交 `tool/result`，对话继续。

跳过结果必须用错误形状（`isError: true` + `error.info.code: 'TOOL_SKIPPED'`），因为 DSH 会对成功结果按工具自己的 output schema 重新校验（比如 pwsh 只接受 `{kind: 'background'|'foreground'}` 且禁止额外字段），通用的成功值永远过不了；错误结果不走这条校验。

参数被剥离的那次调用，卡片上会有一个黄色的 `compat bypass` 徽标，方便你看出这次调用被改过。

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

这个命令会：把包装进 web profile 的 `node_modules`、自动在 profile 的 `dsh.profile.bundles` 里注册插件（重复执行不会重复注册）、提示你重启。想装到别的 profile 就加 `--profile <名字>`。

### 装完

```powershell
dsh web
```

插件默认开启，不用额外设置。想改默认值，见下面的「设置项」。

### 怎么确认生效

让模型（比如 GPT）执行一次会触发沙箱权限的工具调用：

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

> 为什么以前要两步（装包 + 手改 `cordis.patch.yml`）？DSH 只启动组合配置里列出来的插件，`npm install` 只是把代码放进磁盘。这个包现在声明了 `dsh.bundle`，自带启用 patch（`cordis.patch.yml`），`dsh plugin add` / 上面的 npx 命令会自动完成注册，所以不需要再手动加行。

## 装完之后：能用的部分

这个插件由两部分组成，0.1.2 起两部分都随包发布：

- **服务端部分**：跑在 DSH 进程里，负责修正工具调用参数、跟踪和跳过卡住的调用。兼容模式默认开启，装好重启后就开始起作用。
- **浏览器部分**：网页里的界面——设置卡片（设置 → 插件配置 里的 ToolCall Compat）、工具调用卡片上的「跳过」按钮和 `compat bypass` 徽标。这部分打包成 DSH 浏览器模块系统要求的格式随包发布，安装后即可加载。

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
