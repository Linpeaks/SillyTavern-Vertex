# SillyTavern

LLM Frontend for Power Users

This is **Linpeaks' customized Vertex/Gemini edition**, based on SillyTavern
1.19.0. The original project's resources are linked below. All existing local
Vertex transport, Argon thinking, image and native PDF changes are preserved.

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
