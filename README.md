# Drop 临时取件站

用四位取件码，在手机和电脑之间临时传递文件或文字。

**[在线 Demo](https://drop.nmdft.cn)** · [部署自己的 Drop](#部署自己的-drop) · [MIT License](LICENSE)

## 怎么用

1. 打开站点，粘贴文字或选择文件，设置保留时间，生成取件码。
2. 在另一台设备输入四位码，或打开分享链接，即可取件。
3. 有效期内可重复领取，发送者也可以提前撤销。

## 特性

- 文件最大 **300MB**，文字最大 **1MB**，支持分块传输。
- 默认保留 **1 小时**，可选 3 小时、1 天、3 天；到期停止领取，每天北京时间 **03:23** 清理过期内容。
- 无需注册，取件码以四格显示，支持完整粘贴；浅色／深色主题默认跟随系统，也可手动切换并记住选择，内置基础限流。
- 使用 EdgeOne Makers 云函数和 Blob 存储，无需自备服务器或另建数据库。
- 已存容量达到 **700MB** 后，新文件上限降为 **10MB**；剩余容量不足时拒绝上传。

> 四位码不是密码，内容没有端到端加密，请勿上传敏感信息。Demo 仅供体验，不保证长期可用。

## 部署自己的 Drop

1. **Fork 本仓库**，在 **EdgeOne Makers** 中从 Git 导入自己的仓库，选择 `main` 分支。
2. 核对构建设置，点击部署：

   | 设置 | 内容 |
   | --- | --- |
   | 安装命令 | `npm ci` |
   | 构建命令 | `npm run build` |
   | 输出目录 | `dist` |
   | Node.js | 20 或更高的兼容版本 |

3. 打开平台提供的 HTTPS 地址，试一次发送、领取和撤销。也可以绑定自己的域名。

到期立即停止领取，文件和文字由平台定时任务清理删除，并非到期瞬间物理删除。部署后请检查任务执行记录。存储额度和费用以自己的平台套餐为准。

## 本地开发

需要 Node.js 20+：

```sh
npm ci
npm test
npm run build
```

完整本地预览需安装 Makers CLI，并关联独立的测试项目及 Blob 后运行 `npm run dev`；不要连接生产存储进行普通开发。

<details>
<summary>维护与故障排查</summary>

- 不要清空 Blob 的 `config/`；丢失站点配置会使旧上传、下载和撤销凭证失效。升级旧版时先保留原环境变量。
- 清理未完成或返回 503 时，检查云函数和定时任务日志，再通过平台重试；健康接口正常不代表清理成功。
- 如果持续无法写入但可以读取，先检查协调锁日志。**暂停外部流量及定时任务，等待至少 3 分钟**，确认没有运行中的函数，再执行锁检查与恢复：

  ```sh
  EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs
  EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs --reset-after-pausing-site
  ```

  完成后恢复流量和定时任务。凭据仅在自己的终端配置，不要提交到仓库。

</details>

## 开源与反馈

代码采用 [MIT 协议](LICENSE)，允许使用、修改和分发，分发时保留版权及许可声明；项目按现状提供，不附带担保。

欢迎通过 Issues 反馈问题或提交 PR；敏感漏洞请按 [安全政策](SECURITY.md) 私下报告，不要公开取件码、撤销链接或凭据。

存储依赖 `@edgeone/pages-blob`（MIT），版本见 `package-lock.json`；依赖及构建工具保留各自许可证。本项目与腾讯／EdgeOne 无官方隶属关系。
