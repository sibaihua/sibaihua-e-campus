# 司白画大学清迈分校「我的E校园」— Cloudflare Worker 版

由原 Node.js 版迁移而来，全部运行在 Cloudflare 边缘网络，**全程无需命令行**即可部署：

| 能力 | 实现 | 部署方式 |
|---|---|---|
| 运行时 | Cloudflare Worker（**后端就在 GitHub 仓库里**） | GitHub 仓库 → Workers 控制台导入 |
| 数据存储 | **Cloudflare D1**（SQLite） | 控制台 Settings → Bindings 手动绑定 |
| 表结构 | 首次请求 API 时**自动创建**（幂等） | 无需任何命令 |
| 密码 | PBKDF2-SHA256 + AES-256-GCM（Web Crypto） | 内置 |
| 发信 + 邮箱验证 | **可选功能**（MailChannels API） | 管理后台开关 + 发件配置 |
| 人机验证 | Cloudflare Turnstile | 管理后台开关 + 环境变量密钥 |
| 静态前端 | Worker 内置静态资源（`public/`） | 随代码自动托管 |
| gayg.de 邮箱开通 | fetch 调用开放 API | 管理后台填写管理员邮箱/密码 |
| OAuth 2.0 | 密码模式 + 授权码模式 + userinfo | 内置（Worker 上完全可用） |

API 路径与响应结构与原 Node 版完全一致，前端无需改动。

> **后端在哪？** Cloudflare Worker 本身就是后端——本项目**没有独立服务器**，GitHub 仓库里的
> `src/*.js` 就是后端（处理全部 `/api/*` 接口），`public/` 是前端，两者随仓库一起部署到 Cloudflare 边缘网络。

---

## 目录结构

```
├── wrangler.toml        # Worker 配置（已注释 D1/变量，绑定交给控制台）
├── src/
│   ├── index.js         # Worker 入口：路由 + 全部业务逻辑
│   ├── schema.js        # D1 建表 SQL（首次请求自动执行）
│   ├── db.js            # D1 数据访问层
│   ├── auth.js          # PBKDF2 哈希 + AES-256-GCM
│   ├── mail.js          # MailChannels 邮件发送 + 模板
│   └── captcha.js       # SVG 图形验证码
├── public/              # 静态前端（自动托管）
├── schema.sql           # 建表 SQL（备用，也可在 D1 Console 手动执行）
├── migrate.cjs          # 旧数据迁移脚本（可选，详见下文）
└── .dev.vars.example    # 本地环境变量模板
```

---

## 一、推送到 GitHub

```bash
cd cloudflare-worker
git init
git add .
git commit -m "我的E校园 Cloudflare Worker 版"
git remote add origin https://github.com/<你的用户名>/sibaihua-e-campus.git
git push -u origin main
```

> `node_modules`、`.dev.vars`、`migrate_users.sql` 已被 `.gitignore` 排除，不会上传。

## 二、在 Cloudflare 控制台创建 Worker

1. 打开 https://dash.cloudflare.com → 左侧 **Workers & Pages**
2. **Create** → 选择 **Git 仓库**（GitHub）→ 授权并选择刚推送的仓库
3. 构建设置保持默认（自动识别 `wrangler.toml`），点击 **Save and Deploy**
4. 部署完成，即可访问 `https://sibaihua-e-campus.<你的子域>.workers.dev/`

## 三、绑定 D1 数据库（控制台操作，无命令）

1. 先创建数据库：控制台 → **D1**（左侧菜单）→ **Create database** → 名称填 `sibaihua-e-campus` → Create
2. 回到 Worker 详情页 → **Settings → Bindings → Add**
3. 类型选 **D1 Database**：
   - **Variable name：`DB`**（必须与代码一致）
   - Database：选择刚创建的 `sibaihua-e-campus`
4. Save，然后 **Deploy**（重新部署一次使绑定生效）

✅ 完成。首次访问任意 API（如打开登录页触发注册接口）时，Worker 会自动执行建表 SQL（幂等，重复执行无害），并自动创建管理员账号 `iam`（密码见 `SEED_ADMIN_PASSWORD`，未设置时为 `858308533`，登录后请立即在「个人设置」改掉）。

## 四、后台设置环境变量（控制台操作）

Worker 详情页 → **Settings → Variables**，逐个 **Add**：

