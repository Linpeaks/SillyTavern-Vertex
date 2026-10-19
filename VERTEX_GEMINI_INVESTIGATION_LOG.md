# Vertex / Gemini 调查与变更总日志

本日志是本工作区有关本次调查的唯一汇总记录。后续每轮对话追加条目，保留历史结论及其证据等级；出现新证据时追加更正，不把旧推断改写成已证实事实。

## 记录规则

- 每轮记录：用户目标与补充、授权范围、调查结论、实际修改文件及原因、执行的验证和结果、未验证项、Git 状态、下一步。
- 业务修改先给出具体方案，取得用户确认后实施。记录文档、隔离复现和本地 Git 管理已由本轮用户要求授权。
- 实现按独立问题分别提交；同一提交包含相关日志。不得把网络、模型参数、工具解析、预设调整混成一个修复。
- 不记录凭据、服务账户私钥、Authorization、真实提示词、聊天正文或工具参数正文。账号与项目标识在记录中省略。
- 本地提交用于追溯；没有要求时不推送任何远端。原始 data、config.yaml、预设及插件保持独立，不用强制添加方式纳入 Git。
- 修复后以 git revert 精确撤销对应实现提交，保留后续历史；不使用 reset --hard 或 clean 清理用户文件。

## 001 · 2026-10-18（Asia/Shanghai）· 初始调查

状态：调查完成，业务修改待用户确认。当前未修复生产代码，未调用 Google 模型生成。

### 用户输入及边界

1. 用户提供原生 Vertex streamGenerateContent 在 node-fetch 抛出 system / ECONNRESET / socket hang up 的堆栈。旧仓库曾加 HTTP/2 PING（15 秒，后改 30 秒）并改善过问题；后续多次修改出现空回复等问题，已删除旧仓库并重新克隆官方代码。
2. 要求谨慎调查、分析、规划、详细解释后确认修改；统一记录每次对话的结果及原因，并用 Git 管理。
3. 本轮补充：网络使用 TUN；预设为防截断，把正文放在工具调用里；尚无可见文字时失效。未提供稳定的断开秒数。
4. 本轮不重建旧仓库，不推断旧补丁实现，不修改业务代码、配置、用户数据、预设或插件，不启动/重启 SillyTavern，不进行付费生成。

### 基线

| 项目 | 实测结果 |
| --- | --- |
| 工作区 | D:\AIsoftware\SillyTavern |
| 应用版本 | package.json: 1.19.0 |
| 原始分支 / HEAD | release / 06bde939fb1e9c4c8d8641d810f0a916b5bce127 |
| 原始工作区 | git status --porcelain=v1 无输出，已跟踪内容干净 |
| origin | 官方 SillyTavern/SillyTavern GitHub 仓库 |
| 远端核对 | git ls-remote: release 为同一 SHA；staging 为 ad29cbda62e92f145e44d7a10398a38af22ca986 |
| staging 对照 | 本地 origin/staging 与远端 SHA 一致；所检两个后端文件仍未把 Argon 接入思考判断/转换，不能靠盲目切 staging 解决 |
| 调查分支 | codex/vertex-gemini-investigation |
| 本轮命令使用的 Node | v26.1.0；不等同于已核实真实运行的酒馆进程环境 |
| 安装依赖 | node-fetch 3.3.2、proxy-agent 6.5.0 |
| 正式 Jest 运行器 | tests/node_modules/jest/bin/jest.js 不存在；没有安装依赖或宣称全套测试通过 |
| AGENTS | 初始未发现适用父级/仓库 AGENTS.md；本轮新增根目录记录规则 |

只读取必要设置字段，未输出密钥或聊天内容：

- source=vertexai，model=gemini-4-argon，auth=full，region=global。
- stream_openai=true，reasoning_effort=high，show_thoughts=true，max_tokens=65535。
- function_calling=true，tool_reasoning_mode=disabled，custom_prompt_post_processing=merge_tools。
- reverse_proxy 为空；config.yaml 的 requestProxy.enabled=false、enableKeepAlive=false。
- 本次命令进程没有检出相关 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 环境变量。不能据此推断酒馆真实进程环境或排除 TUN。
- config.yaml 的 gemini.apiVersion=v1beta 只用于 AI Studio 分支；当前原生 Vertex 的 URL 在代码中写为 /v1。
- config.yaml 和 data/default-user/settings.json 均由 .gitignore 忽略。
- CIM 进程查询被当前环境拒绝，因此未取得酒馆进程命令行。没有为此更改系统权限或进程。

### A. ECONNRESET：证据、推断与未知

**已证实的当前代码路径**

浏览器设置 → /api/backends/chat-completions/generate → sendMakerSuiteRequest → node-fetch → Node https.request（HTTP/1.1）→ 当前网络路径/TUN → Google；响应再通过 forwardFetchResponse 管道转发。

