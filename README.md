# 凌峰酒馆

基于 SillyTavern 的个人发行版，面向 Windows 和 Android / Termux。个人主线为 `Linpeaks/SillyTavern-Vertex:main`，按自己的使用需求发布，按需选取上游修复。个人版号与 SillyTavern 基线统一记录在 [package.json](package.json)，启动时会显示两者。

Windows 使用 `SillyTavern.bat` 日常启动，停服后使用 `UpdateAndStart.bat` 更新。Vertex 流式传输、完整工具参数、图片和原始 PDF 均沿用个人版实现。

## 发送附件

聊天补全模式下，展开输入框上方的“发送附件预览”，可查看模型、Google 计费档、新图和历史图片数量，以及 PDF 名称与发送方式。“本轮只发送新消息的图片”作用于下一条新用户消息，同一轮重新生成时继续生效。下一条用户消息默认恢复携带历史图片。

勾选“下一次发送前核对”后，可以在请求发出前核对裁剪后的图片总数和实际 PDF 原件清单，选择发送或取消。这次核对只在本地完成。

## Android / Termux 一键安装

在 Termux 中粘贴这一整行（公开源码，无需 GitHub 登录）：

```bash
pkg update -y && pkg install -y curl && curl -fL https://raw.githubusercontent.com/Linpeaks/SillyTavern-Vertex/main/termux.sh -o "$TMPDIR/st-vertex-install.sh" && bash "$TMPDIR/st-vertex-install.sh"
```

首次会安装依赖、下载本修改版并启动。在手机浏览器打开
**http://127.0.0.1:8000**。以后输入 `st` 打开管理菜单；`st start` 启动，
`st update` 备份后更新，`st backup` 单独备份。停止用 **Ctrl+C**。

安装在 `~/SillyTavern-Vertex`，不会接管 `~/SillyTavern`。
电脑上的聊天、密钥、角色、预设和扩展不随公开代码发布，手机首次使用需配置或私下迁移。

完整说明（数据迁移、更新、失败处理、电脑端后续修改）：
[TERMUX_DEPLOYMENT.md](TERMUX_DEPLOYMENT.md)。

修改与验证历史：[VERTEX_GEMINI_INVESTIGATION_LOG.md](VERTEX_GEMINI_INVESTIGATION_LOG.md)。

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