| 变量名 | 必填 | 说明 | 示例值 |
|---|---|---|---|
| `SECRET` | **强烈建议** | 密码加密密钥，生产环境务必改为 ≥32 位随机串 | `随机生成一串长字符串` |
| `SEED_ADMIN_PASSWORD` | 否 | 首次部署自动创建的管理员 `iam` 的密码（默认 `858308533`，部署后请务必在后台改掉） | `自定义强密码` |
| `TURNSTILE_SECRET` | 建议 | Turnstile 服务端密钥（若用官方面板默认密钥可留空） | `0x4A...` |
| `TURNSTILE_SITE_KEY` | 否 | Turnstile 站点密钥（前端已内置默认值） | `0x4A...` |
| `MAILCHANNELS_API_KEY` | 否 | MailChannels 密钥（也可在管理后台填写） | `mc_...` |
| `MAIL_FROM` | 否 | 默认发件邮箱 | `no-reply@sibh.cn` |
| `MAIL_FROM_NAME` | 否 | 默认发件人名称 | `司白画大学清迈分校 · 我的E校园` |
| `MAIL_API_BASE` | 否 | Cloud Mail 服务地址 | `https://gayg.de` |

除 `SECRET` 外均非必需——不设置也能跑通注册/登录/申请全流程（邮件服务与管理邮箱在系统后台填写）。

## 五、发信与邮箱验证（可选功能）

> **说明**：Cloudflare 的 Email 相关绑定（Email Workers / Email Routing）只负责**接收**邮件；
> 本项目发送验证码邮件使用 **MailChannels Transactional Email API**（Cloudflare 生态，免费），
> 无需也无法作为绑定添加。

**邮箱验证是可选的**：部署后不配置任何邮件服务也能正常招生——学生申请时直接填写个人联系邮箱即可提交，不需要验证码。三种模式在管理后台「系统设置」切换：

| 模式 | 行为 |
|---|---|
| **自动**（默认） | 配置了邮件服务 → 要求邮箱验证码；未配置 → 直接填写邮箱即可申请 |
| **始终开启** | 始终要求学生先验证联系邮箱（未配置邮件服务时申请会被拦截） |
| **关闭** | 学生申请免验证，个人设置里联系邮箱可直接保存 |

如需开启邮件验证码，按以下两步配置：

1. **域名验证**（一次性）：在发件域名 DNS 添加 TXT 记录
   | 类型 | 名称 | 值 |
   |---|---|---|
   | TXT | `_mailchannels` | `v=mc1 cfid=<你的域名>` |
2. 打开管理后台（登录 `iam` 管理员）→ **系统设置 → 邮件服务**：
   - 填发件邮箱（如 `no-reply@sibh.cn`）、发件人名称、MailChannels API Key（可选）
   - 点「发送测试邮件」验证连通性

## 六、导入旧系统数据（可选，全新部署可跳过）
1. 本机运行迁移脚本，生成 SQL：
   ```bash
   node migrate.cjs --db ../sibaihua-admission/data/db.json --out ./migrate_users.sql
   ```
   （会自动把旧密码哈希 scrypt → PBKDF2、密文重新加密；`migrate_users.sql` 含密文，勿上传 GitHub）
2. 打开 **D1 → sibaihua-e-campus → Console**，把 SQL 内容粘贴进去执行

## 七、本地开发（可选）

```bash
cp .dev.vars.example .dev.vars     # 按需修改本地变量
npm install
# 本地需要 D1：取消 wrangler.toml 中 [[d1_databases]] 注释并填 database_id
npm run dev                        # http://localhost:8787/
```

---

## 常见问题

- **OAuth 在 Worker 上能用吗？** 完全可用。OAuth 2.0（密码模式 / 授权码模式 / userinfo）是纯 HTTP 接口，不依赖文件系统与 SMTP，已在本项目本地环境完整验证：授权页预检 → 用户授权签发 code → code 换 access_token（一次性）→ userinfo。其他校园系统按「API 接口文档」接入即可；唯一注意回调地址 `redirect_uri` 需为 https（Worker 强制 HTTPS）。
- **注册提示「数据库未就绪」**：未绑定 D1 或绑定名不是 `DB` → 按第三节操作后重新 Deploy。
- **注册提示「人机验证未通过」**：`TURNSTILE_SECRET` 未配置或与站点密钥不配套；管理后台可临时关闭 Turnstile 排查。
- **学生申请被要求验证邮箱但发不出验证码**：管理后台「系统设置 · 邮箱验证功能」切到「自动/关闭」，或先配置邮件服务。
- **验证码邮件收不到**：先到管理后台「系统设置 · 邮件服务」发测试邮件；确认 MailChannels 域名 TXT 验证已生效。
- **旧用户登录不了**：迁移时 `SECRET` 必须与线上 `SECRET` 一致；如不一致，用管理后台重置该用户密码。
- **免费额度**：Workers 免费套餐每天 10 万请求；D1 免费 5GB 存储，对本场景绰绰有余。
