# 部署 Drop 到 EdgeOne Makers

## 1. Fork 并导入

Fork 本仓库，然后在 Makers 控制台新建 Git 关联项目，选择自己的仓库和 `main` 分支。保留仓库中的 `cloud-functions/` 与 `edgeone.json`。

- 安装：`npm ci`
- 构建：`npm run build`
- 输出：`dist`
- 运行环境：Node.js 20 或更高的兼容版本

静态页面、Cloud Functions 和 Blob 由 Makers 托管，无需单独购买或维护服务器。实际额度与费用以自己的平台套餐为准。

## 2. 首次配置密钥

运行下面的命令，一次生成两个不同的随机值：

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; for (const name of ['SITE_SECRET', 'CLEANUP_SECRET']) console.log(name + '=' + randomBytes(32).toString('hex'))"
```

将结果填入 **Makers 项目环境变量**，随后部署：

| 名称 | 用途 |
| --- | --- |
| `SITE_SECRET` | 签名上传、领取、撤销和计算验证令牌 |
| `CLEANUP_SECRET` | 防止未授权调用清理接口 |

每个值至少 32 字符。不要直接抄别人的值或把它们写进代码。Blob 凭据由平台注入，不需要额外填写。已有部署无需更换密钥；换 `SITE_SECRET` 会使旧令牌失效。

## 3. 启用每日清理

在自己的 GitHub 仓库启用 Actions，然后到 **Settings → Secrets and variables → Actions**：

- 添加 Secret `CLEANUP_SECRET`：与 Makers 中的同名值一致。
- 添加 Variable `SITE_URL`：自己的长期 HTTPS 根域名，不要填 Demo 域名或会过期的预览链接。

手动运行一次 **Daily cleanup**，确认成功。之后每天 UTC 19:23（北京时间次日 03:23）清理超过所选保留时间的内容。定时任务可能延迟；公开仓库 60 天不活跃时会自动停用，应关注执行记录。详见 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)。取件到期会立即拒绝访问，不依赖定时任务是否准时。

## 4. 验证

打开站点，发送一段文字和一个小文件，在另一台设备领取，再验证撤销。`/api/health` 只检查存储连通，不代表完整功能验收。公网服务还应配置限流和额度告警。

## 本地完整预览

复制 `.env.example` 为 `.env` 并填入自己的两个随机值，然后：

```sh
edgeone login --site china
edgeone makers dev -n your-drop-project --skip-env-sync --skip-ai-gateway-sync
```

该命令会关联／创建指定 Makers 项目，需要账号授权。测试和静态构建不需要这些配置。真实存储脚本及锁恢复说明见 [运维文档](OPERATIONS.md)。
