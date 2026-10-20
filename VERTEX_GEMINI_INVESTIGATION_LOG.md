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

## 002B · 2026-10-19（Asia/Shanghai）· 原生 Vertex 保活、生命周期与最终验证

状态：本轮授权的思考等级与连接保活优化已实现并完成本地验证，分开提交；没有重启用户服务，也没有调用真实模型生成。002A 的独立思考修复提交为 `6defa99ca`。001 中的“待确认”是历史状态，以本轮授权和实施记录为准。

### 实施范围与取舍

- 新附件证实短非流式成功与长工具流式失败并存，且两种请求都缺失 thinkingConfig。因此分别修复确定的参数遗漏和长期静默时的传输薄弱点，不把短请求成功解释为长请求网络正常，也不宣称已经定位具体断开设备。
- 新增单一传输模块 `src/vertex-http2.js`，只接入原生 Vertex。每次生成独立持有一个 HTTP/2 session 和一个请求，不设置生成正文的固定读取超时；仅 CONNECT/TLS/HTTP/2 建连阶段设置 30 秒超时。
- 默认上游静默 30000ms 后发送标准 HTTP/2 PING，收到数据则重新计算静默时间；首块之后再次静默也覆盖，持续数据流不额外 PING。同时最多一个待 ACK 的 PING，错误仅记录，不作为重交生成的依据。PING 不写入 SSE 正文。
- 保留 TLS 主机名和证书验证、URL query（包括 alt=sse）、原始响应字节及背压。工具调用参数、thoughtSignature、LF/CRLF 均原样透传；未引入行尾重写、工具参数分片重组或“空回复补发”。
- 复用现有 ProxyAgent 的代理/bypass 决策；HTTP/HTTPS 显式代理用 CONNECT，代理认证只发给代理。SOCKS/PAC、自定义 Agent/连接策略、私网过滤器及不适用端点在提交生成前选择原 node-fetch，不静默绕过。关闭开关也选择原路径并记录提示。已发送后的 ALPN、TLS、代理、GOAWAY、RST 或流错误不会切换协议补发。
- 取消监听绑定当前浏览器响应，覆盖建连、等待响应头和已开始响应；保留其他 socket 监听。新增转发函数等待真实流结束，再做清理，避免旧 `forwardFetchResponse()` 返回早于流完成而导致的集成截断风险。
- 正常结束关闭 session；异常/取消销毁请求、连接和响应流，移除本模块定时器及 abort 监听。非正常上游中断传递为下游连接错误，不伪装成正常部分完成。成功 GOAWAY 允许已接受的请求完成，拒绝当前请求或错误 GOAWAY 则失败。
- 不调整当前 HIGH、65535、预设、工具执行方式、代理节点、Node 版本或 API 版本。思考修复后 HIGH 会实际生效，耗时可能增加；等级不是固定 token 数或完成时限，PING 也不能突破 Google 的服务端执行时限。

### 实际修改文件及原因

| 文件 | 修改与原因 |
| --- | --- |
| src/vertex-http2.js | 新增专用 HTTP/2 单次 POST、空闲 PING、代理选择/CONNECT、生命周期和脱敏诊断；新增等待流真正结束的转发函数 |
| src/endpoints/backends/chat-completions.js | 原生 Vertex 接入新模块；按请求绑定取消；等待实际转发结束后清理；保留回退路径；原生请求/响应日志只输出元数据 |
| default/config.yaml | 记录 gemini.vertexHttp2.enabled=true 与 pingIntervalMs=30000 默认项；实际用户 config.yaml 未修改，缺省值由代码提供 |
| tests/vertex-http2.test.js | 本机 TLS HTTP/2、CONNECT、故障注入、保活、背压、并发及清理验证；可选真实 65 秒等待测试 |
| tests/vertex-endpoint.test.js | 本机 HTTP 客户端 → Express → 从源码提取的完整生产 handler → 真实新传输模块 → 本机 TLS 服务；验证集成、取消、断流、请求参数与日志脱敏 |
| tests/fixtures/vertex-http2/cert.pem、key.pem、README.md | 公开的合成 localhost 测试证书与配套密钥，专为回环测试生成，不是用户凭据；测试显式信任此证书，生产校验保持启用 |
| tests/google-request.test.js | 适配生产 handler 新传输接口与响应 close 事件，保留思考等级和纯工具回归覆盖 |
| tests/prompt-converters.test.js | 仅增加说明性的 ESLint 指令，避免 Playwright 规则误识别 Jest test.each；本阶段未再改思考映射实现 |
| VERTEX_GEMINI_INVESTIGATION_LOG.md | 汇总本轮实现、测试、限度、Git 与启用/回退方式 |

仅使用 Node 内置 http2/tls/stream 及现有 proxy-agent/node-fetch，未新增生产依赖。测试使用现有 lock 安装 tests/node_modules，并临时安装仓库 ESLint 所需插件（--no-save --package-lock=false）；根目录与 tests 的 package.json/package-lock.json 均无变更。

### 验证结果与证据等级

| 验证 | 实测结果 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| Argon 请求矩阵 | 002A：2 套件、184 项通过；Vertex/AI Studio 两种构造、六等级、thoughts 开关，以及旧模型、未知模型、纯工具回复 | 修复真实生产请求构造；不是 Google 内部计算量或真实浏览器插件验证 |
| 本机传输与端点测试 | 响应前静默、首块后静默、持续数据、120k Unicode 工具正文、1MB 背压、CRLF 字节保持、签名、HTTP 错误、TLS/ALPN、CONNECT/认证、取消、RST、GOAWAY、PING 未 ACK/失败、六请求并发、回退路径与日志脱敏通过 | 可控服务上的真实 socket/stream 生命周期；不是用户 TUN 故障因果复现 |
| 完整单元套件（启用慢测试） | 22 套件，486 项全部通过，约 71.72 秒 | 包括默认 30 秒间隔下真实 65 秒响应头前等待：单个 POST、两次 PING、两次 ACK、完整返回、session 清理 |
| 最终兼容性/日志调整后的完整常规回归 | 22 套件，485 项通过，1 项慢测试按默认设置跳过，约 7.90 秒 | 最后补充的自定义 TLS/DNS/连接 Agent 回退与诊断请求 ID/模型/等级关联也通过；没有声称最后这次再次执行慢测试 |
| ESLint | 对所有变更 JS 使用仓库实际配置，退出码 0 | 静态检查通过；Playwright 误识别 Jest test.each 仅在对应测试文件加有原因的局部规则说明 |
| 当前网络 Google 非生成探测 | 用新生产模块向 https://aiplatform.googleapis.com/ 发一次无凭据根路径 POST：HTTP 404，1561 bytes，连接约 480ms、响应头约 1219ms、末数据约 1221ms，eof/rstCode=0 | 当前网络可通过新模块完成 Google TLS/HTTP/2 请求；不是模型生成，不验证长 TUN 稳定性、付费鉴权或真实工具展示 |
| Git/范围核对 | diff --check 通过；用户配置、data、public、扩展、依赖清单与锁文件均未纳入更改；只暂存明确清单 | 保留用户原有未跟踪 _claude/；不将其正文或凭据加入日志/提交 |

