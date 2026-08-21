# dsh-toolcall-compat

> 注意！这是大肥鱼100%纯vibe出来的插件，没有人类了，因为我不会写ts和前端（

DSH 插件，解决第三方模型（GPT 等）用 DSH ToolCall 时的两个问题：

1. 模型在工具调用参数里乱带 `sandbox_permissions` / `justification`，每次重试都撞上同一个校验错误；
2. 某些工具调用长时间不返回，整个回合卡住，没有跳过的办法。

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

开关默认开启，在 设置 → 插件配置（Settings → Plugins）里的 ToolCall Compat 卡片。只影响带这两个键的调用，其余参数、调用 ID、工具名原样不动；非 JSON 参数直接放行，不会破坏流。

## 功能二：跳过卡住的调用（stuck-skip）

Host 侧在 `tools/execute` 外层记录每个 in-flight 调用，把真实派发和"用户跳过"信号做 race。浏览器端自绘了 `tool-call` 节点（`conversation.chat.node` 是单胜者插槽，要在官方卡片上方插提示条只能替换整个渲染器，官方专用视图就看不到了），当某个调用运行超过阈值（默认 15s，可在插件配置里改），卡片上方会出现提示条：

> ⚠ 工具调用长时间未响应：bash（已运行 42s）[跳过]

点「跳过」之后：

1. Host 中止该调用的融合 signal（能配合的工具会终止底层进程）；
2. race 用错误形状的结果完结这次调用，LLM 下一步会看到类似 `skipped because unresponsive ... do not retry` 的说明；
3. 派发管线照常提交 `tool/result`，对话继续。

跳过结果必须用错误形状（`isError: true` + `error.info.code: 'TOOL_SKIPPED'`），因为 DSH 会对成功结果按工具自己的 output schema 重新校验（比如 pwsh 只接受 `{kind: 'background'|'foreground'}` 且禁止额外字段），通用的成功值永远过不了；错误结果不走这条校验。

参数被剥离的那次调用，卡片上会有一个黄色的 `compat bypass` 徽标，方便你看出这次调用被改过。

## 安装

### 构建

```bash
npm install
npm run build   # tsc → lib/
npm test        # 契约测试（node --test）
```

### 装进 DSH（web profile）

1. 让 DSH 能从 profile 目录解析到本包。两种方式：

   ```powershell
   # 方式 A：官方命令（需要装 pnpm）
   dsh plugin --profile web add C:\path\to\dsh-toolcall-compat

   # 方式 B：手动把构建好的包放进 profile 的 node_modules
   # loader 从 $DSH_HOME\profiles\web 向上找 node_modules，放到
   # $DSH_HOME\profiles\node_modules\@yukari316\dsh-toolcall-compat 即可
   # （连同 lib\、package.json、README.md、LICENSE）
   ```

2. 在 `$DSH_HOME\profiles\web\cordis.patch.yml` 里加一行：

   ```yaml
   - insert:
       - id: toolcall-compat
         name: '@yukari316/dsh-toolcall-compat'
   ```

3. 重启 `dsh web`，到 设置 → 插件配置 应该能看到 ToolCall Compat 卡片。

### 浏览器半部说明（重要）

Host 半部（兼容模式 + 跳过服务）按上面装好就能跑。浏览器 UI 半部会被自动发现（package.json 里的 `dsh.client` 声明 + `./client` 导出），但浏览器加载的是包里 `lib/client.js` 的原始文件，它必须是 `window.__ModuleLoader__.load({id, factory})` 的 factory 格式。官方的 `clientBundle` 构建预设没有随 npm 包发布（在 DSH 源码仓库 `packages/client/tsdown.client.ts` 里），仓库外的插件得自己复刻这个构建。当前 `npm run build` 只做 tsc，产出的普通 ESM 浏览器模块系统无法注册，所以**静态安装目前只有 Host 半部生效**；浏览器 UI 是在会话内通过动态插件验证的。

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 兼容模式总开关 |
| `renderEscapes` | `true` | 展开卡片时把转义序列显示成字符 |
| `stuckAfterMs` | `15000` | 调用运行超过多久才提示可跳过（1–600s） |

## 卸载

把 `cordis.patch.yml` 里的行删掉，移除 profile node_modules 里的包，重启即可。设置项没有独立开关的：兼容模式可以在插件配置里关掉；跳过功能只在有调用超过阈值时出现提示条，且只影响你点「跳过」的那一个调用。

## License

MIT © Yukari316
