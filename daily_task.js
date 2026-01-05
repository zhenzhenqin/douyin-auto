// daily_task.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process'); // ✅ 新增：引入命令行工具用于检测网络

// 定义绝对路径
const resolvePath = (filename) => path.join(__dirname, filename);

const CONFIG_PATH = resolvePath('config.json');
const AUTH_PATH = resolvePath('auth.json');
const LOG_PATH = resolvePath('task_log.txt');
const LOCK_PATH = resolvePath('task.lock'); // 锁文件路径

// 日志记录
function writeLog(msg) {
    const time = new Date().toLocaleString();
    const logMsg = `[${time}] ${msg}`;
    console.log(logMsg);
    fs.appendFileSync(LOG_PATH, logMsg + '\n');
}

// 删除文件的辅助函数
function deleteFileIfExists(filename) {
    const filePath = resolvePath(filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        // 忽略删除错误
    }
}

// 新增：检测网络连通性 (最多等待 180秒)
// 这解决了电脑刚唤醒时网卡没准备好导致的报错
async function waitForInternet() {
    writeLog('>>> 正在检查网络连接...');
    for (let i = 0; i < 36; i++) { // 尝试 12 次，每次 5 秒
        try {
            // ping 百度，检查是否通网
            execSync('ping www.baidu.com -n 1', { stdio: 'ignore' });
            writeLog('>>> 网络已连接 ✅');
            return true;
        } catch (e) {
            writeLog(`...等待网络恢复 (${i+1}/12)`);
            // 同步等待 5 秒
            const start = Date.now();
            while (Date.now() - start < 5000) {}
        }
    }
    return false;
}

// 辅助截图函数
async function takeScreenshot(page, name) {
    try {
        const filename = `debug_${name}.png`;
        await page.screenshot({ path: resolvePath(filename) });
        writeLog(`已保存调试截图: ${filename}`);
    } catch (e) {
        writeLog(`截图失败: ${e.message}`);
    }
}

// 检查并创建锁
function acquireLock() {
    if (fs.existsSync(LOCK_PATH)) {
        // 检查锁文件时间，防止死锁
        const stats = fs.statSync(LOCK_PATH);
        const now = new Date().getTime();
        const lockTime = stats.mtime.getTime();
        // 如果锁文件超过 15 分钟，认为上次任务已死，强制接管
        if (now - lockTime > 15 * 60 * 1000) {
            writeLog('警告：检测到过期的锁文件，强制删除并继续...');
            deleteFileIfExists('task.lock');
        } else {
            return false; // 锁有效，任务正在运行
        }
    }
    fs.writeFileSync(LOCK_PATH, 'LOCKED');
    return true;
}

// 释放锁
function releaseLock() {
    deleteFileIfExists('task.lock');
}

