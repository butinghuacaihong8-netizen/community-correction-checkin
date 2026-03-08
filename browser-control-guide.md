# Claude Code 控制用户浏览器：完整方案指南

## 核心需求

用户已在 Chrome 中登录了 GitHub、飞书等服务，需要 Claude Code 能控制该浏览器（或访问这些会话）来自动化操作。

---

## 方案一：Playwright MCP + CDP 连接已有 Chrome（推荐）

这是最成熟、最推荐的方案。微软官方维护的 `@playwright/mcp` 支持通过 `--cdp-endpoint` 连接到已运行的 Chrome。

### 第一步：启动 Chrome（带远程调试端口）

**重要：Chrome 136+ 安全变更** —— 从 Chrome 136 开始，`--remote-debugging-port` 不再允许调试默认用户数据目录，必须指定 `--user-data-dir`。

**Windows 命令：**

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-debug-profile"
```

或者创建一个快捷方式，在"目标"栏追加参数：
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\Administrator\.chrome-debug-profile"
```

首次启动后，这是一个全新的 Chrome 配置文件。你需要：
1. 在这个 Chrome 中登录 GitHub、飞书等服务
2. 之后每次用相同命令启动，登录状态都会保留（因为 `--user-data-dir` 指向同一个目录）

### 第二步：验证调试端口

在浏览器中访问 `http://localhost:9222/json/version`，应该返回类似：
```json
{
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/xxx-xxx"
}
```

### 第三步：配置 Claude Code

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222
```

或者在 `~/.claude.json` 中手动添加：
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"]
    }
  }
}
```

### 第四步：使用

在 Claude Code 中直接说：
- "用 playwright mcp 打开 GitHub 创建一个新仓库"
- "导航到飞书并查看我的消息"

Claude Code 将获得 25+ 个浏览器操作工具，包括：
- `browser_navigate` - 导航到 URL
- `browser_click` - 点击元素
- `browser_type` - 输入文字
- `browser_snapshot` - 获取页面无障碍树快照
- `browser_take_screenshot` - 截图
- `browser_select_option` - 选择下拉选项

---

## 方案二：Chrome DevTools MCP

Google Chrome 官方团队维护的 MCP 服务器，功能更丰富（性能分析、网络监控等）。

### 安装

```bash
claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9222
```

### 前提

同样需要先启动带 `--remote-debugging-port=9222` 的 Chrome（见方案一第一步）。

### 特点
- 支持性能追踪分析
- 支持网络请求监控
- 支持控制台日志读取
- 支持截图
- 使用 Puppeteer 自动化

---

## 方案三：Browser MCP（Chrome 扩展方式）

通过安装 Chrome 扩展来实现控制，无需命令行参数启动 Chrome。

### 安装步骤

1. 从 Chrome Web Store 安装 [Browser MCP 扩展](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc)
2. 配置 MCP 服务器到 Claude Code
3. 扩展会在你的真实浏览器中运行，保留所有登录状态

### 优势
- 不需要 `--remote-debugging-port`
- 直接使用你当前的浏览器和登录状态
- 本地运行，隐私安全

---

## 方案四：mcp-playwright-cdp（社区方案）

专门为 CDP 连接设计的 Playwright MCP 服务器。

### 安装

```bash
npx -y @smithery/cli install @lars-hagen/mcp-playwright-cdp --client claude
```

### 特点
- 自动尝试连接运行中的 Chrome 实例
- 连接不上时才启动新浏览器
- 支持截图、导航、表单填写、JS 执行

---

## 方案五：Puppeteer MCP（连接活动标签页）

`merajmehrabi/puppeteer-mcp-server` 支持连接到已运行的 Chrome 标签页。

### 特点
- `puppeteer_connect_active_tab` 工具可连接到已有 Chrome 标签页
- 不会关闭你的 Chrome 实例
- 保留现有浏览状态和认证

---

## 方案六：纯代码方式（不用 MCP）

如果只需要在脚本中控制浏览器，可以直接用 Playwright 的 `connectOverCDP`：

```javascript
// connect-chrome.js
import { chromium } from 'playwright';

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    console.log('Connected:', browser.isConnected());

    const context = browser.contexts()[0];
    const page = await context.newPage();

    // 使用已登录的会话访问 GitHub
    await page.goto('https://github.com');
    await page.screenshot({ path: 'github.png' });

    await page.close();
    await browser.close();
})();
```

使用 `launchPersistentContext` 启动带现有配置文件的浏览器：

```javascript
import { chromium } from 'playwright';

(async () => {
    const context = await chromium.launchPersistentContext(
        'C:\\Users\\Administrator\\.chrome-debug-profile',
        {
            channel: 'chrome',  // 使用系统安装的 Chrome
            headless: false
        }
    );
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://github.com');
    // ...
})();
```

**注意：** `launchPersistentContext` 不能指向 Chrome 的默认用户数据目录（会导致页面无法加载或浏览器退出），且浏览器配置文件不能已被另一个 Chrome 实例打开。

---

## 推荐方案总结

| 方案 | 难度 | 保留登录状态 | 维护者 | 适用场景 |
|------|------|-------------|--------|---------|
| **Playwright MCP + CDP** | 中 | 是（需独立配置文件） | 微软 | 最通用、最推荐 |
| **Chrome DevTools MCP** | 中 | 是（需独立配置文件） | Google Chrome 团队 | 需要性能/网络分析 |
| **Browser MCP 扩展** | 低 | 是（直接用现有浏览器） | 社区 | 最简单、不需要命令行 |
| **mcp-playwright-cdp** | 中 | 是 | 社区 | 自动检测 Chrome |
| **Puppeteer MCP** | 中 | 是 | 社区 | 连接活动标签页 |
| **纯代码** | 高 | 是 | 自己 | 自定义脚本 |

## 重要注意事项

1. **Chrome 136+ 安全限制**：必须使用 `--user-data-dir` 指向非默认目录
2. **不能共用配置文件**：调试用的 Chrome 和日常用的 Chrome 不能用同一个配置文件目录
3. **首次需重新登录**：使用新的 `--user-data-dir` 意味着首次启动需要重新登录各网站，之后就会保留
4. **安全风险**：远程调试端口对本机所有进程开放，不要在共享网络/生产环境使用
5. **WebSocket URL 变化**：每次启动 Chrome，`webSocketDebuggerUrl` 都会变化，但使用 `http://localhost:9222` 连接时 Playwright 会自动解析

## Windows 快速启动脚本

创建 `chrome-debug.bat`：

```bat
@echo off
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-debug-profile"
echo Chrome debug instance started on port 9222
echo Visit http://localhost:9222/json/version to verify
pause
```

创建 `chrome-debug.ps1`（PowerShell）：

```powershell
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$userDataDir = "$env:USERPROFILE\.chrome-debug-profile"
Start-Process $chromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$userDataDir`""
Write-Host "Chrome debug instance started on port 9222"
Write-Host "Visit http://localhost:9222/json/version to verify"
```
