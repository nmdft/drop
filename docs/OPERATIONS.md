# 运维与验证

## 异常协调锁恢复

如果所有写入持续显示繁忙、但读取正常，先检查函数日志。实例被强制终止后，协调票据不会自动删除，防止仍在运行的实例和新实例同时进入临界区。

**必须先在平台暂停外部请求/站点流量，并等待至少3分钟，确保超过120秒的函数运行上限，然后才恢复锁；不能在活跃站点上抢锁。**设置自己的项目ID/API Token（不要写入Git），执行：

```sh
EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs
EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs --reset-after-pausing-site
```

确认恢复结束后恢复流量，并检查 Makers 原生定时清理任务的执行结果。工具不会打印Token。


## 验证范围与限制

2026-10-10 的开发记录：24 项单元测试通过；Makers 本地运行器连接真实 Blob，完成 300MB／75 分块上传下载并核对 SHA-256；已部署 HTTP 站点完成 5MB 哈希验证。真实 Blob 并发取件码和容量预留也做过验证。

**这不等于公网 300MB、跨设备或大规模并发已经验收。** 公网 300MB 完整下载哈希验证尚未完成；双设备兼容性、WAF 和额度告警应由部署者自行验证。上线前还应检查到期拒绝访问、撤销、每日清理及浏览器大文件保存。健康接口和内存模拟测试都不能替代这些检查。


容量策略现为 700MB 后限 10MB；旧验证记录中的容量阈值不代表当前配置。Blob 命名空间 `pickup-drop` 保留以兼容既有站点数据；这不是对外产品名。


## 原生定时清理

`edgeone.json` 的 `daily-cleanup` 使用 `Asia/Shanghai` 时区，每天 03:23 POST 到 `/api/scheduled-cleanup`。构建自动生成本次部署的随机调用凭据，同时写入任务 payload 和被 Git 忽略的 `lib/generated-schedule.js`（只由云函数引用），不进入 `dist`。生产日志应出现 `Native cleanup schedule: automatic deployment credential configured (value hidden).`，不输出凭据。限制项目配置与构建产物的访问权限，不要公开私有构建配置。

站点签名密钥与定时调用凭据独立：前者在第一次请求时保存在私有 Blob `config/site-secret-v1`，后续只读取。初始化使用现有协调锁，不依赖 Blob SDK 不保证生效的 `onlyIfNew`。读取失败或配置损坏时报错，不会静默生成替代密钥。全新项目才会创建新值；旧站点首次初始化会采用原 `SITE_SECRET`，成功后不再依赖该变量。回滚时保留原变量，避免旧版代码无法读取新存储配置；自动初始化的新站点若回滚到手填版，需要管理员将持久密钥安全配置到旧版环境。

定时函数先验证部署凭据，再打开 Blob，逐批处理，80 秒后不再启动下一批，函数上限 120 秒。未完成返回 503，不假定平台会重试；检查日志后按平台能力手动触发任务。保留 `/api/cleanup` 供管理员分批恢复：旧 `CLEANUP_SECRET` 仍配置时使用原 Bearer；否则使用持久站点密钥 HMAC-SHA256 派生值（消息 `drop/manual-cleanup/v1`，hex 编码），不要暴露主密钥或将值写入 URL。

清空 `config/` 不属于日常清理。备份或迁移此配置必须走受保护的管理员渠道；密钥遗失会让旧上传、下载和撤销凭证失效。定时调用凭据随部署变化只影响调度，不影响这些用户凭证。部署切换期若出现授权失败，检查任务和函数是否属于同一部署，确认最新部署后再触发；平台回滚也必须同步恢复对应的调度配置。
