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
| 校园邮箱 | 由用户名推导为 `username@gayg.de`，Cloud Mail（gayg.de）通过「我的E校园」OAuth 登录 | 无需开通/无需管理员账号 |
| OAuth 2.0 | 密码模式 + 授权码模式 + PKCE + userinfo | 内置（Worker 上完全可用） |

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

## 三、绑定 D1 数据库（已内置，无需手动操作）

**D1 绑定已写死在 `wrangler.toml` 里**（binding 名 `DB`，含你的 database_id），随代码一起部署，**不会被构建重置**。

你只需在首次部署前确认一件事：控制台 **D1** 页面里存在名为 `sibaihua-e-campus` 的数据库（若没有，左侧 D1 → Create database 创建即可，名称必须一致）。

> ⚠️ **重要机制**：Cloudflare 的 Git 集成（Workers Builds）每次构建部署时，会按 `wrangler.toml` 重置 Worker 的绑定和**普通变量**——所以绑定与默认变量都写在配置里；敏感值必须用 **Secret** 类型添加（见下节），否则下次构建就会被清空。

✅ 部署后首次访问任意 API 时，Worker 会自动执行建表 SQL（幂等），并自动创建管理员账号 `iam`（密码见 `SEED_ADMIN_PASSWORD`，未设置时为 `858308533`，登录后请立即在「个人设置」改掉）。

## 四、后台设置环境变量（控制台操作）

Worker 详情页 → **Settings → Variables** → **Add**。**关键：敏感值类型必须选 `Secret`，不要用普通变量（普通变量会被每次 Git 构建清空）**：

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `SECRET` | **Secret** | **强烈建议** | 密码加密密钥，生产环境务必改为 ≥32 位随机串 |
| `TURNSTILE_SECRET` | **Secret** | 建议 | Turnstile 服务端密钥（若用官方面板默认密钥可留空） |
| `MAILCHANNELS_API_KEY` | **Secret** | 否 | MailChannels 密钥（也可在管理后台填写） |
| `SEED_ADMIN_PASSWORD` | **Secret** | 否 | 首次部署自动创建的管理员 `iam` 的密码（默认 `858308533`） |

> 其余默认变量（`TURNSTILE_SITE_KEY`、`MAIL_API_BASE`、`MAIL_FROM`、`MAIL_FROM_NAME`）已内置在 `wrangler.toml`，**无需在控制台添加**；如确实要覆盖，改仓库里的 `wrangler.toml` 再 push 即可（控制台改会被构建覆盖）。

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

- **OAuth 在 Worker 上能用吗？** 完全可用。OAuth 2.0（密码模式 / 授权码模式 + PKCE / userinfo）是纯 HTTP 接口，不依赖文件系统与 SMTP。可信任的第一方服务端系统可使用 password 模式并在服务端保存 `client_secret`；包含浏览器前端的 Web 应用必须使用授权码模式 + PKCE，前端不得保存或暴露 `client_secret`。其他校园系统按「API 接口文档」接入即可；唯一注意回调地址 `redirect_uri` 需为 https（Worker 强制 HTTPS）。
- **部署后绑定/普通变量被清空？** Git 集成（Workers Builds）每次构建会用 `wrangler.toml` 重置绑定和普通变量——D1 绑定与默认变量已内置在配置里；敏感值请以 **Secret** 类型添加（构建不会清除 Secret）。
- **注册提示「数据库未就绪」**：确认控制台 D1 里数据库名是否为 `sibaihua-e-campus`（与 wrangler.toml 的 `database_name` 一致），不一致会绑定失败。
- **注册提示「人机验证未通过」**：`TURNSTILE_SECRET` 未配置或与站点密钥不配套；管理后台可临时关闭 Turnstile 排查。
- **学生申请被要求验证邮箱但发不出验证码**：管理后台「系统设置 · 邮箱验证功能」切到「自动/关闭」，或先配置邮件服务。
- **验证码邮件收不到**：先到管理后台「系统设置 · 邮件服务」发测试邮件；确认 MailChannels 域名 TXT 验证已生效。
- **旧用户登录不了**：迁移时 `SECRET` 必须与线上 `SECRET` 一致；如不一致，用管理后台重置该用户密码。
- **免费额度**：Workers 免费套餐每天 10 万请求；D1 免费 5GB 存储，对本场景绰绰有余。