(async () => {
    // 0. 检查锁，防止多开
    if (!acquireLock()) {
        writeLog('>>> 任务正在运行中，本次跳过 (Lock exists)');
        return;
    }

    try {
        writeLog('>>> 任务启动...');

        // ✅ 新增步骤：先确保有网再往下跑
        const isOnline = await waitForInternet();
        if (!isOnline) {
            throw new Error('网络连接超时 (60s)，无法连接互联网，任务终止');
        }

        // 1. 读取配置
        let config;
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            } else {
                throw new Error('找不到配置文件 config.json');
            }
        } catch (e) {
            writeLog(`配置读取失败: ${e.message}`);
            return;
        }

        // 2. 检查凭证
        if (!fs.existsSync(AUTH_PATH)) {
            writeLog('找不到 auth.json，请先登录');
            return;
        }

        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const context = await browser.newContext({
            storageState: AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true // ✅ 新增：强制忽略证书错误，解决 ERR_CERT 问题
        });

        const page = await context.newPage();

        try {
            writeLog('>>> 正在加载首页...');

            // ✅ 修改：增加重试机制的页面跳转
            // 如果第一次因为网络波动挂了，等5秒再试一次
            try {
                await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (navError) {
                writeLog('⚠️ 第一次加载失败，等待 5 秒重试...');
                await page.waitForTimeout(5000);
                await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            }

            // 等待页面基本结构出现
            try {
                await page.waitForSelector('#root', { timeout: 15000 });
            } catch(e) {
                writeLog('等待 #root 超时，尝试继续...');
            }

            await page.waitForTimeout(5000);
            await takeScreenshot(page, '1_home_loaded');

            // 清理遮挡
            writeLog('>>> 尝试清理弹窗...');
            await page.evaluate(() => {
                const mask = document.getElementById('douyin-web-recommend-guide-mask');
                if (mask) mask.remove();
                const dialogs = document.querySelectorAll('[role="dialog"], .semi-modal-mask, .login-mask');
                dialogs.forEach(el => el.remove());
                const closeBtn = document.querySelector('.dy-account-close');
                if (closeBtn) closeBtn.click();
            });

            // 进入私信
            writeLog('>>> 尝试点击私信/消息...');
            const selectors = [
                '[data-e2e="message-entry"]',
                'text="私信"',
                'text="消息"',
                'li:has-text("私信")',
                'li:has-text("消息")'
            ];

            let entered = false;
            for (const sel of selectors) {
                try {
                    const el = page.locator(sel).first();
                    if (await el.isVisible()) {
                        writeLog(`找到入口并点击: ${sel}`);
                        await el.click({ force: true });
                        entered = true;
                        break;
                    }
                } catch (e) {}
            }

            if (!entered) {
                const content = await page.content();
                if (content.includes('登录')) {
                    writeLog('警告：页面检测到“登录”字样，可能凭证已失效');
                }
                throw new Error('未找到“私信”或“消息”入口');
            }

            await page.waitForTimeout(5000);
            await takeScreenshot(page, '2_message_page');

            const friendName = config.friendName;
            writeLog(`>>> 正在查找好友: ${friendName}`);

            try {
                await page.waitForSelector(`text=${friendName}`, { timeout: 10000 });
                await page.getByText(friendName).first().click({ force: true });
                writeLog(`已点击好友: ${friendName}`);
            } catch (e) {
                writeLog(`未在列表中直接找到好友，尝试截图记录...`);
                await takeScreenshot(page, '3_friend_not_found');
                throw new Error(`找不到好友 "${friendName}"`);
            }

            await page.waitForTimeout(3000);

            // 输入
            writeLog('>>> 正在定位输入框...');
            const editorSelectors = [
                '.public-DraftStyleDefault-block',
                '[contenteditable="true"]',
                '.DraftEditor-root'
            ];

            let editorFound = false;
            for (const sel of editorSelectors) {
                const el = page.locator(sel).first();
                if (await el.isVisible()) {
                    await el.click({ force: true });
                    // 清空内容
                    await page.keyboard.press('Control+A');
                    await page.keyboard.press('Backspace');
                    editorFound = true;
                    break;
                }
            }

            if (!editorFound) throw new Error('找不到输入框');

            const message = '这是由伟大的mjc开发的解放双手自动续火花脚本工具';
            // 降低打字速度，防止被检测
            await page.keyboard.type(message, { delay: 100 });

            writeLog('>>> 内容已输入，等待网页响应...');
            await page.waitForTimeout(2000);

            // 发送策略
            writeLog('>>> 执行发送策略...');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1000);

            const sendBtn = page.getByText('发送', { exact: true });

            await page.evaluate(() => {
                const mask = document.getElementById('douyin-web-recommend-guide-mask');
                if (mask) mask.remove();
            });

            if (await sendBtn.isVisible()) {
                await sendBtn.click({ force: true });
            }

            // 验证
            try {
                await page.waitForSelector(`text=${message}`, { timeout: 5000 });
                writeLog('>>> ✅ 检测到消息已上屏，发送成功！');
            } catch (e) {
                writeLog('>>> ⚠️ 警告：未在聊天区检测到发送的消息，可能发送失败');
                await takeScreenshot(page, 'send_failed_check');
            }

            await page.waitForTimeout(2000);
            await takeScreenshot(page, '4_after_send');

            // 成功逻辑
            writeLog('任务执行成功');
            deleteFileIfExists('final_success.png');
            deleteFileIfExists('final_error.png');

        } catch (error) {
            writeLog(`运行出错: ${error.message}`);
            try {
                writeLog(`当前 URL: ${page.url()}`);
                await page.screenshot({ path: resolvePath('final_error.png'), fullPage: true });
                writeLog('已保存错误截图: final_error.png');
            } catch (screenshotError) {
                writeLog(`保存错误截图失败: ${screenshotError.message}`);
            }
        } finally {
            await browser.close();
            writeLog('>>> 进程结束\n');
        }
    } catch (err) {
        writeLog(`严重错误: ${err.message}`);
    } finally {
        releaseLock();
    }
})();