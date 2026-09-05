# dsh-multi-model-orchestrator

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)插件:让主 AI 成为**多模型协作的「主脑」**。任务复杂时,它会把任务拆解成多个子任务,并分派给你所配置的最合适模型(GLM / Kimi / Qwen / 任意 OpenAI 兼容路由)上的子代理,同时按 `provider/model` 统计 **token 用量**。

## 功能

1. **多模型编排指引** —— 注入一段系统提示,引导主脑拆解复杂任务、用 `list_subagent_models` 查看可用路由,并通过 `subagent` 工具带 `provider` / `model` 参数把每个子任务分派出去。
2. **按模型优缺点分派** —— 你只需在配置里写明各路由的优缺点(见配置),主脑便会据此分派(复杂推理给强模型、简单量大给快模型)。
3. **按模型查看 token 用量** —— `model_token_usage` 工具按 `provider/model` 报告输入/输出/缓存读写 token 与请求次数,进程内累计。

插件**不改动任何 harness 内部**。所有模型路由与子代理允许列表都是普通的 harness 配置——见 [examples/settings.yaml](examples/settings.yaml)。

## 安装

安装到某个 dsh profile(通常是 `web`):

```sh
dsh plugin --profile web add dsh-multi-model-orchestrator
```

或从 git 仓库安装:

```sh
dsh plugin --profile web add github:YOU/dsh-multi-model-orchestrator
```

之后重启 harness(或热重载 profile)。插件通过自身的 `cordis.patch.yml` 作为一个 profile 层加载。

## 快速开始

1. **在 `$DSH_HOME/settings.yaml`(默认 `~/.dsh/settings.yaml`)加入第三方模型路由**。GLM / Kimi / Qwen 现成可粘贴的预置见 [examples/settings.yaml](examples/settings.yaml)。每个路由只需在 `apiKeyEnv` 对应的位置填一个 API Key(环境变量、`$DSH_HOME/.credentials.yaml` 或 Web「模型」页均可)。

2. **开启子代理模型选择**,让主脑能为每个子代理挑模型:
   ```yaml
   subagent-model-selection:
     enabled: true
     allowedModels:
       - { provider: glm, model: glm-4.6 }
       # ...其它路由
   ```

3. **(可选)添加模型 Notes**,供主脑分派时参考:
   ```yaml
   multi-model-orchestrator:
     modelNotes:
       glm/glm-4.6:
         description: 智谱旗舰，强推理。
         strengths: 复杂推理、编码、Agent 工具调用
         weaknesses: 较慢、较贵
   ```

4. 重启 harness 后直接提出复杂任务,例如:
   > 把这件事拆成并行的子任务，分别派给最合适的模型。

### API Key

密钥在每个请求时经各路由的 `apiKeyEnv` 解析,任选其一提供:

- **环境变量**:按你路由里写的名字,如 `GLM_API_KEY` / `KIMI_API_KEY` / `DASHSCOPE_API_KEY`。
- **凭据库** `$DSH_HOME/.credentials.yaml`:
  ```yaml
  GLM_API_KEY: sk-xxxx
  KIMI_API_KEY: sk-xxxx
  DASHSCOPE_API_KEY: sk-xxxx
  ```
- **Web「模型」页**:直接粘贴 Key(写入受管凭据文档)。

未配置 Key 的路由会在请求时报 `MISSING_CREDENTIAL`,不影响其它已配置模型。

## 主脑工作流

在主对话直接下达复杂任务即可。主脑会:

1. 用 `todo_write` 记录拆解出的子任务;
2. 调用 `list_subagent_models` 查看可用路由;
3. 通过 `subagent`(带 `provider` / `model`)把每个子任务分派给最合适的模型——在同一条消息里一起启动相互独立的委托,默认后台运行;
4. 汇总各子代理结果,合成最终交付。

查看用量:让主脑调用 `model_token_usage`,或直接问「各模型用了多少 token」。

## 配置参考

全部在 `$DSH_HOME/settings.yaml` 中配置:

| 配置段 | 作用 |
|---|---|
| `llm-pi-ai.providers` | OpenAI 兼容的第三方模型路由(任意厂商)。 |
| `subagent-model-selection` | 允许子代理工具分派的 `{provider, model}` 白名单。 |
| `multi-model-orchestrator.modelNotes` | 各路由优缺点,主脑据此分派。 |

要接入自己的厂商,在 `llm-pi-ai.providers` 下按 `{ api, baseURL, apiKeyEnv, models }` 扩展(任意 `api: openai-completions` 的兼容网关均可),再在 `subagent-model-selection.allowedModels` 与 `multi-model-orchestrator.modelNotes` 补上对应条目。

## 说明与限制

- token 用量为**进程内累计**(重启 harness 后清零);逐条会话用量仍由内置 token meter 展示。
- `model_token_usage` 需要自加载以来至少有一次模型调用返回了 `usage` 块,才会开始输出。
- 编排指引为全局注入,子代理也会读到;其措辞保证子代理在聚焦单一子任务时不会递归拆解。
- 第三方路由默认按「非推理模型」接入;如需推理开关(`reasoningEfforts` / `compat.thinkingFormat`),可在 Web「模型」页为具体模型补上。

## 故障排查

- **`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/...'`** —— 插件是手工 link 的(裸 `link:` + 手工建的 `node_modules` junction),而不是通过 `dsh plugin ... add` 正式安装。请把它装成 profile 的真实依赖并移除 junction。
- **`model_token_usage` 显示 “No records yet”** —— 自加载以来还没有模型调用返回 usage;发一次请求再问即可。
- **子代理无法分派到某路由 / `list_subagent_models` 为空** —— 检查 `subagent-model-selection` 是否为 `enabled: true` 且 `allowedModels` 非空,并确认这些路由存在于 `llm-pi-ai.providers`。

## License

MIT
