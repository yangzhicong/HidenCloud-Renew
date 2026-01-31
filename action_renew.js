const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Enable stealth plugin
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// Injection script for mouse simulation and Turnstile detection
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome is already open.');
        return;
    }

    console.log(`Launching Chrome...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('Waiting for Chrome to initialize...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome launch failed');
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('Error parsing USERS_JSON env var:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> Found Turnstile in frame. Ratios:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                console.log('>> CDP Click sent.');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

async function handleVerification(page) {
    console.log('Checking for verification...');
    // Try to solve turnstile for up to 30 seconds
    for (let i = 0; i < 30; i++) {
        // Check if we are already past it (e.g. login form visible)
        if (await page.getByRole('textbox', { name: 'Email or Username' }).isVisible()) {
            console.log('Login form detected.');
            return;
        }

        // Try to click turnstile
        await attemptTurnstileCdp(page);

        await page.waitForTimeout(1000);
    }
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('No users found in process.env.USERS_JSON');
        process.exit(1);
    }

    await launchChrome();

    console.log(`Connecting to Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('Failed to connect to Chrome.');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    const envFile = process.env.GITHUB_ENV || '.env.local';
    // In local dev without GITHUB_ENV, might just print or save to file. 
    // But for the workflow, we append to GITHUB_ENV.

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`=== Processing User ${i + 1} ===`);

        try {
            // 1. Go to Login Page
            await page.goto('https://dash.hidencloud.com/auth/login');

            // 2. Handle First Verification (before login form)
            await handleVerification(page);

            // Double check we are at login form
            await page.getByRole('textbox', { name: 'Email or Username' }).waitFor({ timeout: 20000 });

            console.log('Filling Credentials...');
            await page.getByRole('textbox', { name: 'Email or Username' }).click();
            await page.getByRole('textbox', { name: 'Email or Username' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).click();
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);

            // 3. Handle Second Verification (after filling password, before clicking sign in, if any)
            // User mentioned "after password box appears... remember to pass certification then click login"
            // It often appears as a Turnstile checkbox in the form or similar.
            // We'll try to click the checkbox if found.
            console.log('Checking for second verification...');
            for (let j = 0; j < 10; j++) {
                if (await attemptTurnstileCdp(page)) {
                    await page.waitForTimeout(2000); // Wait for cloudflare to process
                }
                // Break if Sign In button is clickable? 
                // Actually usually we just try to click, and if verified it works.
                await page.waitForTimeout(500);
            }

            console.log('Clicking Sign In...');
            await page.getByRole('button', { name: 'Sign in to your account' }).click();

            // 4. Wait for Dashboard
            try {
                await page.waitForURL('**/dashboard', { timeout: 30000 });
                console.log('Login Successful!');
            } catch (e) {
                console.log('Did not redirect to dashboard immediately. Checking for errors...');
                if (await page.getByText('Incorrect password').isVisible()) {
                    console.error('Incorrect password.');
                    continue;
                }
                // Maybe stuck on verification?
                await page.screenshot({ path: `login_stuck_${i}.png` });
            }

            // 5. Get Cookies
            const allCookies = await context.cookies();
            const relevantCookies = allCookies.filter(c => c.domain.includes('hidencloud.com'));
            const cookieStr = relevantCookies.map(c => `${c.name}=${c.value}`).join('; ');

            // Validate hc_cf_turnstile presence as requested by user
            const turnstileCookie = relevantCookies.find(c => c.name === 'hc_cf_turnstile');
            if (turnstileCookie) {
                console.log(`✅ Extracted hc_cf_turnstile: ${turnstileCookie.value.substring(0, 15)}...`);
            } else {
                console.warn('⚠️ WARNING: hc_cf_turnstile cookie NOT found! Renewal might fail.');
            }

            // 6. Export to Env
            // GitHub Actions format: `COOKIE{i+1}={value} >> $GITHUB_ENV`
            const envName = `COOKIE${i + 1}`;
            console.log(`Exporting ${envName}...`);

            // Masking cookie content in logs
            console.log(`${envName}=***`);

            if (process.env.GITHUB_ENV) {
                fs.appendFileSync(process.env.GITHUB_ENV, `${envName}=${cookieStr}\n`);
            } else {
                console.log(`[Local Mode] Would set ${envName}=${cookieStr.substring(0, 20)}...`);
            }

            // Logout to be clean for next user? 
            // Or just clear cookies/incognito?
            // "action_remew.js" reuses context. We should probably clear cookies or make sure we log out.
            await context.clearCookies();

        } catch (err) {
            console.error(`Error processing user ${i}:`, err);
            await page.screenshot({ path: `error_${i}.png` });
        }
    }

    // Force cleanup
    console.log('Cleaning up...');
    try { if (browser) await browser.close(); } catch (e) { }

    // Kill the chrome process we blindly spawned if we can find it, 
    // or just rely on process.exit() to clean up this node process.
    // Since chrome was spawned detached, we should try to kill it if we kept a reference, 
    // but launchChrome didn't return it.
    // For now, process.exit(0) is the most important fix.

    console.log('Done (Forced Exit).');
    process.exit(0);
})();