- src/endpoints/backends/chat-completions.js:454、673、733、740、787：认证后创建 AbortController，建立 Google 请求，流式时转发，外层捕获通信异常。
- node_modules/node-fetch/src/index.js:64-65、94、107-109：底层使用 http/https.request；请求 error 被包装成用户提供的 FetchError。
- 当前这条生成路径没有 HTTP/2 session、PING 定时器或自动重提交循环。
- src/server-main.js:100-101 与 src/request-proxy.js:19-55：全局 HTTP Agent 与显式代理按配置建立。enableKeepAlive 是连接复用相关设置，不是在活跃生成中定期发 HTTP/2 PING 的等价开关。
- src/util.js:791 的 makeHttp2Request 虽然已存在，但未被当前生成路径调用。它缓存完整响应、缺少取消与完整清理，且 :path 只取 pathname 会丢 query，不适合直接拿来替代 SSE 请求。

**堆栈含义**

用户堆栈在 ClientRequest / TLSSocket.socketOnEnd 和 fetch await 处，强烈指向收到完整 HTTP 响应头前连接提前关闭。Node 官方文档将这一阶段的提前关闭列为 socket hang up / ECONNRESET。它没有携带 HTTP 状态码，不能等同于 400 参数错误、429 配额错误或“模型返回空候选”。

这是对这份堆栈的阶段判断；不能据此断言某个网络设备发送了 RST。用户看到无文字也不能单独证明无 SSE、无 thoughts 或无 functionCall。

**当前较合理的假设**

TUN / 出口节点 / 中间设备 / Google 边缘链路在较长静默阶段断开连接。旧实现加 PING 后有改善，是支持该假设的用户经验，尚非本轮实测因果证据。模型长思考与长工具参数生成都可能拉长等待。

工具正文默认不必逐字返回。当前请求构造没有启用 streamFunctionCallArguments，而 Google 的工具参数分片需要明确开启。因此“流式请求”并不保证工具参数生成期间持续有正文可见。

**仍然未知**

- 请求提交至出错的真实毫秒数；是否集中于某个固定时长。
- 出错请求是否收到响应头、多少上游字节、是否先返回过思考块/工具相关块。
- TUN 节点空闲策略、Google 服务端执行超时/负载、具体断开方。
- 15 秒与 30 秒哪一种更适合此链路；无法仅凭当前堆栈认定 30 秒过长或 15 秒过频。
- 旧实现空回复的确切原因；旧代码不在本工作区，不能进行归因。
- 协议 PING 只能维持/探测 HTTP/2 连接，不保证重置服务端单请求执行时限或每层代理的应用读取时限。

