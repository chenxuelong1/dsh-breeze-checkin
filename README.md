# dsh-breeze-checkin

把 [Breeze Blue](https://breezeblue.ai/app/developer) 的开发者账号收进一个本机账号池，勾选后一键串行签到，领取每日积分。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件，注册在 **设置 → Breeze 签到**。

## 功能

- **账号池**：邮箱 + 密码添加，添加时先真实登录验证一次，登不上的不入库
- **勾选签到**：只签勾选的账号，没勾的一个都不碰
- **每日一次**：服务端已领过的直接跳过，不会重复请求
- **余额与结果**：每行显示当前积分、上次签到时间、实际到账数量
- **档位可选**：Discord 档 / 普通档，实际发放以服务端返回为准
- **刷新余额**：只读拉取，不改动签到记录

## 安装

### 方式一：本地目录

```bash
git clone https://github.com/chenxuelong1/dsh-breeze-checkin.git
```

然后在 DSH 的 **插件** 页面用「添加插件」选择该目录，或：

```
plugin_manager install_bundle  target = <克隆下来的绝对路径>
```

### 方式二：直接从 GitHub 安装

DSH 的安装器支持 `git` 形式的安装规格：

```
plugin_manager install_bundle  target = git+https://github.com/chenxuelong1/dsh-breeze-checkin.git
```

**不需要发布到 npm。** DSH 的安装器支持四种规格：`registry`、`git`、`path`、`tarball`。

## 使用

1. 打开 **设置 → Breeze 签到**
2. 填邮箱和密码，点「添加账号」
3. 勾选要签到的账号
4. 点「签到勾选的账号」
5. 看每行状态：已签到 / 今天已领 / 暂无可领 / 失败

## 它是怎么工作的

签到走站点自己的 Web 接口，和网页上点「立即领取」是同一条链路：

| 步骤 | 接口 |
|---|---|
| 登录 | `POST /api/auth/email/continue` |
| 读余额与今日状态 | `GET /api/credits/summary` |
| 领取 | `POST /api/credits/daily-claim` |

幂等依据是服务端返回的 `already_claimed` / `daily_claim_claimed_today`，**不是本地日期**——本机时钟错了也骗不过服务端。

## 安全边界

- 密码与会话 cookie 存在 DSH 本机凭据库，不进配置文件，界面不回显，日志不打印
- 所有写操作都是 POST 且只接受本机回环地址，其他来源一律 403（同时校验 `Host` 头，防 DNS rebinding）
- 请求固定发往 `https://breezeblue.ai`，没有配置项能改这个目标
- **没有定时任务**：不点按钮就不会有任何网络请求

## 已知限制

- **只能登录已注册的账号。** 站点对「新邮箱注册」要求 Cloudflare Turnstile 人机验证，脚本过不去，所以新账号要先在浏览器里注册并登录一次。已有账号可以纯接口登录。
- **会话会过期**，过期后用保存的密码自动重登一次。密码改了需要删除账号重新添加。
- **积分有有效期**（服务端 `expires_at`，通常 30 天），漏签就是少一天的份额。
- 相邻账号之间固定间隔 600ms 串行执行，避免多账号同时登录触发风控升级。
- 只读且只显示余额、今日状态、上次签到结果；不读站点的历史账目、订阅信息或 API Key。

## 兼容性

- DSH `>= 0.2.2`
- Node.js `>= 22`
- 平台：Windows / macOS / Linux（只用到 Node 内置模块，无原生依赖）

## 免责声明

本项目通过站点公开的 Web 接口完成每日领取，与浏览器手动点击是同一操作。请遵守 [Breeze Blue 服务条款](https://breezeblue.ai/legal/terms)。接口若变更，插件可能失效，届时按上文「它是怎么工作的」自行调整。

## License

[MIT](LICENSE)
