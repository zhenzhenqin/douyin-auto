// daily_task.js - 批量群发版
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const resolvePath = (filename) => path.join(__dirname, filename);
const CONFIG_PATH = resolvePath('config.json');
const AUTH_PATH = resolvePath('auth.json');
const LOG_PATH = resolvePath('task_log.txt');
const LOCK_PATH = resolvePath('task.lock');
const MESSAGE_PATH = resolvePath('message.txt');

function writeLog(msg) {
    const time = new Date().toLocaleString();
    const logMsg = `[${time}] ${msg}`;
    console.log(logMsg);
    fs.appendFileSync(LOG_PATH, logMsg + '\n');
}

function deleteFileIfExists(filename) {
    try {
        if (fs.existsSync(resolvePath(filename))) fs.unlinkSync(resolvePath(filename));
    } catch (e) {}
}

async function waitForInternet() {
    writeLog('>>> 正在检查网络连接...');
    for (let i = 0; i < 12; i++) {
        try {
            execSync('ping www.baidu.com -n 1', { stdio: 'ignore' });
            writeLog('>>> 网络已连接');
            return true;
        } catch (e) {
            writeLog(`...等待网络恢复 (${i+1}/12)`);
            const start = Date.now();
            while (Date.now() - start < 5000) {}
        }
    }
    return false;
}

// 锁逻辑
function acquireLock() {
    if (fs.existsSync(LOCK_PATH)) {
        const stats = fs.statSync(LOCK_PATH);
        if (new Date().getTime() - stats.mtime.getTime() > 15 * 60 * 1000) {
            deleteFileIfExists('task.lock');
        } else {
            return false;
        }
    }
    fs.writeFileSync(LOCK_PATH, 'LOCKED');
    return true;
}
function releaseLock() { deleteFileIfExists('task.lock'); }