官方依据：[Node HTTP 生命周期](https://nodejs.org/api/http.html#httprequestoptions-callback)、[Node HTTP/2 PING](https://nodejs.org/api/http2.html#http2sessionpingpayload-callback)。另通过 Context7 查询 /nodejs/node 的 HTTP/2 文档交叉核对。

### B. Gemini 4 思考等级：已定位两处独立遗漏

完整原生链路：

1. public/index.html:2164 提供 Auto / Minimum / Low / Medium / High / Maximum。
2. public/scripts/openai.js:7179 将选择存进 oai_settings.reasoning_effort；设置映射位于 :395。
3. :2545 getReasoningEffort 对 Vertex 直接返回原选项；:2820-2821 将 include_reasoning 和 reasoning_effort 写入请求。
4. src/endpoints/backends/chat-completions.js:526 的 isThinkingConfigModel 仅接受指定 2.5 与 3 系列；Argon 不匹配，因此 :603-621 整段 thinkingConfig 构造不执行。
5. src/prompt-converters.js:1182-1325 的 calculateGoogleBudgetTokens 同样没有 Argon 分支，对其所有等级返回 null。仅修复第 4 步仍不够。
6. 因整段配置被跳过，includeThoughts 也没有按“显示思考”设置传给 Argon；这与模型是否进行内部思考是两件事。

隔离执行当前真实函数确认：Argon 的六个等级 × thoughts 开关，共 12 个组合均未生成 thinkingConfig；前端选项本身能原样通过。在原生代码路径下，“界面 High”不等于 Google 收到 High。

Google 当前文档规定 Argon 使用 LOW / MEDIUM / HIGH，默认 MEDIUM；thinkingBudget 和 MINIMAL 不适用。因此合理推断：未被扩展另行改写的当前原生请求使用服务端默认等级。尚未抓取用户真实生成请求，也未实测模型实际计算量。

建议映射（待批准）：

| 酒馆选项 | Argon thinkingLevel |
| --- | --- |
| Auto | 不显式发送等级，让服务端决定，当前官方默认 MEDIUM |
| Minimum | LOW |
| Low | LOW |
| Medium | MEDIUM |
| High | HIGH |
| Maximum | HIGH |

不得直接套用 Gemini 3 Pro 分支，因为该分支会把 Medium 转为 Low；不得改成按 max_tokens 百分比计算 Argon thinkingBudget。显示思考开关只控制是否请求展示思考摘要，不代表禁用内部思考。思考等级也不是固定 token 数或固定耗时。

官方依据：[Google Cloud Argon 开发指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon?hl=en)、[Gemini 思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。

### C. 工具正文及“空回”边界

本轮必须保留用户现有“正文位于工具调用参数”的工作方式。

1. **纯工具回复合法。** 非流式分支 :771-780 在没有文字但存在 functionCall 时不会判为空回；隔离执行通过。流式文字提取返回空字符串也属正常，public/scripts/openai.js:3185 另交 ToolManager.parseToolCalls 处理。
2. **完整工具返回有现成路径。** public/scripts/tool-calling.js:534-552 接收 Google functionCall 和 thoughtSignature；实测完整调用的 args.body 与签名被保留。
3. **不能随手打开参数分片。** Google 支持 streamFunctionCallArguments 后返回 partialArgs / willContinue，但当前 ToolManager 每遇到一个 functionCall 就新增调用，没有对应的参数重组机制。两个合成分片被解析成两个调用，args 未重建。因此该功能不纳入此次最小保活修复。
4. **保活不得依赖文字非空。** 以实际收到上游响应数据和请求是否仍活跃为依据，覆盖长思考、长工具参数等待，以及收到部分内容后的再次静默。
5. **forwardFetchResponse 的 await 不代表流已结束。** src/util.js:732-779 只调用 pipe 并注册事件，Promise 随即返回。隔离测试证实返回时上游和下游都尚未结束。若 HTTP/2 补丁在这之后的 finally 销毁 session，可能导致截断/空回复。这是当前可证明的集成风险，不是旧补丁错误的鉴定。
6. **错误必须保持为错误。** 流中途断开时不能正常 end 后当作完成；不能把合法工具回复错判成空回后自动补发。请求取消也要覆盖等待期和已开始转发期。
7. **传输 PING 不是 SSE 内容。** 不向回复插入伪文字、伪候选或伪工具调用来保活；不改变工具正文、签名或现有执行语义。

官方依据：[Google Cloud 工具调用与参数流式](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling)、[FunctionCallingConfig](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/Shared.Types/FunctionCallingConfig)。

### D. 邻近兼容性问题：登记，暂不扩大本次修改

以下不是 ECONNRESET 的已证实原因：

- Argon 未纳入 noSamplingModel，仍传 temperature/topP/topK/candidateCount。官方迁移指南建议移除对应不适用参数；参数问题通常应看 HTTP 错误，不能拿来解释当前无状态码的 socket 关闭。
- convertGooglePrompt 的 noPrefillModel 未包含 Argon；合成 assistant 尾消息仍变成 model 尾消息，存在触发 API 校验错误的风险。调整尾消息语义可能影响用户工具预设，需独立处理。
- :577 的普通文本签名注入仅识别 Gemini 2.5/3，Argon 的普通文本历史签名会丢失。但 :556 的已有工具调用签名不受该判断限制，本轮确认能保留，不能笼统说“Argon 工具签名全丢了”。
- 流式文字提取 :3237 / :3246 只取筛选后的第一个 part，可能漏掉同一块的其他文字；本轮只静态登记，没有复现用户因此空回。
- 当前原生 Vertex /v1 没有新长输出 continuation 接续实现；当前用户 max_tokens=65535，未要求扩展超长输出，也不因此修改 API 版本或加入接续请求。
- 插件能通过 CHAT_COMPLETION_SETTINGS_READY 修改请求（public/scripts/openai.js:3146）。未审计全部第三方插件，也未证明上述原生路径等于用户浏览器最终线路。

### E. 本轮验证及限制

| 验证 | 方法与结果 | 证明范围 |
| --- | --- | --- |
| Git 基线与官方分支 | status、log、ls-remote、staging 的定点 git grep | 当前源代码基线，非所有插件状态 |
| 请求构造 | 从源码提取真实函数进入 Node VM，替换认证/网络，48 组：4 模型 × 6 等级 × 2 thoughts；每组单次模拟提交 | Argon 配置缺失，旧模型对照正常；非真实浏览器/Google 服务 |
| 前端等级 | 真实 getReasoningEffort，4 模型 × 6 等级，共 24 次断言 | 原生 Vertex 映射原样传递 |
| 工具非流式返回 | 合成完整 functionCall，真实端点函数 | 没有普通文字也能接受，不判空 |
| 工具流式解析 | 真实 parseToolCalls 与私有合并方法，工具支持判断隔离为 true | 完整 args/签名保留；非插件展示体验 |
| 参数分片负例 | 两个同一调用的合成 partialArgs | 被当作两个调用，不应直接启用 |
| 转发生命周期 | 真实 forwardFetchResponse + PassThrough | await 返回早于流结束；后续数据仍可到达 |
| 历史边界 | 真实 convertGooglePrompt + 合成消息 | Argon 文本签名遗漏/尾 model；已有工具签名保留 |
| ECONNRESET 局部复现 | 本地 HTTP 服务在响应前关闭 socket；已安装 node-fetch 调用一次 | 得到 system / ECONNRESET / socket hang up，验证错误类别，未复现真实 TUN 故障 |
| Google 非生成探测 | 只建立 HTTP/2 session，默认正常证书校验，发 1 个协议 PING；不发送 HTTP 生成请求/凭据 | ALPN=h2，authorized=true，PING ACK 约 175ms，总约 745ms；只证明此刻可连接/确认 |
| 代码范围核对 | 生产目录、依赖清单相对原始 SHA 的 git diff 无输出 | 本轮未修改业务代码 |

测试脚本不 import 整个应用、不会启动酒馆，也不读取聊天/密钥。基线脚本的断言刻意验证当前缺陷，未来修复后其中部分断言应失败；它是调查复现，不应误作修复后回归测试。

未完成：长时间生成实测、真实 TUN 断开定位、15/30 秒 A/B、真实服务端思考等级/耗时比较、浏览器工具正文显示与预设插件完整端到端、Windows 真实酒馆进程环境、完整 Jest 套件。本轮真实模型生成次数为 0。

### F. 待确认的最小实施方案

**阶段 1：只修复 Argon 思考配置，独立提交。**

- 修改 src/prompt-converters.js 的 Argon 专用等级映射，以及 src/endpoints/backends/chat-completions.js 的已知模型支持判断。
- 明确匹配本次模型 ID；不泛化到所有未知 Gemini 4/未来模型。
- 使用上表映射，保留 includeThoughts 语义；不发送 Argon thinkingBudget，不动 Gemini 2.5/3 的现有映射。
- 新增真正面向修复的请求体与转换回归：六等级、thoughts 开关、Vertex/AI Studio 共享构造边界、旧模型对照、完整工具调用保持。
- 不更改用户预设、已保存的 High 或 max_tokens。实际 High 生效后耗时可能变化，必须与网络改动分开观察。

**阶段 2：原生 Vertex HTTP/2 保活与生命周期，另一个提交。**

- 建议新建职责单一的 src/vertex-http2.js，由当前 Vertex 原生 Google 分支小范围调用。提供可关闭的配置开关，默认策略在确认后落地；回退开关只影响后续手动请求。
- 仅适配原生 Vertex；AI Studio、OpenRouter、自定义反向代理继续走既有路径。不得替换全局 fetch 或全局 Agent。
- 提议静默间隔 30000ms。请求仍活跃且一段时间没有上游响应数据时发标准 PING；持续有上游数据时不额外发。不能看到第一个字符/HTTP 响应头就永久停止保活。
- 同时最多一个待确认 PING，记录 ACK / 失败；不因一次迟到的 ACK 自动重发生成。PING 频率不是整体生成超时。
- TLS 主机名与证书校验保持启用。URL 的 pathname 与 search 必须完整保留，尤其 alt=sse。
- TUN 沿现有操作系统网络路径。若未来启用显式 HTTP/HTTPS 代理，要支持 CONNECT、认证和 bypass 语义；不能因 http2.connect 不使用 globalAgent 而静默直连。其他未支持代理类型必须在发请求前明确选择旧路径或报告不支持，不能绕过。
- 每个生成请求独立持有 session/stream；清理以真实上游流结束、异常、用户取消、浏览器断连为界。取消覆盖握手前、等待响应头、已输出/工具等待期；所有路径清理定时器、监听与 socket。
- 明确传递非 2xx 状态、响应前断开、流中断、GOAWAY、RST_STREAM。流中断不能伪装正常完成，合法纯工具结果不能判空。
- 成功路径透传原始 SSE 字节，保留背压和 functionCall/签名；不新增工具分片协议，不插入伪回复。
- 生成提交至多一次；任何提交后的网络异常均不重试、不换协议补发。协议选择必须发生在生成请求发送前。
- 诊断仅记录请求关联 ID、模型、有效思考等级、传输模式、代理类型、连接/响应头/首数据/末数据耗时、字节数、PING/ACK、终止原因。不得打印密钥或正文。

**阶段 2 的验收矩阵（未来执行，本轮未跑）：**

1. 响应头前静默超过两次 PING 周期后成功。
2. 首块后再次长静默，再返回完整工具正文。
3. 只有 functionCall、没有 text，也正确完成且签名保留。
4. 正常文字/思考/工具混合，拆分 SSE 边界、长工具参数、大数据背压。
5. 400/401/403/429/500 等 HTTP 错误不变成空回复；沿用必要的前端鉴权状态处理。
6. 响应头前 socket 断开、流中断、RST_STREAM、GOAWAY、PING 不确认。
7. 各阶段取消/浏览器关闭；无额外生成提交，无悬挂 timer/session/监听。
8. HTTPS 证书错误必须失败；显式 HTTP/HTTPS CONNECT、代理鉴权失败、bypass 路径。
9. 普通 HTTPS 与 HTTP/2 选择边界正确；反向代理/其他提供商没有行为回归。
10. 同时多个请求相互独立；多轮结束后连接/定时器数量回到基线。

先用本地可控服务与测试证书完成故障注入，避免对真实 API 连续付费试错。通过后，优先利用用户下一次正常长工具正文聊天的脱敏诊断验证 TUN 实际链路；如果要由助手另行发起真实生成，先明确次数、输出限制和授权。不会为了“验证”自动重发旧请求。

**暂不实施**：阶段 D 的兼容性扩展、工具分片重组、自动续写/自动重试、全局超时改造、Node 升降级、网络代理/系统设置变更。

### G. 本轮实际修改和 Git 记录

本轮实际仅新增：

- VERTEX_GEMINI_INVESTIGATION_LOG.md：本统一日志，含证据、用户补充、测试、方案与可复现代码。
- AGENTS.md：要求后续回合继续维护本日志、按问题提交、遵守当前待确认边界。

创建本地分支 codex/vertex-gemini-investigation。本条所在文档提交可用以下命令定位：

~~~powershell
git log --oneline -- VERTEX_GEMINI_INVESTIGATION_LOG.md AGENTS.md
git diff 06bde939fb1e9c4c8d8641d810f0a916b5bce127 -- src public tests package.json package-lock.json default
~~~

第二条命令在本轮交付时无输出。不推送 origin，不把 data/config.yaml 加入 Git。Git 引用写入起初被沙箱文件权限阻止，随后通过工具权限提升完成本地分支创建；这不是自动审批拒绝，也没有要求用户重复批准已授权的 Git 管理。

下一步等待用户批准阶段 1 + 阶段 2（分开实现、测试、提交）。当前尚未开始业务修复。

## 002A · 2026-10-19（Asia/Shanghai）· 授权实施与思考等级修复

- 用户要求：结合新的“测试消息成功、实际指令失败”日志，完成 ECONNRESET 与思考等级优化，谨慎、干净、简洁。本轮明确授权此前两阶段业务修复，不再等待重复确认。
- 新附件只提取技术元数据，没有把真实提示词、工具正文、凭据或项目标识复制进仓库。成功请求（附件 48-107 行）为非流式，STOP，输入 32 token、输出 13 token、总计 45，模型 Argon；失败请求（110-1085 行）为带 systemInstruction 和 function_declarations 的流式请求，tool choice=AUTO，在 fetch 处 ECONNRESET。两者 generationConfig 均无 thinkingConfig。日志证实运行服务也是 Node v26.1.0。
- 结论：短请求成功支持当时鉴权/模型可访问，不能外推长流式稳定；失败没有可用的精确耗时/收包信息。模型参数遗漏由真实日志再次证实，网络断开方仍未确定。
- 工作区起点 dc2d6b1f5；已有用户未跟踪目录 _claude/，保持原样且不暂存。只按明确文件清单提交。
- 实际修改：src/prompt-converters.js 增加精确 gemini-4-argon 映射；chat-completions.js 将该 ID 纳入 thinkingConfig；Auto/未知等级省略等级，min/low=LOW、medium=MEDIUM、high/max=HIGH。保留 includeThoughts 与其他模型行为，不修改已保存预设。
- 测试：扩展 tests/prompt-converters.test.js；新增 tests/google-request.test.js，从生产源码提取整个 Google handler，以假认证/网络隔离执行，核对 Vertex 与 AI Studio 请求体、旧模型、未知模型、纯工具正文和签名。
- 验证命令：在 tests/ 运行 node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json --runInBand --verbose=false prompt-converters.test.js google-request.test.js。2 套件、184 测试全部通过，其中请求体矩阵实际覆盖两种提供商、六等级和两种 thoughts 设置。不是付费 API 或真实浏览器验证。
- 测试环境：用现有 tests/package-lock.json 执行 npm ci --ignore-scripts，未修改依赖清单/锁文件。Jest 起初被沙箱 realpath 权限阻止（换临时目录仍失败），通过工具权限提升后通过；该失败属于运行环境，不属于业务断言失败。
- AGENTS.md 更新当前已授权范围，后续继续按问题记录和提交。
- 本阶段以独立思考修复提交保存。下一阶段实现 Vertex 专用 HTTP/2 传输、取消/清理与脱敏诊断；不自动重试、不启用工具参数分片、不还原旧仓库复杂补丁。

## 附录：初始调查可复现诊断

在工作区根目录，将对应 JavaScript 块通过 PowerShell 单引号 here-string 管道交给 node --input-type=module。所有凭据、项目 ID 和正文均为合成占位符。基线脚本会开启一次短暂 localhost 服务，其余模拟请求不会联网。

### 基线请求、转换、工具非流式与转发生命周期

```javascript
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import http from 'node:http';
import fetch from 'node-fetch';
import * as constants from './src/constants.js';

const backend = fs.readFileSync('src/endpoints/backends/chat-completions.js','utf8');
const converter = fs.readFileSync('src/prompt-converters.js','utf8');
const frontend = fs.readFileSync('public/scripts/openai.js','utf8');
const utilSource = fs.readFileSync('src/util.js','utf8');
function extract(source, name) {
  const match = new RegExp('^(?:export )?(?:async )?function '+name+'\\([^]*?^}', 'm').exec(source);
  assert.ok(match, name);
  return match[0].replace(/^export /,'');
}
const sources = Object.fromEntries(Object.entries(constants.CHAT_COMPLETION_SOURCES));
const efforts = Object.fromEntries(['auto','min','low','medium','high','max'].map(x=>[x,x]));
const context = vm.createContext({
  URL, AbortController, Readable,
  CHAT_COMPLETION_SOURCES:sources, chat_completion_sources:sources, REASONING_EFFORT:efforts, reasoning_effort_types:efforts,
  API_VERTEX_AI:'https://aiplatform.googleapis.com', API_MAKERSUITE:'https://generativelanguage.googleapis.com',
  GEMINI_SAFETY:[],VERTEX_SAFETY:[], GEMINI_MEDIA_RESOLUTION:{}, enableThoughtSignatures:true,
  SECRET_KEYS:{VERTEXAI_SERVICE_ACCOUNT:'service'},
  getVertexAIAuth:async()=>({authType:'full',authHeader:'Bearer SYNTHETIC'}),
  readSecret:()=>JSON.stringify({project_id:'synthetic-project'}),
  getProjectIdFromServiceAccount:x=>x.project_id,
  getConfigValue:(_,fallback)=>fallback,
  getPromptNames:()=>({charName:'',userName:'',groupNames:[],startsWithGroupName:()=>false}),
  console:{debug(){},info(){},warn(){},error(...args){throw new Error('Unexpected diagnostic error: '+args.map(x=>String(x)).join(' '));}},
  tryParse:s=>{try{return JSON.parse(s);}catch{return undefined;}},
  util:{inspect:()=>'<synthetic>'},
  oai_settings:{show_thoughts:true,chat_completion_source:'vertexai'},
});
for (const [src,name] of [[converter,'calculateGoogleBudgetTokens'],[converter,'convertGooglePrompt'],[backend,'sendMakerSuiteRequest'],[frontend,'getReasoningEffort'],[frontend,'getStreamingReply'],[utilSource,'forwardFetchResponse']]) vm.runInContext(extract(src,name),context);

const captured=[];
let replyFixture={candidates:[{content:{parts:[{text:'synthetic answer'}]}}]};
context.fetch=async(url,opts)=>{captured.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>replyFixture};};
function response(){return {headersSent:false,statusCode:200,status(n){this.statusCode=n;return this;},send(value){this.value=value;return this;}};}
async function call(model,effort,thoughts=true,extra={}){
  const req={body:{chat_completion_source:'vertexai',model,stream:false,max_tokens:65535,reasoning_effort:effort,include_reasoning:thoughts,vertexai_region:'global',messages:[{role:'user',content:'synthetic prompt'}],temperature:1,top_p:.9,top_k:40,...extra},socket:new EventEmitter(),user:{directories:{}}};
  const res=response();await context.sendMakerSuiteRequest(req,res);assert.equal(res.statusCode,200);assert.ok(!res.value?.error);return captured.at(-1).body;
}
const matrix=[];
for (const model of ['gemini-4-argon','gemini-3.7-flash','gemini-3.0-pro','gemini-2.5-pro']) {
  for(const effort of Object.keys(efforts)){
    assert.equal(context.getReasoningEffort({chat_completion_source:'vertexai',reasoning_effort:effort},model),effort);
    for(const thoughts of [false,true]){
      const count=captured.length;
      const body=await call(model,effort,thoughts);
      assert.equal(captured.length,count+1);
      if(model==='gemini-4-argon')assert.equal(body.generationConfig.thinkingConfig,undefined);
      else assert.equal(body.generationConfig.thinkingConfig.includeThoughts,thoughts);
      if(thoughts)matrix.push({model,effort,converter:context.calculateGoogleBudgetTokens(65535,effort,model),config:body.generationConfig.thinkingConfig??null});
    }
  }
}
console.log('PAYLOAD_CASES',captured.length,'FRONTEND_EFFORT_CASES',24);
console.log(JSON.stringify(matrix));

replyFixture={candidates:[{content:{parts:[{functionCall:{name:'emit_story',args:{body:'synthetic tool body'}},thoughtSignature:'synthetic-signature'}]},finishReason:'STOP'}]};
const toolBody=await call('gemini-4-argon','high',true,{tools:[{type:'function',function:{name:'emit_story',parameters:{type:'object',properties:{body:{type:'string'}}}}}],tool_choice:'required'});
assert.equal(toolBody.toolConfig.functionCallingConfig.mode,'ANY');
assert.equal(toolBody.toolConfig.functionCallingConfig.streamFunctionCallArguments,undefined);
console.log('TOOL_ONLY_NONSTREAM_ACCEPTED',true,'ARGUMENT_STREAMING_ENABLED',false);
const state={reasoning:'',images:[],signature:''};
assert.equal(context.getStreamingReply(replyFixture,state,{}),'');
console.log('TOOL_ONLY_VISIBLE_TEXT','empty as expected; ToolManager processing is separate');

const incoming=new PassThrough(),outgoing=new PassThrough();outgoing.socket=new EventEmitter();
const chunks=[];outgoing.on('data',chunk=>chunks.push(chunk.toString()));
await context.forwardFetchResponse({ok:true,status:200,statusText:'OK',body:incoming},outgoing);
assert.equal(incoming.readableEnded,false);assert.equal(outgoing.writableEnded,false);
console.log('FORWARD_PROMISE_RETURNED_BEFORE_STREAM_END',true);
incoming.end('data: synthetic\n\n');
await new Promise(resolve=>outgoing.once('finish',resolve));
assert.equal(chunks.join(''),'data: synthetic\n\n');

const names={charName:'',userName:'',startsWithGroupName:()=>false};
const signedMessages=[{role:'assistant',content:'synthetic history',signature:'synthetic-signature'},{role:'user',content:'continue'}];
for(const model of ['gemini-4-argon','gemini-3.7-flash']){
  const signed=context.convertGooglePrompt(structuredClone(signedMessages),model,false,names);
  const trailing=context.convertGooglePrompt([{role:'user',content:'hello'},{role:'assistant',content:'prefill'}],model,false,names);
  console.log('PROMPT_EDGE',model,JSON.stringify({textSignature:signed.contents[0].parts[0].thoughtSignature??null,trailingRole:trailing.contents.at(-1).role}));
}
const signedTool=context.convertGooglePrompt([{role:'assistant',content:'',tool_calls:[{id:'synthetic',signature:'synthetic-signature',function:{name:'emit_story',arguments:'{"body":"synthetic"}'}}]}],'gemini-4-argon',false,names);
assert.equal(signedTool.contents[0].parts[0].thoughtSignature,'synthetic-signature');
console.log('EXISTING_TOOL_SIGNATURE_PRESERVED',true);

let resetRequests=0;
const server=http.createServer(req=>{resetRequests++;req.socket.destroy();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{await fetch('http://127.0.0.1:'+server.address().port+'/',{method:'POST',body:'synthetic',agent:new http.Agent({keepAlive:false})});assert.fail('expected reset');}
catch(e){assert.equal(e.code,'ECONNRESET');assert.match(e.message,/socket hang up/);console.log('LOCAL_RESET',JSON.stringify({type:e.type,code:e.code,message:e.message,requests:resetRequests}));}
finally{await new Promise(resolve=>server.close(resolve));}
console.log('BASELINE_DIAGNOSTICS_COMPLETE; no Google generation or production modifications');
```

本轮执行退出码 0，原始摘要：

```text
PAYLOAD_CASES 48 FRONTEND_EFFORT_CASES 24
[{"model":"gemini-4-argon","effort":"auto","converter":null,"config":null},{"model":"gemini-4-argon","effort":"min","converter":null,"config":null},{"model":"gemini-4-argon","effort":"low","converter":null,"config":null},{"model":"gemini-4-argon","effort":"medium","converter":null,"config":null},{"model":"gemini-4-argon","effort":"high","converter":null,"config":null},{"model":"gemini-4-argon","effort":"max","converter":null,"config":null},{"model":"gemini-3.7-flash","effort":"auto","converter":null,"config":{"includeThoughts":true}},{"model":"gemini-3.7-flash","effort":"min","converter":"low","config":{"includeThoughts":true,"thinkingLevel":"low"}},{"model":"gemini-3.7-flash","effort":"low","converter":"low","config":{"includeThoughts":true,"thinkingLevel":"low"}},{"model":"gemini-3.7-flash","effort":"medium","converter":"medium","config":{"includeThoughts":true,"thinkingLevel":"medium"}},{"model":"gemini-3.7-flash","effort":"high","converter":"high","config":{"includeThoughts":true,"thinkingLevel":"high"}},{"model":"gemini-3.7-flash","effort":"max","converter":"high","config":{"includeThoughts":true,"thinkingLevel":"high"}},{"model":"gemini-3.0-pro","effort":"auto","converter":null,"config":{"includeThoughts":true}},{"model":"gemini-3.0-pro","effort":"min","converter":"low","config":{"includeThoughts":true,"thinkingLevel":"low"}},{"model":"gemini-3.0-pro","effort":"low","converter":"low","config":{"includeThoughts":true,"thinkingLevel":"low"}},{"model":"gemini-3.0-pro","effort":"medium","converter":"low","config":{"includeThoughts":true,"thinkingLevel":"low"}},{"model":"gemini-3.0-pro","effort":"high","converter":"high","config":{"includeThoughts":true,"thinkingLevel":"high"}},{"model":"gemini-3.0-pro","effort":"max","converter":"high","config":{"includeThoughts":true,"thinkingLevel":"high"}},{"model":"gemini-2.5-pro","effort":"auto","converter":-1,"config":{"includeThoughts":true,"thinkingBudget":-1}},{"model":"gemini-2.5-pro","effort":"min","converter":128,"config":{"includeThoughts":true,"thinkingBudget":128}},{"model":"gemini-2.5-pro","effort":"low","converter":6553,"config":{"includeThoughts":true,"thinkingBudget":6553}},{"model":"gemini-2.5-pro","effort":"medium","converter":16383,"config":{"includeThoughts":true,"thinkingBudget":16383}},{"model":"gemini-2.5-pro","effort":"high","converter":32767,"config":{"includeThoughts":true,"thinkingBudget":32767}},{"model":"gemini-2.5-pro","effort":"max","converter":32768,"config":{"includeThoughts":true,"thinkingBudget":32768}}]
TOOL_ONLY_NONSTREAM_ACCEPTED true ARGUMENT_STREAMING_ENABLED false
TOOL_ONLY_VISIBLE_TEXT empty as expected; ToolManager processing is separate
FORWARD_PROMISE_RETURNED_BEFORE_STREAM_END true
PROMPT_EDGE gemini-4-argon {"textSignature":null,"trailingRole":"model"}
PROMPT_EDGE gemini-3.7-flash {"textSignature":"synthetic-signature","trailingRole":"user"}
EXISTING_TOOL_SIGNATURE_PRESERVED true
LOCAL_RESET {"type":"system","code":"ECONNRESET","message":"request to http://127.0.0.1:1066/ failed, reason: socket hang up","requests":1}
BASELINE_DIAGNOSTICS_COMPLETE; no Google generation or production modifications
```

### 工具解析及参数分片负例

```javascript
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync('public/scripts/tool-calling.js','utf8');
function method(name){const m=new RegExp('^    static '+name.replace('#','\\#')+'\\([^]*?^    }','m').exec(source);assert.ok(m,name);return m[0];}
const code="class ToolManager { static #INPUT_DELTA_KEY = 'synthetic_delta'; static isToolCallingSupported(){ return true; }\n"+method('parseToolCalls')+'\n'+method('#applyToolCallDelta')+"\n};globalThis.toolManager=ToolManager;";
const context=vm.createContext({console});vm.runInContext(code,context);
const calls=[];
context.toolManager.parseToolCalls(calls,{candidates:[{content:{parts:[{functionCall:{name:'emit_story',args:{body:'synthetic story'}},thoughtSignature:'synthetic-signature'}]}}]});
assert.equal(calls[0].length,1);assert.equal(calls[0][0].args.body,'synthetic story');assert.equal(calls[0][0].thoughtSignature,'synthetic-signature');
console.log('NATIVE_GOOGLE_TOOL_PARSER_COMPLETE_CALL: body and signature preserved');
const partials=[];
for(const chunk of [{id:'same-call',name:'emit_story',partialArgs:[{jsonPath:'$.body',stringValue:'hello'}],willContinue:true},{id:'same-call',name:'emit_story',partialArgs:[{jsonPath:'$.body',stringValue:' world'}],willContinue:false}])context.toolManager.parseToolCalls(partials,{candidates:[{content:{parts:[{functionCall:chunk}]}}]});
assert.equal(partials[0].length,2);
assert.equal(partials[0][0].args,undefined);
console.log('SYNTHETIC_PARTIAL_ARGS: two chunks became '+partials[0].length+' separate calls; no reconstructed args. Do not enable argument streaming without separate parser work.');
```

本轮执行退出码 0：

```text
NATIVE_GOOGLE_TOOL_PARSER_COMPLETE_CALL: body and signature preserved
SYNTHETIC_PARTIAL_ARGS: two chunks became 2 separate calls; no reconstructed args. Do not enable argument streaming without separate parser work.
```

### 无生成的 Google HTTP/2 探测

此块会连接 Google 并发送一个协议 PING，不提交模型请求。不用于证明长期稳定性。

```javascript
import http2 from 'node:http2';
const started=Date.now();let finished=false;
const session=http2.connect('https://aiplatform.googleapis.com',{rejectUnauthorized:true,ALPNProtocols:['h2']});
const timer=setTimeout(()=>finish({result:'timeout'}),12000);
function finish(value){if(finished)return;finished=true;clearTimeout(timer);console.log(JSON.stringify({...value,elapsedMs:Date.now()-started,generationRequests:0}));session.destroy();}
session.on('error',e=>finish({result:'error',code:e.code,message:e.message}));
session.on('connect',()=>{console.log(JSON.stringify({stage:'tls_connected',alpn:session.alpnProtocol,authorized:session.socket.authorized}));session.ping((err,duration)=>finish(err?{result:'ping_error',code:err.code,message:err.message}:{result:'ping_ack',durationMs:duration}));});
session.on('goaway',(code)=>finish({result:'goaway',code}));
```

本轮结果：ALPN=h2，TLS authorized=true，PING ACK=175.2158ms，总耗时745ms，generationRequests=0。