/*
HidenCloud 本地自动续期脚本
用途: 从本地 cookie.json 读取 cookie{x} 字段，对用户进行自动续期
运行方式: node local_renew.js
*/

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// 配置
const RENEW_DAYS = 10;  // 续期天数
const COOKIE_FILE = path.join(__dirname, 'cookie.json');  // Cookie 文件路径
const CACHE_FILE = path.join(__dirname, 'hiden_cookies_cache.json');  // 缓存文件路径

const sleep = (min = 3000, max = 8000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// 本地缓存管理
const CacheManager = {
    load() {
        if (fs.existsSync(CACHE_FILE)) {
            try {
                return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            } catch (e) {
                console.log('📁 读取缓存文件失败，将重新创建');
            }
        }
        return {};
    },
    save(data) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    },
    get(cookieKey) {
        const data = this.load();
        return data[cookieKey] || null;
    },
    update(cookieKey, cookieStr) {
        const data = this.load();
        data[cookieKey] = cookieStr;
        this.save(data);
        console.log(`💾 [${cookieKey}] 最新 Cookie 已保存到本地缓存`);
    }
};

class HidenCloudBot {
    constructor(cookieStr, cookieKey) {
        this.cookieKey = cookieKey;
        this.originalCookie = cookieStr;
        this.cookieData = {};
        this.logMsg = [];

        // 优先尝试读取缓存
        const cachedCookie = CacheManager.get(cookieKey);
        if (cachedCookie) {
            console.log(`[${cookieKey}] 🔄 发现本地缓存 Cookie，优先使用...`);
            this.parseCookieStr(cachedCookie);
        } else {
            console.log(`[${cookieKey}] 📝 使用 cookie.json 中的 Cookie...`);
            this.parseCookieStr(cookieStr);
        }

        this.commonHeaders = {
            'Host': 'dash.hidencloud.com',
            'Connection': 'keep-alive',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Referer': 'https://dash.hidencloud.com/',
        };

        this.client = axios.create({
            baseURL: 'https://dash.hidencloud.com',
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 500,
            timeout: 30000
        });

        this.services = [];
        this.csrfToken = '';
    }

    log(msg) {
        const logLine = `[${this.cookieKey}] ${msg}`;
        console.log(logLine);
        this.logMsg.push(msg);
    }