(async () => {
    if (!acquireLock()) {
        writeLog('>>> 任务正在运行中，本次跳过');
        return;
    }

    let browser; // 提升作用域以便 finally 关闭

    try {
        writeLog('========== 批量任务启动 ==========');

        const isOnline = await waitForInternet();
        if (!isOnline) throw new Error('无网络连接');

        // 1. 读取配置 (兼容新旧格式)
        let config;
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            } else {
                throw new Error('找不到配置文件');
            }
        } catch (e) { writeLog(e.message); return; }

        // 2. 读取消息内容
        let messageContent = '🔥'; // 默认值
        try {
            if (fs.existsSync(MESSAGE_PATH)) {
                messageContent = fs.readFileSync(MESSAGE_PATH, 'utf-8').trim();
                if (!messageContent) {
                    writeLog('⚠️ message.txt 为空，使用默认消息');
                    messageContent = '🔥';
                }
            } else {
                writeLog('⚠️ 找不到 message.txt，使用默认消息');
            }
        } catch (e) {
            writeLog(`读取消息文件失败: ${e.message}，使用默认消息`);
        }
        writeLog(`>>> 将发送消息: "${messageContent.substring(0, 20)}${messageContent.length > 20 ? '...' : ''}"`);

        // 获取好友列表：支持新版数组，也兼容旧版单人
        let friendList = [];
        if (config.friends && Array.isArray(config.friends)) {
            friendList = config.friends;
        } else if (config.friendName) {
            friendList = [{ name: config.friendName }];
        }

        if (friendList.length === 0) {
            writeLog(' 好友列表为空，请在 UI 中添加好友');
            return;
        }

        if (!fs.existsSync(AUTH_PATH)) { writeLog('无登录凭证'); return; }

        browser = await chromium.launch({
            headless: true, // 生产环境改为 true
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            storageState: AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();

        // ----------------------------------------------------
        // 核心循环逻辑：遍历每个好友
        // ----------------------------------------------------
        for (let i = 0; i < friendList.length; i++) {
            const friend = friendList[i];
            const friendName = friend.name;

            writeLog(`>>> [${i + 1}/${friendList.length}] 正在处理: ${friendName}`);

            try {
                // 每次处理一个好友前，先回到首页或刷新，保证状态干净
                // 增加重试机制
                try {
                    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
                } catch (navError) {
                    await page.waitForTimeout(3000);
                    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
                }

                await page.waitForTimeout(3000);

                // 清理弹窗
                await page.evaluate(() => {
                    const mask = document.getElementById('douyin-web-recommend-guide-mask');
                    if (mask) mask.remove();
                    const dialogs = document.querySelectorAll('[role="dialog"], .semi-modal-mask, .login-mask, .dy-account-close');
                    dialogs.forEach(el => el.remove());
                    const closeBtn = document.querySelector('.dy-account-close');
                    if (closeBtn) closeBtn.click();
                });

                // 进私信
                const messageEntry = page.getByText('私信', { exact: true }).first();
                if (await messageEntry.isVisible()) {
                    await messageEntry.click({ force: true });
                } else {
                    await page.getByText('消息').first().click({ force: true });
                }

                await page.waitForTimeout(3000);

                // 搜人
                try {
                    // 等待好友列表出现
                    await page.waitForSelector('.im-list-container', { timeout: 10000 }).catch(() => {});

                    // 点击好友
                    const friendEl = page.getByText(friendName).first();
                    await friendEl.waitFor({ state: 'visible', timeout: 8000 });
                    await friendEl.click({ force: true });
                } catch (e) {
                    throw new Error(`找不到好友 "${friendName}"，请检查昵称`);
                }

                await page.waitForTimeout(2000);

                // 找输入框
                const editorSelectors = ['.public-DraftStyleDefault-block', '[contenteditable="true"]', '.DraftEditor-root'];
                let editorFound = false;
                for (const sel of editorSelectors) {
                    const el = page.locator(sel).first();
                    if (await el.isVisible()) {
                        await el.click({ force: true });
                        await page.keyboard.press('Control+A');
                        await page.keyboard.press('Backspace');
                        editorFound = true;
                        break;
                    }
                }
                if (!editorFound) throw new Error('无法定位输入框');

                // 输入
                await page.keyboard.type(messageContent, { delay: 100 });
                await page.waitForTimeout(1500);

                // 发送
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1000);

                const sendBtn = page.getByText('发送', { exact: true });
                await page.evaluate(() => { // 清弹窗
                    const mask = document.getElementById('douyin-web-recommend-guide-mask');
                    if (mask) mask.remove();
                });
                if (await sendBtn.isVisible()) await sendBtn.click({ force: true });

                // 验证
                try {
                    // 验证消息是否上屏，只取前10个字符验证，防止太长匹配不到
                    const checkText = messageContent.substring(0, 10);
                    await page.waitForSelector(`text=${checkText}`, { timeout: 5000 });
                    writeLog(`✅ [${friendName}] 发送成功`);
                } catch (e) {
                    writeLog(`⚠️ [${friendName}] 未检测到消息上屏，可能失败`);
                    await page.screenshot({ path: resolvePath(`error_${friendName}.png`) });
                }

            } catch (err) {
                // 单个好友失败，不影响其他人，记录错误并继续
                writeLog(`[${friendName}] 失败: ${err.message}`);
                await page.screenshot({ path: resolvePath(`error_${friendName}.png`) });
            }

            // --- 间隔等待 ---
            // 如果不是最后一个人，随机等待 5-10秒，防止操作太快被风控
            if (i < friendList.length - 1) {
                const waitTime = Math.floor(Math.random() * 5000) + 5000;
                writeLog(`...随机休息 ${waitTime/1000} 秒...`);
                await page.waitForTimeout(waitTime);
            }
        }

        writeLog('========== 所有任务执行结束 ==========');
        deleteFileIfExists('final_error.png'); // 清理之前的全局错误图

    } catch (globalErr) {
        writeLog(`全局严重错误: ${globalErr.message}`);
        // 如果 page 还在，尝试截图
        // await page.screenshot({ path: resolvePath('final_error.png') }); 
    } finally {
        if (browser) await browser.close();
        writeLog('>>> 进程退出\n');
        releaseLock();
    }
})();
