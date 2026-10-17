# 运维与验证

## 异常协调锁恢复

如果所有写入持续显示繁忙、但读取正常，先检查函数日志。实例被强制终止后，协调票据不会自动删除，防止仍在运行的实例和新实例同时进入临界区。

**必须先在平台暂停外部请求/站点流量，并等待至少3分钟，确保超过120秒的函数运行上限，然后才恢复锁；不能在活跃站点上抢锁。**设置自己的项目ID/API Token（不要写入Git），执行：

```sh
EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs
EDGEONE_PROJECT_ID=your-project-id EDGEONE_PAGES_API_TOKEN=your-token node scripts/locks.mjs --reset-after-pausing-site
```

确认恢复结束后恢复流量，并手动运行清理工作流。工具不会打印Token。


## 验证范围与限制

2026-10-10 的开发记录：24 项单元测试通过；Makers 本地运行器连接真实 Blob，完成 300MB／75 分块上传下载并核对 SHA-256；已部署 HTTP 站点完成 5MB 哈希验证。真实 Blob 并发取件码和容量预留也做过验证。

**这不等于公网 300MB、跨设备或大规模并发已经验收。** 公网 300MB 完整下载哈希验证尚未完成；双设备兼容性、WAF 和额度告警应由部署者自行验证。上线前还应检查到期拒绝访问、撤销、每日清理及浏览器大文件保存。健康接口和内存模拟测试都不能替代这些检查。


容量策略现为 700MB 后限 10MB；旧验证记录中的容量阈值不代表当前配置。Blob 命名空间 `pickup-drop` 保留以兼容既有站点数据；这不是对外产品名。