    parseCookieStr(str) {
        if (!str) return;
        str.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const key = pair.substring(0, idx).trim();
                const val = pair.substring(idx + 1).trim();
                if (!['path', 'domain', 'expires', 'httponly', 'secure', 'samesite'].includes(key.toLowerCase())) {
                    this.cookieData[key] = val;
                }
            }
        });
    }

    updateCookiesFromResponse(headers) {
        const setCookie = headers['set-cookie'];
        if (setCookie) {
            setCookie.forEach(sc => {
                const firstPart = sc.split(';')[0];
                const idx = firstPart.indexOf('=');
                if (idx > 0) {
                    const key = firstPart.substring(0, idx).trim();
                    const val = firstPart.substring(idx + 1).trim();
                    this.cookieData[key] = val;
                }
            });
            // 每次更新 Cookie 都保存到本地
            CacheManager.update(this.cookieKey, this.getCookieStr());
        }
    }

    getCookieStr() {
        return Object.keys(this.cookieData).map(k => `${k}=${this.cookieData[k]}`).join('; ');
    }

    async request(method, url, data = null, extraHeaders = {}) {
        let currentUrl = url;
        let methodToUse = method;
        let finalResponse = null;

        const requestHeaders = {
            ...this.commonHeaders,
            ...extraHeaders,
            'Cookie': this.getCookieStr()
        };

        if (methodToUse === 'POST' && !requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        try {
            const res = await this.client({
                method: methodToUse,
                url: currentUrl,
                headers: requestHeaders,
                data: data
            });

            this.updateCookiesFromResponse(res.headers);
            res.finalUrl = currentUrl;
            finalResponse = res;

            if (res.status === 301 || res.status === 302) {
                const location = res.headers['location'];
                if (location) {
                    this.log(`🔄 重定向 -> ${location}`);
                    currentUrl = location.startsWith('http') ? location : `https://dash.hidencloud.com${location.startsWith('/') ? '' : '/'}${location}`;
                    return this.request('GET', currentUrl);
                }
            }
            finalResponse.finalUrl = currentUrl;
            return finalResponse;
        } catch (err) {
            throw err;
        }
    }

    extractTokens($) {
        const metaToken = $('meta[name="csrf-token"]').attr('content');
        if (metaToken) this.csrfToken = metaToken;
    }

    async init() {
        this.log('🔍 正在验证登录状态...');
        try {
            const res = await this.request('GET', '/dashboard');

            // 检查失效
            if (res.headers.location && res.headers.location.includes('/login')) {
                this.log('❌ 当前 Cookie 已失效');
                return false;
            }

            const $ = cheerio.load(res.data);
            this.extractTokens($);

            // 解析服务列表
            $('a[href*="/service/"]').each((i, el) => {
                const href = $(el).attr('href');
                const match = href.match(/\/service\/(\d+)\/manage/);
                if (match) {
                    this.services.push({ id: match[1], url: href });
                }
            });
            this.services = this.services.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

            this.log(`✅ 登录成功，发现 ${this.services.length} 个服务`);
            return true;
        } catch (e) {
            this.log(`❌ 初始化异常: ${e.message}`);
            return false;
        }
    }

    // 重置为原始 Cookie
    resetToOriginal() {
        this.cookieData = {};
        this.parseCookieStr(this.originalCookie);
        console.log(`[${this.cookieKey}] 🔄 切换回 cookie.json 原始 Cookie 重试...`);
    }

    async processService(service) {
        await sleep(2000, 4000);
        this.log(`>>> 处理服务 ID: ${service.id}`);

        try {
            const manageRes = await this.request('GET', `/service/${service.id}/manage`);
            const $ = cheerio.load(manageRes.data);
            const formToken = $('input[name="_token"]').val();

            this.log(`📅 提交续期 (${RENEW_DAYS}天)...`);
            await sleep(1000, 2000);

            const params = new URLSearchParams();
            params.append('_token', formToken);
            params.append('days', RENEW_DAYS);

            const res = await this.request('POST', `/service/${service.id}/renew`, params, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': `https://dash.hidencloud.com/service/${service.id}/manage`
            });

            if (res.finalUrl && res.finalUrl.includes('/invoice/')) {
                this.log(`⚡️ 续期成功，前往支付`);
                await this.performPayFromHtml(res.data, res.finalUrl);
            } else {
                this.log('⚠️ 续期后未跳转，检查账单列表...');
                await this.checkAndPayInvoices(service.id);
            }

        } catch (e) {
            this.log(`❌ 处理异常: ${e.message}`);
        }
    }

    async checkAndPayInvoices(serviceId) {
        await sleep(2000, 3000);
        try {
            const res = await this.request('GET', `/service/${serviceId}/invoices?where=unpaid`);
            const $ = cheerio.load(res.data);

            const invoiceLinks = [];
            $('a[href*="/invoice/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && !href.includes('download')) invoiceLinks.push(href);
            });

            const uniqueInvoices = [...new Set(invoiceLinks)];
            if (uniqueInvoices.length === 0) {
                this.log(`✅ 无未支付账单`);
                return;
            }

            for (const url of uniqueInvoices) {
                await this.paySingleInvoice(url);
                await sleep(3000, 5000);
            }
        } catch (e) {
            this.log(`❌ 查账单出错: ${e.message}`);
        }
    }

    async paySingleInvoice(url) {
        try {
            this.log(`📄 打开账单: ${url}`);
            const res = await this.request('GET', url);
            await this.performPayFromHtml(res.data, url);
        } catch (e) {
            this.log(`❌ 访问失败: ${e.message}`);
        }
    }

    async performPayFromHtml(html, currentUrl) {
        const $ = cheerio.load(html);

        let targetForm = null;
        let targetAction = '';

        $('form').each((i, form) => {
            const btnText = $(form).find('button').text().trim().toLowerCase();
            const action = $(form).attr('action');
            if (btnText.includes('pay') && action && !action.includes('balance/add')) {
                targetForm = $(form);
                targetAction = action;
                return false;
            }
        });

        if (!targetForm) {
            this.log(`⚪ 页面未找到支付表单 (可能已支付)`);
            return;
        }

        const payParams = new URLSearchParams();
        targetForm.find('input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).val();
            if (name) payParams.append(name, value || '');
        });

        this.log(`💳 提交支付...`);

        try {
            const payRes = await this.request('POST', targetAction, payParams, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': currentUrl
            });

            if (payRes.status === 200) {
                this.log(`✅ 支付成功！`);
            } else {
                this.log(`⚠️ 支付响应: ${payRes.status}`);
            }
        } catch (e) {
            this.log(`❌ 支付失败: ${e.message}`);
        }
    }

    getSummary() {
        return {
            cookieKey: this.cookieKey,
            success: this.services.length > 0,
            serviceCount: this.services.length,
            logs: this.logMsg
        };
    }
}

