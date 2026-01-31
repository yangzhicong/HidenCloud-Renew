# 快速开始指南 🚀

本文档提供两种使用方式：**本地方案**和**云端方案（GitHub Actions）**。

---

## 📍 方案选择

| 方案               | 适合人群           | 优势                     | 劣势            |
| ------------------ | ------------------ | ------------------------ | --------------- |
| **本地方案** | 新手、需要立即使用 | 简单直接、无需配置       | 需要手动运行    |
| **云端方案** | 追求自动化的用户   | 完全自动化、无需本地环境 | 需要配置 GitHub |

---

## 💻 本地方案：3 步即可开始使用

### 步骤 1️⃣：准备 Cookie (二选一)

#### 方案 A：Windows 自动获取（推荐）

适用于 Windows 本地用户，无需手动抓包。

1. 在项目目录新建 `users.json` 文件：
   ```json
   [
     {"username": "你的邮箱", "password": "你的密码"},
     {"username": "如有第二个账号", "password": "密码"}
   ]
   ```
2. 打开终端运行：
   ```bash
   node win_login.js
   ```
3. 等待浏览器自动登录完成，脚本会自动生成 `cookie.json`。

#### 方案 B：手动获取

1. 浏览器访问 [HidenCloud](https://dash.hidencloud.com) 并登录。
2. 按 `F12` -> `Network` -> 刷新页面 -> 点击请求 -> 复制 `Cookie` 值。
3. 在项目目录新建 `cookie.json` 文件：
   ```json
   {
       "cookie1": "粘贴你复制的Cookie这里",
       "cookie2": ""
   }
   ```

### 步骤 2️⃣：配置 Chrome 路径（仅方案 A 需要）

使用 **方案 A** 时，请确保 `win_login.js` 中的 Chrome 浏览器路径与你的本机路径一致。

1. 打开 `win_login.js` 文件。
2. 找到代码：
   ```javascript
   const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
   ```
3. 检查你的电脑中 `chrome.exe` 的安装位置。如果不同，请**手动替换**路径字符串。

### 步骤 3️⃣：运行脚本

#### 方法一：一键自动登录 

双击 **`start.bat`** 文件。
脚本会自动执行以下流程：

1. 运行 `win_login.js` 自动打开本地 Chrome 获取 Cookie。
2. 成功后，自动运行 `local_renew.js` 进行续期。

#### 方法二：分步运行

如果你只想单独运行续期（假设已有 `cookie.json`）：

```bash
npm start
# 或
node local_renew.js
```

### ✅ 完成！

脚本会自动：

- ✨ 验证登录状态
- 📋 获取所有服务列表
- 🔄 自动续期所有服务
- 💳 自动完成支付
- 💾 缓存最新 Cookie

### 🔄 设置定时任务（可选）

**Windows 任务计划程序：**

1. 打开「任务计划程序」
2. 创建基本任务
3. 触发器：每 7 天
4. 操作：启动程序 `start.bat`

---

## ☁️ 云端方案：GitHub Actions 全自动化

完全云端运行，无需本地环境，自动更新 Cookie。

### 步骤 1️⃣：Fork 仓库

访问项目 GitHub 页面，点击右上角 **Fork** 按钮，将仓库复制到你的账号下。

### 步骤 2️⃣：配置仓库 Secret

1. 进入你 Fork 的仓库
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 配置 Secret：
   - **Name**: `USERS_JSON`
   - **Secret**: 粘贴你的账号配置 JSON（如下格式）
     ```json
     [
       {"username": "user1@example.com", "password": "password123"},
       {"username": "user2@example.com", "password": "password456"}
     ]
     ```
5. 点击 **Add secret**

### 步骤 3️⃣：启用 GitHub Actions

1. 点击仓库顶部的 **Actions** 标签
2. 如果看到提示，点击 **I understand my workflows, go ahead and enable them**

### 步骤 4️⃣：手动测试运行

1. 在 **Actions** 页面，左侧选择 **Katabump Auto Renew New**
2. 点击右侧 **Run workflow** 按钮
3. 再次点击绿色的 **Run workflow** 确认
4. 等待几秒，页面会出现新的运行记录
5. 点击进入查看详细日志

### ✅ 完成！

**自动运行：**

- 每 3 天自动触发一次
- 可在 Actions 页面随时手动运行

**Cookie 自动更新：**

- 脚本执行完成后自动更新仓库变量
- 下次运行会使用最新的 Cookie
- 无需手动维护

**查看运行记录：**

- Actions 页面可查看所有运行历史
- 点击任意记录可查看详细日志

---

## ❓ 常见问题

### Q: 如何获取 Cookie？

A: 见上方「步骤 1️⃣：获取 Cookie」。

### Q: GitHub Actions 运行失败怎么办？

A: 检查以下几点：

1. `ACTION_VARS_TOKEN` 是否正确设置
2. Token 是否有 Variables (Read and write) 权限
3. 仓库变量 `COOKIE1` 等是否已配置
4. Cookie 是否已过期（需重新获取）

### Q: 本地和云端可以同时使用吗？

A: 可以，两种方式使用的是不同的 Cookie 来源（cookie.json vs 仓库变量），互不影响。

### Q: Token 过期后怎么办？

A: 重新生成一个新的 Token，并更新仓库 Secret `ACTION_VARS_TOKEN` 即可。

### Q: 如何查看云端运行结果？

A: 进入 Actions 页面，点击任意运行记录，查看详细日志输出。

---

## 📖 更多帮助

- 详细文档：[README.md](./README.md)
- 英文文档：[README_EN.md](./README_EN.md)
- 问题反馈：GitHub Issues

---

**💡 提示**：第一次运行后，会生成 `hiden_cookies_cache.json` 缓存文件，下次运行时会优先使用缓存的最新 Cookie，提高成功率！