本轮助手发起真实模型生成次数：**0**。未执行 Playwright 浏览器套件，未启动/重启酒馆，未声称真实预设长正文已经端到端通过。

主要复现命令（PowerShell，测试在 tests/ 目录运行）：

~~~powershell
# 常规完整单元测试
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json --runInBand --verbose=false --silent

# 可选：含真实 65 秒等待的完整套件；不会调用 Google
$env:VERTEX_LONG_IDLE_TEST='1'
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json --runInBand --verbose=false
Remove-Item Env:VERTEX_LONG_IDLE_TEST
~~~

仓库根目录静态检查：

~~~powershell
node tests/node_modules/eslint/bin/eslint.js --resolve-plugins-relative-to ./tests src/vertex-http2.js src/prompt-converters.js src/endpoints/backends/chat-completions.js tests/vertex-http2.test.js tests/vertex-endpoint.test.js tests/google-request.test.js tests/prompt-converters.test.js
git diff --check
~~~

### 测试中出现的问题及处理原因

- 初次 ALPN 负例期望特定错误，但本机 Node/TLS 在握手阶段直接报 ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL；调整测试接受正确的握手拒绝，同时断言没有 POST，没有降低校验或自动回退。
- 初次 RST 模拟用服务端 stream.close(code)，Node 26 的实际事件顺序包含正常 END_STREAM，客户端看到 rstCode=0/eof。用原生事件探针确认后改成 stream.destroy(error) 产生真实错误复位，客户端正确拒绝；这是测试注入方法问题，不能据此认定真实上游 RST 被生产模块吞掉。
- 初次端点清理断言要求 close 监听总数为 0，但 Node pipeline 自身保留内部监听；调整为只核对本 handler 安装的 onResponseClose 已移除，并等待上游 session 关闭。未用 removeAllListeners 破坏其他监听。
- Jest/ESLint 在沙箱内受到 realpath 文件访问限制，通过工具权限提升运行本地测试；这不是业务断言失败或自动审批拒绝。没有为此修改用户系统配置。
- 旧仓库记忆仅用于提醒 CRLF、纯工具正文和中途静默等回归边界；当前实现未恢复旧补丁，也未借旧代码归因当前失败。

### 诊断解释、启用与回退

重启当前工作区的 SillyTavern 后，新代码及默认配置生效。无需修改已保存预设或重新输入密钥。默认有效参数可在原生请求元数据日志中看到：Argon High 为 thinkingLevel: HIGH；Auto 不显式指定等级，显示思考由 includeThoughts 独立控制。

每次新传输完成、失败或取消时输出一条 `[Vertex HTTP/2]` 摘要，包含 id、model、stream、thinkingConfig、maxOutputTokens、route、phase、connectMs、headersMs、firstDataMs、lastDataMs、bytes、pingsSent、pingsAck、elapsedMs、rstCode、outcome，以及有事件时的错误 code/goawayCode/pingError。route 仅是 direct/http:/https:，不打印代理地址、密钥、提示词、工具正文或签名。direct 表示未使用应用显式代理，仍可能经过用户 TUN。

- headersMs=null、bytes=0：未收到响应头；先看 connectMs、code、PING/ACK。
- headersMs 有值且 bytes>0 后失败：已经进入响应；结合末数据时间与总时长判断静默窗口。
- outcome=eof 仅表示传输正常 EOF，**不保证模型已经给出 finishReason 或完整语义结果**。本次未加入 SSE 语义解析器，服务端以正常 END_STREAM 结束但缺少最终结果仍是另一个待实际证据判断的问题。
- outcome=cancelled 对应浏览器/用户取消；错误不会触发重新生成。PING ACK 证明协议连接可应答，不证明模型正在产出，也不保证每一层代理会延长应用超时。

需要暂时关闭新传输时，在用户 config.yaml **已有 gemini 节点中**加入下面子项，再重启；不要重复创建第二个 gemini 节点。这样后续手动请求回到 node-fetch，思考等级修复仍保留。实际文件本轮未替用户改动。

~~~yaml
gemini:
  vertexHttp2:
    enabled: false
    pingIntervalMs: 30000
~~~

### Git 与下一步

- 分支：`codex/vertex-gemini-investigation`；基线 `dc2d6b1f5`；思考修复 `6defa99ca`。
- 本条随第二个独立实现提交 `fix: keep native Vertex generations alive over HTTP2` 保存。可用 `git log --oneline -3` 或按本日志文件查询确切 SHA；不为自引用 SHA 追加噪声提交。
- 本地 Git 采用明确文件清单暂存，提交前执行 staged diff --check；不推送远端。用户原有 `_claude/` 仍未跟踪，未修改、未暂存。
- 后续回滚优先 `git revert <对应实现提交SHA>`。仅需停用保活可先用上述配置开关；思考修复和连接修复可分别定位。
- 下一步是用户重启后的一次正常长工具正文使用，检查新元数据；如果仍失败，用实际 headersMs/lastDataMs/PING/错误分类继续单变量调查。真实 TUN 长等待、浏览器预设最终展示、Google 计算量及 15/30 秒链路对照均尚未验证，不把本地测试描述为全部网络问题已根治。

## 003 · 2026-10-19（Asia/Shanghai）· 成功实机日志复核、预设显示链与 PDF 方案审查

状态：**本轮仅调查，不修改生产代码、配置、预设、世界书或浏览器运行状态。** 用户明确表示多次生成已成功、两次为自己停止，要求结合新日志、旧修改对话、Reborn2.4 和两份世界书进一步审查，并研究等待反馈和原生 PDF 输入；此次暂不实施新功能。文档及本地 Git 记录沿用既有授权。

### 输入、基线与证据边界

