const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const open = require('open');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. 获取当前配置
app.get('/api/config', (req, res) => {
    const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
    res.json(config);
});

// 2. 保存配置 (好友名字)
app.post('/api/config', (req, res) => {
    fs.writeFileSync('config.json', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

// 3. 触发扫码登录
app.post('/api/login', (req, res) => {
    // 运行 login.js
    exec('node login.js', (err, stdout, stderr) => {
        if (err) return res.status(500).send(stderr);
        res.send(stdout);
    });
});

// 4. 触发立即运行
app.post('/api/run', (req, res) => {
    // 运行 daily_task.js
    exec('node daily_task.js', (err, stdout, stderr) => {
        if (err) {
            console.error(err);
            return res.status(500).send(stderr || err.message);
        }
        res.send(stdout);
    });
});

// 5. 【核心】一键设置 Windows 定时任务 (支持自定义时间)
app.post('/api/schedule', (req, res) => {
    const nodePath = process.execPath;
    const scriptPath = path.resolve(__dirname, 'daily_task.js');

    // 1. 读取最新的配置，获取用户设置的时间
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
    } catch (e) {
        config = { scheduleTime: '08:00' }; // 默认值
    }

    // 获取时间，如果没设置则默认 08:00
    const time = config.scheduleTime || '08:00';

    console.log(`正在设置定时任务，时间: ${time}`);

    // Windows 命令: /st 代表 start time
    const command = `schtasks /create /tn "DouyinAutoSpark" /tr "\"${nodePath}\" \"${scriptPath}\"" /sc daily /st ${time} /f`;

    exec(command, (err, stdout, stderr) => {
        if (err) {
            console.error("设置失败:", stderr);
            return res.status(500).json({
                error: "设置失败！请确保以【管理员身份】运行。",
                details: stderr
            });
        }
        // 返回成功信息给前端
        res.json({ success: true, msg: `✅ 任务设置成功！将在每天 [${time}] 自动运行。` });
    });
});

// 6. 后台定时刷新登录凭证（每 24 小时访问一次抖音，防止 cookie 过期）
const AUTH_PATH = path.join(__dirname, 'auth.json');
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 小时

async function refreshSession() {
    if (!fs.existsSync(AUTH_PATH)) {
        console.log('[刷新] auth.json 不存在，跳过');
        return false;
    }
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
        });
        const context = await browser.newContext({
            storageState: AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true
        });
        const page = await context.newPage();
        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000); // 等待页面加载完成，让 cookie 充分刷新

        // 保存更新后的 cookie
        await context.storageState({ path: AUTH_PATH });
        console.log(`[刷新] ✅ 登录凭证已刷新 (${new Date().toLocaleString()})`);
        return true;
    } catch (e) {
        console.error(`[刷新] ❌ 刷新失败: ${e.message}`);
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

// 启动时立即刷新一次，之后每 24 小时刷新
refreshSession();
setInterval(refreshSession, REFRESH_INTERVAL);

// 7. 手动触发刷新的 API
app.post('/api/refresh', async (req, res) => {
    const ok = await refreshSession();
    res.json({ success: ok, msg: ok ? '✅ 登录凭证刷新成功' : '❌ 刷新失败，请先扫码登录' });
});

app.listen(3000, () => {
    console.log('UI启动成功: http://localhost:3000');
    open('http://localhost:3000'); // 自动打开浏览器
});