// 主函数
(async () => {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   HidenCloud 自动续期脚本 v3.0           ║');
    console.log('╚════════════════════════════════════════════╝\n');

    let cookieData = {};
    let isCloudMode = false;

    // 检测运行环境
    const isGithubActions = process.env.GITHUB_ACTIONS === 'true';

    // 优先从环境变量读取（云端模式）
    const envCookies = {};
    for (let i = 1; i <= 10; i++) {
        const envKey = `COOKIE${i}`;
        const envValue = process.env[envKey];
        if (envValue && envValue.trim()) {
            envCookies[`cookie${i}`] = envValue.trim();
        }
    }

    if (Object.keys(envCookies).length > 0) {
        console.log('☁️  检测到环境变量配置，使用云端模式\n');
        cookieData = envCookies;
        isCloudMode = true;
    } else if (isGithubActions) {
        // GitHub Actions 环境下，如果没有环境变量，则是配置错误
        console.log('☁️  检测到 GitHub Actions 环境');
        console.log('❌ 未检测到 COOKIE 环境变量');
        console.log('💡 请前往 Settings -> Secrets and variables -> Actions -> Variables 添加 COOKIE1, COOKIE2...');
        process.exit(1); // 报错退出
    } else {
        // 本地模式：从 cookie.json 读取
        console.log('💻 使用本地文件模式\n');

        if (!fs.existsSync(COOKIE_FILE)) {
            console.log(`❌ 未找到 ${COOKIE_FILE} 文件`);
            console.log(`💡 请在同目录下创建 cookie.json 文件，格式如下：`);
            console.log(`{
    "cookie1": "your_cookie_string_here",
    "cookie2": "your_cookie_string_here"
}`);
            console.log('\n或者设置环境变量 COOKIE1, COOKIE2...');
            return;
        }

        try {
            cookieData = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        } catch (e) {
            console.log(`❌ 读取 cookie.json 失败: ${e.message}`);
            return;
        }
    }

    // 过滤出有效的 cookie (cookie1, cookie2, ...)
    const cookies = Object.keys(cookieData)
        .filter(key => key.startsWith('cookie') && cookieData[key] && cookieData[key].trim())
        .sort();

    if (cookies.length === 0) {
        console.log('❌ 没有找到有效的 Cookie 配置');
        console.log('💡 请确保字段名为 cookie1, cookie2... 且值不为空');
        return;
    }

    console.log(`📋 共找到 ${cookies.length} 个账号${isCloudMode ? ' (云端模式)' : ' (本地模式)'}\n`);

    const summaries = [];

    for (let i = 0; i < cookies.length; i++) {
        const cookieKey = cookies[i];
        const cookieStr = cookieData[cookieKey];

        console.log(`\n${'='.repeat(50)}`);
        console.log(`开始处理: ${cookieKey} (${i + 1}/${cookies.length})`);
        console.log('='.repeat(50));

        const bot = new HidenCloudBot(cookieStr, cookieKey);

        // 第一次尝试（可能用的是缓存）
        let success = await bot.init();

        // 如果失败，且当前用的是缓存，则回退到原始 cookie 重试
        if (!success && CacheManager.get(cookieKey)) {
            bot.resetToOriginal();
            success = await bot.init();
        }

        if (success) {
            for (const svc of bot.services) {
                await bot.processService(svc);
            }
        }

        summaries.push(bot.getSummary());

        if (i < cookies.length - 1) {
            console.log('\n⏳ 等待 5-10 秒后处理下一个账号...');
            await sleep(5000, 10000);
        }
    }

    // 输出总结
    console.log('\n\n╔════════════════════════════════════════════╗');
    console.log('║              续期结果汇总                  ║');
    console.log('╚════════════════════════════════════════════╝\n');

    summaries.forEach((summary, idx) => {
        console.log(`📊 ${summary.cookieKey}:`);
        if (summary.success) {
            console.log(`   ✅ 成功续期 ${summary.serviceCount} 个服务`);
        } else {
            console.log(`   ❌ 登录失败，请检查 Cookie 是否过期`);
        }
    });

    console.log('\n✨ 脚本执行完毕！');
})();