- 起点分支 codex/vertex-gemini-investigation，HEAD=957058def；思考修复 6defa99ca。已跟踪文件干净，仅用户原有 `_claude/` 未跟踪。
- 新启动/生成附件共 294 行，7 条 `[Vertex HTTP/2]` 摘要；旧对话附件约 1.07 MB、8888 行。只取技术证据，不把附件正文、项目标识、聊天或世界书内容复制进 Git。附件里的历史命令/提示词视为分析材料，不当作本轮指令执行。
- `_claude/Reborn2.4.json` 与 data/default-user/OpenAI Settings/Reborn2.4.json 完全相同。settings.json 保存的选用预设也是 Reborn2.4；stream_openai=true、function_calling=true、show_thoughts=true、reasoning_effort=high、tool_reasoning_mode=disabled。SPreset 关键配置相同；最初 JSON.stringify 比较提示 RegexBinding 差异，经字段排序后逐项核对，内容和排列均相同，仅属性序列化顺序不同。
- 本轮 Chrome DevTools 连接仅暴露 about:blank，未检查用户正在使用的真实浏览器页，也没有刷新/打开一个新酒馆页面。以下预设运行机制来自本地保存配置、公开加载脚本及隔离执行；不能据此声称已核实当时页面加载的脚本版本、DOM 或实际收包内容。

### A. 实机生成结果：当前稳定性的证据已明显增强

以下时长从请求开始计；“首数据”是上游原始字节到达时间，不等于首文字或首思考摘要。

| 请求顺序 | 首数据（秒） | 总时长（秒） | 接收 KiB | PING / ACK | 结束 |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 5.413 | 454.058 | 104.1 | 13 / 13 | eof，HTTP 200，rstCode=0 |
| 2 | 7.616 | 677.080 | 180.1 | 20 / 20 | eof，HTTP 200，rstCode=0 |
| 3 | 7.000 | 310.599 | 84.8 | 8 / 8 | eof，HTTP 200，rstCode=0 |
| 4 | 未收到 | 4.790 | 0 | 0 / 0 | cancelled / AbortError |
| 5 | 7.514 | 146.349 | 5.1 | 3 / 3 | cancelled / AbortError |
| 6 | 166.585 | 393.197 | 58.6 | 11 / 11 | eof，HTTP 200，rstCode=0 |
| 7 | 5.915 | 557.357 | 153.5 | 17 / 17 | eof，HTTP 200，rstCode=0 |

- 5 次传输正常结束与用户报告的实际生成成功一致；2 次取消与用户手动停止一致。没有新的 ECONNRESET、error outcome 或 GOAWAY 错误记录。7 次总计 72 次 PING、72 次 ACK。最长正常请求约 11 分 17 秒，且有一次等待约 2 分 47 秒才收到首数据后仍成功。
- 两次取消的 rstCode=2 不能单独解释为 Google 拒绝：src/vertex-http2.js:114-119 在本地 abort 时用 destroy(error) 清理流，诊断 outcome=cancelled / code=AbortError 才是本次分类依据。没有为“把数字改好看”改变取消路径。
- 全部摘要均含 includeThoughts=true、thinkingLevel=HIGH，说明修复后的参数确实用于这批实际请求。仍不能凭参数或耗时反推精确内部思考 token 数。
- route=direct 表示应用未使用显式 CONNECT 代理，不表示绕过系统 TUN。
- 这是当前版本在用户实际生成场景连续成功的证据，强于上一轮仅本机模拟；不是对所有网络条件的保证，也不是 15/30/45 秒策略的受控 A/B。传输 eof 本身不验证 finishReason；本轮成功结论同时引用用户的结果确认。

### B. 对照旧对话：不重新引入已经删掉的复杂实现

- 旧对话记录过 15 秒无条件 PING，后改成 45 秒空闲 PING 且连续静默最多 2 次；另有特定线路下 TLS 1.3 解密错误、TLS 1.2 规避、工具片段组装、SSE 行尾兼容和语义结束检测等多次变动。这些属于旧仓库历史，当前没有相同代码，不能逐项当作当前故障。
- 当前 30 秒空闲策略的区别不只是频率：等待期间可继续保活到请求结束，限制的是“同时一个未确认 PING”，不是“整个长等待只发两次”。旧策略停止 PING 后可能留下很长无保活窗口；这能解释两种设计的覆盖差异，不能单凭跨版本日志断言全部改善都由这一个变化造成。
- 旧对话对 too_many_pings 曾明确区分协议可能性与现场证明；当前这批数据没有该信号。没有理由因为总计 72 次 PING 就认定过密，也不据此重新强制 TLS 1.2 或限制总 PING 数。
- 旧 CRLF 空白复现对应 linux_1.3 自带 SSE 解析器；本次 Reborn2.4/SPreset 在酒馆完成 SSE 解析后接管生成器。两条前端路径不同，不能直接恢复旧全局行尾改写或把旧空白结论套到本次成功结果。
- 复核当前 src/vertex-http2.js:94-102、221、304：Transform 每块原样 callback，pipeline 流式转发并等待结束，没有收集完整正文再一次返回。对“当前 HTTP/2 改动把全部内容攒到最后”的解释，未发现代码依据。

### C. 为什么工具正文末尾才显示；为什么原生思考仍需补证据

**确定的工具显示路径**

- 预设绑定一个 game_content 工具，必填 content:string，启用 OutputPreprocessing.enabled=true、consumeToolCalls=true，toolCallFormatter.enabled=false；ForcedPostProcessing=merge_tools。
- 预设通过 tavern_helper 加载公开脚本 `https://jnai2d9kgnbs6xzx5c.com/regex_bind/inject.js`。本轮下载仅作源码分析，没有在浏览器安装或执行整份脚本。快照 228965 bytes / 5693 行，SHA256=c30bca1e9bcbadf1837e61b71884244d066b3bfac763ef82f913e1046a2ad427；这个 URL 未固定版本，浏览器缓存/未来更新可能不同。
- 当前公开脚本 wrapSPresetOutputGenerator:1359-1449 每块保留 `...sourcePacket`，但 consumeToolCalls 时将下游 toolCalls 置为空，并保留累积工具调用引用；直到原生成器结束后的 :1408-1417 才将参数转换成正文，再 yield 最后一块。因此即便工具结果稍早到达，预设仍在本轮结束后交付其正文。这是源码明确的接管语义。
- 原生请求没有开启 streamFunctionCallArguments；默认完整工具参数还可能在模型生成完该参数后才返回。因此这里存在“上游完整参数等待”和“前端 EOF 后消费”两层延迟，不能通过缩短 PING 改成逐字显示。
- 工具包裹改变的是输出协议和消费方式，不提供无限输出或绝不截断的保证。当前仍受输出限额、模型/网络结束和前端解析约束；保留用户现有工作流，不把它擅自改成普通正文输出。

**原生思考是独立通道**

