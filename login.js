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