- public/scripts/openai.js:3237 从 thought part 写入 state.reasoning；public/script.js:3892 每包交给 ReasoningHandler。SPreset 包装器保留 state，未把它放进正文缓冲。
- 本轮用实际公开包装函数、实际预设输出处理函数和合成输入隔离执行：第一包原生思考在上游 EOF 前已传出；第二包工具参数仍不显示正文；上游结束后第三包才交付工具正文。另验证普通文本在 final=false 时能立即通过预设处理器，Unicode/标签的少量 hold 不是整篇缓冲。
- Google 提供的原生 thought summaries，与正文中的 think_nya/report_nya 标签不是同一种数据。预设针对标签的隐藏/折叠正则不能被直接解释为关闭原生 thought 流。tool_reasoning_mode=disabled 在当前核心里用于工具历史思考回传，不等同于 show_thoughts=false。
- 保存设置中 reasoning.auto_expand=false；这能使已有思考栏保持折叠，但不能证明思考没收到，也不能解释上游不返回思考。show_hidden=false 也不等于隐藏全部已有摘要。
- 新日志只有 firstDataMs/bytes，没有 thoughtParts、firstThoughtMs、toolParts 或 usage。第一批字节可能只是元数据/签名等；**当前无法确定这几次是否提前收到了非空原生思考摘要**。不能声称“原生思考一定被 SPreset 吞掉”，也不能保证打开 includeThoughts 就必有及时摘要。[Google 思考文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)说明摘要可能缺失，签名应独立保留。

**已复现但尚未归因到这批请求的核心边界缺陷**

public/scripts/openai.js:3237 的 `filter(...).map(...)[0]` 只取同一候选事件的首个 thought part。隔离执行生产 getStreamingReply 确认：

- 单一 thought text=A：正常得到 A。
- 同一事件 thought text=A、thought text=B：只得到 A，B 丢失。
- 同一事件首 thought part 只有签名、第二个有 text=B：得到空思考。

正文 :3246 同样只取第一个非 thought part，也有多 part 边界。这是既有前端代码问题，本轮没有改；当前没有真实事件形状证据证明用户这几次触发了它。修复可作为独立小提交，不应与 HTTP/2 或工具分片重写混在一起。

### D. 世界书和预设体积的判断

| 文件 | 保存条目与开关 | 大小含义 |
| --- | --- | --- |
| Reborn2.4.json | 67 个 prompt 定义；有效角色顺序中启用 37 项，静态 content 合计 5748 字符 | 约 445KB 文件包含大量界面/正则/脚本内容，不等于同量模型输入；不包含动态宏、角色、历史、实际世界书注入后的完整请求 |
| 鞋袜图鉴及气味.json | 45 项均未禁用，其中 1 项 constant；总 content 25046 字符，constant 项 1571 字符 | 其余 44 项仍须满足触发/概率/预算等条件，不能按“45 项全开”断言每轮全部注入 |
| TK要素特化世界书 【主体】【中文】v_1.64.json | 104 项中仅 4 项启用，均 constant；启用 content 合计 794 字符 | 大部分文件内容处于禁用状态，不能用 JSON 文件大小归因等待时间 |

两份世界书启用条目未发现直接操纵 fetch、includeThoughts 或工具流开关的代码特征；本轮未审阅/改写其角色文本。它们可能通过实际注入量影响推理工作，但缺少本次 token 与激活条目记录，不能量化贡献。保留当前世界书配置。

### E. 日志和等待体验的建议顺序（尚未实施）

1. **保留现有传输参数与简洁默认日志。** 当前有效，不建议为“看到动静”重新修改网络、恢复大段原文日志或伪造思考输出。
2. **优先加可选的轻量语义统计。** 用与传输分离的、容量有界的 SSE 观察器记录 firstThoughtMs、thoughtChars/parts、firstToolMs、toolParts、finishReason、usage 以及最大静默时间；只记元数据、绝不重写正文，不以“无 text”判空，不自动重试。观察器解析失败仅记录诊断失败，不能损害正常转发。LF/CRLF/CR、UTF-8 拆块、大工具参数和异常 EOF 都需独立测试。传输 eof 与语义完成分别记录。
3. **等待状态只反映已知事实。** 可选每 60 秒输出一行“等待响应头/已收到数据/距离上次数据多久/PING ACK”，结束仍保留一条汇总；不每次 PING 刷屏，不将连接 ACK 描述为模型一定正在生成。若要网页实时状态，走明确状态通道/已有 UI，不能向 Google SSE 注入伪候选或伪思考。
4. **原生思考显示优先于工具参数分片。** 先区分接口没给摘要、核心提取遗漏、已收到但折叠/主题隐藏。多 thought parts 修复可以小范围进行；工具仍完整交付，避免影响当前稳定性。
5. **暂缓工具参数流式。** 官方 streamFunctionCallArguments 会带来 partialArgs/willContinue，不是加一个 stream=true 就结束；当前 ToolManager.parseToolCalls:534-552 不按同一个调用重组这些碎片，SPreset 又在 EOF 后消费。若将来实现，必须同时定义调用 ID/参数路径重组、完成判定、取消时的部分展示与“不执行半成品工具”、签名、转义、并行调用、错误处理；作为独立项目验收。[Google 工具流式说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling)。

### F. PDF 原生输入：当前链路与可实施方案

**当前已确认的转换链**

1. public/scripts/chats.js:86 注册 application/pdf → extractTextFromPDF。
2. public/scripts/utils.js:2029 用 PDF.js 的 page.getTextContent() 获取文字并拼接；没有把页面图像/图表保留成 PDF 输入。
3. chats.js:198 的聊天附件与 :1691 的资料库上传均将转换结果存为 .txt；:508 appendFileContent 将文字追加进消息。旧已转成文本的附件，不能凭文本还原 PDF，未来启用原生方式时需要原文件。
4. public/scripts/constants.js:103 仅将 image/video/audio 识别为媒体，PDF 不进入媒体路径；openai.js:935-980 也只有三种媒体添加方法。
5. src/prompt-converters.js:432 的 Google 转换器只消费 text/tool/image_url/video_url/audio_url，没有独立文件 part。合成探针验证 `{type:'file',...}` 会被忽略；现有 addDataUrlPart 的编码能力虽可处理 PDF MIME，但不能把 PDF 假装图片作为正式集成方案，前端图片处理/尺寸读取会有不匹配。

因此需要贯通上传、存储、消息历史、提示词后处理和供应商适配，单独跳过文字提取会留下错误格式或丢附件。

**Google 能力和接口边界**

- Vertex/当前 Argon 支持 PDF。官方当前文档列出 Argon PDF 每文件最多 3000 页、API/Cloud Storage 每 PDF 50MB；这是模型/入口约束，不等于所有代理、编码后请求和多个文件总量都可无条件通过。公网 HTTP 文件 URI 在同一文档另有 15MB 限制，不能混用上限。[文档理解](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding)。
- 可用 `contents[].parts[].inlineData={mimeType:'application/pdf',data:<base64>}` 直接随生成请求传完整 PDF；或通过 fileData 引用 Google 可读取的 Cloud Storage URI。localhost、酒馆私有附件 URL、D: 路径不能直接给 Google 读取。[REST inlineData 说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-understanding)。
- Gemini Developer API/AI Studio 的 Files API 与 Vertex 是不同通道。官方 JS SDK 明确 files.upload 不支持 Vertex；不能把 AI Studio 的上传 ID/接口原样套用现有服务账户链路。[Google SDK Files](https://googleapis.github.io/js-genai/release_docs/classes/files.Files.html)。
- 本地上传仍建议经酒馆后端持有凭据；“直接传 PDF”指不先转文本/图片，不意味着把服务账户凭据放入浏览器直连 Google。PDF 带来页面视觉内容，实际模型输入与耗时可能增加，不承诺一定更快。

**建议的第一阶段实现（待未来授权）**

1. 附件明确选择“提取文本”或“原文件发送”；保留现有文本路径兼容资料库/RAG。原生方式保存完整原文件，记录 MIME、原始大小、哈希和用户目录内的文件引用，不将 Base64 永久写入聊天 JSON。
2. 消息历史保存文档引用，按该轮实际选入上下文的消息附带文件；重载、编辑、删除、续聊均保持归属关系。提供商不支持时明确提示选择文字方式，不静默漏传、双重发送或上传后自动切模式重发。
3. Google 请求转换新增文档类型，后端只读取当前用户目录中已验证的附件，在文本后处理完成后仍按原消息关系组装 inlineData。避免多媒体被字符串化，不允许把文档标识解释为任意文件系统路径。
4. 注意当前预设 ChatSquash.squashed_post_script 的 contentToText 会丢掉非文本 part。实际合成调用已复现文件引用丢失；但 ChatSquash.enabled=false、conditional_enabled=true，启用的静态 prompt 没有 merge 标记，**不能说当前会话已触发这个问题**。未来 PDF 设计必须覆盖条件脚本开启时的保留路径，不能只验证裸核心。
5. 第一版以原生 Vertex 小型 PDF inlineData 为重点，不引入新云存储服务。大文件/反复引用的 GCS、AI Studio Files API、其他供应商文件协议分别适配，能力判断按端点+模型，不笼统认为所有 OpenAI-compatible 地址都能收文件。
6. 限制按编码后请求体/文件数/页数/模型上下文分别检查；Base64 约膨胀三分之一，Node 请求 JSON 序列化也占内存。不能把本机 500MB Express body 限额当作 Google 允许的输入限额。PDF token 估算应明确不确定，避免按 Base64 字符串当普通文本计数。

验收先用本机合成 PDF（文字、扫描页、图表、中文文件名、多个附件、受密码保护/损坏/超限）核对实际生成请求、原字节哈希、取消与重载、用户目录隔离、预设后处理及模型切换；随后仅在另行明确授权的少量真实请求上验证 Google 阅读结果。本轮没有上传 PDF 或生成请求。

### G. 启动日志中的 Git 提示

`There is no tracking information for the current branch` 是调查分支未配置 upstream，和 Vertex 断连/生成无关。本地 release 跟踪 origin/release；codex 分支保留独立修复。

当前 UpdateAndStart.bat:15 执行 git pull --rebase --autostash，失败时退出更新流程；Start.bat 仅安装现有生产依赖并启动。因此建议日常使用 Start.bat，更新官方代码时另行评估合并/变基并验证本地修复。本轮未设置 upstream、拉取、变基或修改启动器，也没有为了消掉提示把调查分支无审核地绑定自动更新。

### H. 本轮验证、实际文件变动与下一步

- 复跑已有 vertex-http2.test.js、vertex-endpoint.test.js、google-request.test.js：**3 套件，67 项通过，1 项可选 65 秒慢测试跳过**；约 4.21 秒。没有重新宣称全套 486 项在本轮执行，也没有发起 Google 模型生成。
- 新的只读隔离探针：实际 SPreset 包装器+预设处理器确认思考提前传递/工具 EOF 后显示/普通文本及时通过；生产 getStreamingReply 复现多思考 part 遗漏；生产 convertGooglePrompt 复现专门文件 part 尚不支持；预设条件脚本被调用时复现非文本 part 丢失。全部使用合成输入，不写聊天、不运行整份插件安装代码。
- 公开脚本临时快照原先写入沙箱临时目录，后续工具调用的临时目录不持久，读取失败；改在现有 ignored tests/node_modules 中暂存只读源码，审查结束删除该单一临时文件。未新增依赖或修改锁文件。
- 本轮唯一持久修改是本统一日志，采用独立 docs 提交；不修改生产/测试源码、AGENTS.md、配置、预设、世界书或原有 _claude，不推送远端。
- 决策：**维持当前稳定实现；保留参数 30 秒/HIGH/工具模式。将可选语义诊断及原生思考提取作为最小后续方向，将 PDF 原文件输入独立规划，暂缓工具参数分片。** 等用户未来明确选择实施范围再动生产代码，不在本轮追加确认或自动实施。

## 004 · 2026-10-19（Asia/Shanghai）· 获准实施审查后的优化

用户请求“基于你的思考与分析，完成优化”。沿用 003 的具体建议，批准范围为：修复多 part 思考/正文提取、独立轻量语义诊断和可选等待摘要、原生 Vertex PDF 附件第一阶段。保持现有 30 秒空闲 PING、正常 TLS、取消及工具完整交付；不开启工具参数分片、不修改预设/世界书、不自动重提生成、不推送远端。文档与本地 Git 分项记录。起点 fbe678543，原有未跟踪 `_claude/` 保留，不纳入 Git。

### A. Google 多文本片段修复

- 修改 public/scripts/openai.js 的 getStreamingReply：按顺序连接当前候选所有字符串 thought/text parts，跳过无文本的签名/图片/工具部分，保持 show_thoughts、签名、图片处理与工具原始数据。修复理由为 003 已用生产函数复现的首 part 遗漏；不声称所有实机等待都由此造成。
- 新增 tests/google-streaming-reply.test.js，隔离执行完整生产函数，覆盖两种 Google 来源、多 thought/text、首 part 只有签名、图片、工具、隐藏思考和元数据包。
- 本机执行新测试及 google-request.test.js：2 套件 28 项通过；没有调用 Google、读取实际聊天或改动用户配置。后续尚需诊断与 PDF 分项实现及最终回归；已有实机稳定性证据见 003，不能由此保证模型一定及时给出摘要。
- 本分项采用独立 fix 提交；本轮后续记录继续写入此节。

### B. 与内容转发分离的轻量诊断

- A 已提交 0f6273b64。新增 src/vertex-stream-observer.js：只观察 SSE，不改写、过滤或重放；单事件最多缓存 1 Mi 字符，超限跳过并计数，之后继续观察。按 UTF-8、LF/CRLF/CR、多行 data 处理；只记录候选 0 的思考/正文字符数、tool part 数、首次到达、finishReason 和白名单数值 usage，不保存正文、工具名称/参数、签名。字符数为 JavaScript UTF-16 长度，不是 token 数。
- src/vertex-http2.js 增加 maxIdleMs、SSE 元数据及独立可选进度定时器。现有 PING/ACK、TLS、代理、取消、单次提交和原字节 pipeline 不变；diagnostic 回调异常也不能中断生成。取消/结束清理进度定时器。semanticEnd 只表示观察到结束原因，不能把 MAX_TOKENS 或传输错误描述成成功生成；缺失标记、超限、损坏和不完整事件分别留痕。
- 后端读取 gemini.vertexHttp2.observeSse（默认 true）和 progressIntervalMs（默认 0，开启时至少 60000ms）。default/config.yaml 说明选项；未修改用户 config.yaml。默认仍只输出结束摘要，进度只描述阶段/已收字节/静默/PING ACK，不声称模型正在思考。
- 新增观察器测试，扩展 HTTP/2 原字节转发、进度停止、日志回调异常测试。执行 4 套件：75 项通过，1 项既有可选 65 秒慢测试跳过。覆盖 UTF-8 逐字节、三种行尾、多行、超限恢复、损坏及异常 EOF、tool-only、隐私元数据。初次 ESLint 报一个括号格式及 test.each 插件误识别，已定点修正后重跑。没有 Google 生成、实机浏览器或 TUN 新测试。
- 本分项单独提交；PDF 仍待下一分项，保持可单独回退。

补充审查：B 已提交 1cc4a1bbd。检查多行 data 时，发现观察器应把当前未结束行和已缓存 data 合并计入同一容量预算，已将边界检查改为 line.length + size；这是诊断内存界限收紧，不影响原始流。单独补充 fix 提交。完整回归中 25 套件 503 项通过、1 项既有可选慢测试跳过（该时点含 PDF 首批隔离测试，后续最终数字另记）。

### C. PDF 原文件输入第一阶段

**实现与边界**

- 新增 public/scripts/native-pdf.js 作为浏览器/后端共享的引用、能力和限额规则；新增 src/native-pdf.js 处理校验、用户目录保存和最终 inlineData 组装。首版只支持原生 Vertex（Full/Express）+ 精确模型 gemini-4-argon；反向代理、其他模型/供应商明确拒绝，不静默丢文件或自动改成文本重发。
- public/index.html 的聊天待发送附件增加 PDF 模式选择；默认仍为提取文本。public/scripts/chats.js 支持原文件上传、用户消息内追加附件、下载原文件、历史引用和失败批次只撤回新建 PDF。原有文本附件与资料库/RAG 路径不变；旧文本附件无法还原 PDF，需要重新选择原文件。新增简繁中文标签。
- 原文件存放在当前认证用户 files 目录，使用服务器生成 UUID 文件名。聊天 JSON 仅保存 id、URL、SHA256、MIME、大小、页数、显示名称，不长期保存 Base64。服务端严格限定 UUID 名称、真实父目录、非符号链接、文件大小，并重新核对哈希及页数；不允许客户端传任意文件系统路径。上传用独占新文件写入，不覆盖已有文件。
- 复用仓库已自带 PDF.js 4.7.76，延迟加载，仅解析文档/页树验证，不提取文字或渲染，不执行 PDF JavaScript；没有增加生产依赖或变更 package/lock。真实加密 PDF 拒绝；格式/页树可验证不代表已经渲染每一页或排除所有 PDF 内部资源损坏，Google 仍可能拒绝特定文件，不自动重试。
- 本地先行限额：每文件 5 MiB；所选上下文最多 4 个 PDF 引用、合计 100 页/12 MiB；最终编码后的整个 Google JSON 请求最多 20 MiB。这些是本实现的保守限额，不是官方最大能力。前端预留约 4096 token/页的估计预算，避免把 PDF 当零成本附件；不是实际计费/精确 countTokens，无法保证所有密集文档绝不超模型上下文。
- 为兼容预设把消息字符串化，附件在**临时提示词文本**中使用不含正文的固定格式引用，随该消息进入上下文预算及历史截取；聊天中保存的仍是元数据。CHAT_COMPLETION_PROMPT_READY、CHAT_COMPLETION_SETTINGS_READY 和后端 postProcessPrompt 后均校验引用集合/次数；实际发送前，在 Google contents 原文本位置替换为 application/pdf inlineData。文件名称作为文本上下文保留。PDF 没有伪装为图片，完整字节仅在后端发请求时转 Base64。
- 此方案覆盖原先 SPreset 的 contentToText/JSON 包裹形状与真实 merge_tools 后处理。若别的扩展删除、复制或损坏选中引用，明确报错；如果更早阶段把整个历史消息排除在上下文外，则该附件也不发送，符合所选历史范围。系统指令中无法安全归位或工具转换丢引用也拒绝，避免错误归属。
- 原生 PDF 上传限于用户消息。删除沿用现有聊天附件删除逻辑；同一文件被复制到其他聊天时共享引用的既有删除语义未改，文件缺失会提示重新附加。切换不支持的提供商/模型后，包含原生 PDF 的上下文会报明确错误；需要用户自行重新附加为文本。
- src/endpoints/files.js 新增 /upload-pdf；src/endpoints/backends/chat-completions.js 在供应商分派前验证能力/引用、文本后处理后复核，并在实际调用前完成文件组装及编码大小检查。原有传输与停止按钮仍使用同一个 AbortSignal；未新增云存储、Files API、自动重提生成或工具分片。Google SDK 文档再次确认 Files.upload 不适用于 Vertex，故没有复用 AI Studio 上传通道。

**验证与审查**

- tests/fixtures/native-pdf.js 构造带文字、矢量图表和光栅图像、真实 xref 的合成 PDF；native-pdf-encrypted.pdf 是该合成文件经现有 bundled pypdf 加密的专用夹具，密码 synthetic-test-password，无私人内容/凭据。新增三套测试覆盖原字节/SHA一致、多个文件及消息位置、JSON 重载、中文名称、旧文本附件、失败批次撤回、目录隔离/缺失/改动/非法引用、预设压缩、merge_tools、真实上传/生成路由、tool-only 响应、模型切换和零提交的错误路径。
- 已额外验证真正的密码保护 PDF、损坏/非 PDF/Base64 非法、101 页、数量/总大小/编码请求大小限制。PDF 三套定向测试先后共 15 项通过；真实 Google fetch 被本机 mock 截获，不读取服务账户或实际聊天。
- 用 Playwright 技能进行了独立 Chrome 页面验证：加载生产 file_form 与生产 onFileAttach/populateFileAttachment/appendFileContent 函数，使用隔离后端及合成文件；默认文本模式、显式选择原文件、保存元数据、构成 1 个 PDF part / 1 页、表单 reset 回到文本、损坏文件明确报错均通过。其余页面依赖为合成 stub，**不等同于完整酒馆页面/用户主题/在线 SPreset 的浏览器集成验证**。没有刷新用户酒馆页面、修改运行设置或发送 Google 生成。
- 临时探针首跑相对导入路径写错，已修正；沙箱内 Chrome Crashpad 无法启动，改为自动审核通过的独立临时浏览器。页面唯一非业务错误为测试页 favicon 404，损坏文件测试另有预期 HTTP400。测试服务和浏览器均已关闭；仅本轮创建的临时源码、截图目录内合成文件及 CLI 快照经过工作区绝对路径确认后清理，未动用户进程/数据。
- 所有修改的 JS 已通过 ESLint，git diff --check 通过。AGENTS.md 记录本次后续授权范围。最终全套与 Git 结果见下节。

### D. 最终验收与交付记录

- 最终全套启用 VERTEX_LONG_IDLE_TEST=1：**27 套件、513 项全部通过，0 跳过，72.79 秒**。包含 65 秒真实定时器静默保活、HTTP/2/CONNECT/TLS/取消/原字节转发和新功能测试。完成后补充收尾审查：忽略非文本空 part、取消追加附件弹窗时清空文件选择、追加上传失败后不发出成功事件；再次执行 PDF 三套定向回归及 ESLint。
- 分支 codex/vertex-gemini-investigation；本轮思考片段提交 0f6273b64、诊断提交 1cc4a1bbd、诊断边界补充 c0f7677ef；PDF 采用独立 feat 提交，提交号可由 git log 查到，不把本提交自身哈希写回制造递归记录。提交只显式列出源码/合成测试/翻译/AGENTS/本日志，保留原有未跟踪 _claude，不提交附件、凭据、请求体或实际聊天。未推送远端。
- 本轮没有修改 config.yaml、预设、世界书、扩展或用户聊天；没有调用 Google 生成或重复提交。保留 003 的实机成功证据；本轮新增证据是本机协议/路由/浏览器隔离验证，实际 Google PDF 阅读、在线预设版本及用户主题仍待正常使用验证。
- 使用方式：结束当前生成后，以 Start.bat 重启后端并刷新页面；选 PDF 后在附件条选择“发送 PDF 原文件（Vertex Argon）”，也可给历史用户消息追加。默认文本与既有聊天继续沿用原方式。更详细等待提示可在 config.yaml 的 gemini.vertexHttp2 下设置 progressIntervalMs: 60000；默认 0 不定时刷日志。observeSse: false 可关闭语义统计，仍保留传输摘要。无需修改当前 30 秒 PING。
- 回滚优先按功能进行 git revert；若要撤销诊断，可先撤销边界补充再撤销诊断提交；撤销 PDF 功能前先把需要继续使用的原生 PDF 重新附加为文本。正常文件系统备份应同时包含聊天与 user/files 中原文件，仅导出聊天 JSON 不会打包 PDF。
- 下一步为用户日常生成观察：若仍无提前思考，查看 sse.firstThoughtMs/thoughtChars 与 finishReasons/usage；thoughtChars=0 只表示未观察到摘要，toolParts>0 且 textChars=0 仍可能是合法工具正文。skippedEvents/malformedEvents/incompleteEvent 需同时考虑，不能凭诊断缺项判空或自动重试。

## 005A · 2026-10-20（Asia/Shanghai）· 新建聊天缺失提示

- 用户本轮报告三次聊天文件缺失提示、图片附件无法识别，并要求放宽原生 PDF 限额。授权范围为针对这些问题排查修复；保留稳定传输、工具正文、私人预设和配置，不提交运行数据、不向远端推送。
- 当前检查：用户列出的三个文件均存在，分别为 2、2、4 行有效 JSON；两处相关目录共 9 个聊天文件的非空 JSON 行均可解析。仅检查结构及元数据，未把真实聊天正文写入本记录。现存文件有效并不能证明历史上所有缺失提示都无害。
- 源码证据：`doNewChat()` 和 `replaceCurrentChat()` 的无现有聊天分支，在首次保存之前调用 `getChat()`；后端将尚不存在的新文件统一打印成缺失/空文件警告。随后 `getChatResult()` 创建首条消息并保存，与本次文件创建时间和有效内容相符。
- 修改：`public/script.js` 仅在这两处明确新建流程传递 `allowMissing: true`；`src/endpoints/chats.js` 仅对明确新建且确实不存在的文件免除该警告。普通读取、已存在空文件、保存及完整性防覆盖规则不变。`tests/chat-new-session.test.js` 增加四项合成文件/实际新建函数测试。
- 验证：新建聊天、聊天完整性、聊天预览共 3 套 28 项测试通过；上述三个 JavaScript 文件 ESLint 通过。第一次测试因隔离环境未设置完整备份配置变量而退出，补齐与既有测试相同的四个环境变量后通过，未修改实际配置。没有以自动化操作用户真实聊天来测试。
- Git：基线 `bb2f611c7`，分支 `codex/vertex-gemini-investigation`；本节随聊天修复独立提交，原有未跟踪 `_claude/` 保留且不暂存。下一步处理图片能力遗漏及 PDF 限额，分别记录。

## 005B · 2026-10-20（Asia/Shanghai）· 图片附件未进入请求

- 当前有效设置与使用中的预设均为 `media_inlining: false`；此外 `isImageInliningSupported()` 的 Google 支持列表没有 `gemini-4-argon`。前者关闭所有图片内联，后者即使打开开关仍阻止 Argon 图片进入 `Message.addImage()`。附件保存与模型请求是两条不同流程。
- 相关聊天的 47 处已保存图片引用均能找到物理文件；当前全局媒体显示为 list，未发现此处由 gallery 仅发送选中图片引起。没有复述或提交图片内容。Google [Argon 官方模型规格](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon?hl=zh-CN) 明确支持图片输入。
- 修改：`public/scripts/openai.js` 在 Vertex/AI Studio 分支精确识别 Argon，沿用既有图像读取、压缩和转换流程；不泛化为所有未来 Gemini 4 模型。`public/scripts/chats.js` 在图片附件批次的上传前检查是否能内联，无法发送时提示开关或模型原因，一批只提示一次。新增简繁中文提示；不改用户设置和预设，启用需勾选“发送内联媒体”并保存预设。
- `tests/google-image-attachments.test.js` 验证两个 Google 来源、关闭开关、其他主 API、已有与未知模型、实际 addImage → merge_tools → Google inlineData 字节保留、批次提示和设置不变。与原生 PDF 附件回归共 2 套 10 项通过；相关 JavaScript ESLint、两份翻译 JSON 解析通过。图片压缩在本次合成测试中为桩，不代表实际浏览器压缩质量或 Google 视觉识别实测。
- 测试规范复查：仓库的 Playwright ESLint 规则不识别 Jest `test.each`，改成循环声明普通 `test`，并修正一处引号；未关闭规则。复跑图片 6 项及 ESLint 均通过，修正包含在同一图片提交中。
- Git：上个聊天提交 `22abe9254`；本节随图片修复独立提交。未启动真实生成或改动用户页面。下一步提高 PDF 原文件限额并验证旧引用兼容和总请求限制。

## 005C · 2026-10-20（Asia/Shanghai）· 放宽 PDF 与本轮验收

**依据与实施范围**

- 用户要求扩展偏严的 PDF 限制。本轮再次核对 [Argon 规格](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon?hl=zh-CN) 和 [文档输入说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding)：API/Cloud Storage 的 PDF 单文件上限为 50 MB、每文件最多 3000 页。旧 5 MiB / 100 页是 004 中的本地先行约束，不是官方上限。
- `public/scripts/native-pdf.js` 统一改为：单文件 50,000,000 字节；所选上下文最多 16 个引用、总计 3000 页和 100,000,000 字节原文件；含 Base64 的整个 Google JSON 请求最多 140,000,000 字节。16 个文件、合计页数/字节及 JSON 总量均是本地内存预算，不冒充 Google 额度。MB 为十进制，50 MB 约 47.7 MiB。
- 继续保留总量边界，原因是当前 inlineData 需要在内存同时持有原文件、Base64 和 JSON；任意取消限制会明显增加内存峰值。100 MB 原文件编码后约 133.3 MB，140 MB 请求预算留出文本和结构开销，文本/图片等同请求内容仍一并计入。大文件读取等待及网络上传时间可能增加，未变更超时、HTTP/2、PING 或自动重试策略。
- 旧引用继续兼容，标记页数字段扩为四位。`src/native-pdf.js` 同步文件校验、页数和最终请求限制；同一请求中重复引用复用一次读取/解析/编码，但每个发送副本仍分别计入总量。前端 `chats.js`、后端 `files.js` 的校验提示与选择说明改为引用共享常量，避免前端放行而后端仍使用旧上限。
- 页预算由 4096 调整为约 1120 token/页，并在界面标注估算。来源文档的 1120 是 **Gemini 3 高分辨率 PDF** 数值，本实现仅借作启发式预算，未确认 Argon 同值；没有设置或降低模型分辨率，也没有新增远程 countTokens 请求。3000 页是文件/总页数边界，**不保证 3000 页能进入当前上下文**；仍受用户的上下文预算、提示词和实际模型 token 限制约束。密集文字文档的实际消耗仍可能超过估计，不能把估计当精确计费或保证。
- 更新 `tests/native-pdf.test.js`、`native-pdf-request.test.js`、`native-pdf-attachments.test.js`；未修改生产依赖、服务器整体 500 MB 请求解析配置或用户文件。原生 PDF 仍仅限原生 Vertex Argon（Full/Express、无反向代理）；默认提取文本方式、工具正文和历史文件校验保留。

**测试、限制与交付**

- PDF 3 套 17 项通过：50 MB 合成 PDF 可以原样保存并核对 SHA；多 1 字节拒绝且不落盘；1001 页文件上传/解析/四位引用/最终 PDF part 保留；旧两位页数引用兼容；3001 页及合计页数超限拒绝。大于旧 5 MiB 的约 6 MiB 合成 PDF 经实际上传/生成路由进入模拟上游，字节一致；merge_tools、HIGH 思考设置、完整工具回复保持正常。
- 总量测试覆盖重复引用超过 100 MB 和非 ASCII 文本让最终 JSON UTF-8 字节数超过 140 MB；加密、损坏、跨用户、缺失/改动、引用被删除/复制、不支持连接和失败批次撤回回归通过。使用的 50 MB 文件含合成 PDF 及空白填充，只证明大小边界/字节保留，不代表 50 MB 复杂扫描件性能或 Google 接受率。
- 最终完整单元回归：`node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json --runInBand --verbose=false --silent`，**29 套件、524 项通过、1 项可选慢测试跳过，8.939 秒**。本次传输无改动，未再次启用已在 004 实测通过的 65 秒静默测试。所有本轮修改 JavaScript 的 ESLint、翻译 JSON 解析、`git diff --check` 通过。
- 所有网络生成测试均使用本机模拟；本轮没有 Google 生成请求，没有验证真实浏览器全链路/在线预设或 TUN 上传大文件。尚不能承诺模型已经实际识别用户图片或读完大型 PDF。用户列出的文件结构正常属于当前磁盘证据，不能反推历史上从未发生读取失败。
- 生效步骤：结束生成后重启酒馆后端并刷新页面；图片在聊天补全设置开启“发送内联媒体”并保存当前预设，否则开关仍阻止发送；PDF 附件选择“发送 PDF 原文件（Vertex Argon）”。本轮没有改 `settings.json`、预设、世界书、扩展、聊天或用户进程。
- Git：聊天修复 `22abe9254`；图片修复 `9a0ef78e6`；本节随 PDF 限额调整单独提交。保留 `_claude/`，仅显式暂存源码、合成测试及本日志，不包含运行数据，不推送远端。后续优先按功能 `git revert`；若撤销本次 PDF 放宽，超过旧限额的已存原生附件会重新受旧约束，文件本身不会被删除。
- 本轮收到替换版 AGENTS 指令，再次强调每次对话更新时间线/调查/改动并使用 Git；本节及 005A/B 合并完成本轮记录。下一步为正常使用验证：先用一张图确认开关生效，再以实际所需 PDF 大小验证原文件读取；只在出现具体新错误时继续追踪，不自动重提生成。

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
