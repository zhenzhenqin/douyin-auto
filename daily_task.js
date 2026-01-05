// daily_task.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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
        // 检查锁文件时间，防止死锁（例如上次崩溃没删掉）
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
                '--no-sandbox', // 增加稳定性
                '--disable-dev-shm-usage' // 防止内存不足崩溃
            ]
        });

        const context = await browser.newContext({
            storageState: AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();

        try {
            writeLog('>>> 正在加载首页...');
            // 修改：不再等待 networkidle，因为抖音视频流会一直加载导致超时
            // 改为等待 domcontentloaded，然后手动等待关键元素
            await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // 等待页面基本结构出现，证明加载成功
            try {
                await page.waitForSelector('#root', { timeout: 15000 }); 
            } catch(e) {
                writeLog('等待 #root 超时，尝试继续...');
            }
            
            await page.waitForTimeout(5000); // 额外等待几秒让脚本加载
            
            // 截图：首页加载情况
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
                 // 检查是否未登录
                 const content = await page.content();
                 if (content.includes('登录')) {
                     writeLog('警告：页面检测到“登录”字样，可能凭证已失效');
                 }
                 throw new Error('未找到“私信”或“消息”入口');
            }

            await page.waitForTimeout(5000); // 等待私信页面加载
            await takeScreenshot(page, '2_message_page');

            const friendName = config.friendName;
            writeLog(`>>> 正在查找好友: ${friendName}`);

            try {
                // 显式等待好友名字出现，最多等 10 秒
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
            // 1. 定位并聚焦输入框
            const editorSelectors = [
                '.public-DraftStyleDefault-block',
                '[contenteditable="true"]',
                '.DraftEditor-root'
            ];

            let editorFound = false;
            for (const sel of editorSelectors) {
                const el = page.locator(sel).first();
                if (await el.isVisible()) {
                    // 先点击聚焦
                    await el.click({ force: true });
                    // 清空可能存在的旧内容 (全选+删除)
                    await page.keyboard.press('Control+A');
                    await page.keyboard.press('Backspace');
                    editorFound = true;
                    break;
                }
            }

            if (!editorFound) throw new Error('找不到输入框');

            // 2. 输入内容 (打字慢一点，更容易被识别)
            const message = '这是由伟大的mjc开发的解放双手自动续火花脚本工具';
            await page.keyboard.type(message, { delay: 100 }); // 每个字间隔100ms

            writeLog('>>> 内容已输入，等待网页响应...');
            await page.waitForTimeout(2000); // 关键等待：让网页React反应过来按钮该变亮了

            // 3. 双重发送策略 (先回车，后点击)
            writeLog('>>> 执行发送策略...');

            // 策略A: 键盘回车 (最稳妥的方式)
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1000);

            // 策略B: 尝试点击发送按钮 (作为补刀)
            // 只有当聊天记录里没出现新消息时，才去点按钮，或者干脆不管它直接点
            const sendBtn = page.getByText('发送', { exact: true });

            // 清理遮罩防止点不到
            await page.evaluate(() => {
                const mask = document.getElementById('douyin-web-recommend-guide-mask');
                if (mask) mask.remove();
            });

            if (await sendBtn.isVisible()) {
                // 不管按钮是不是灰的，尝试点一下，反正没坏处
                // 此时已经按过回车了，如果回车生效了，点这一下也无妨
                await sendBtn.click({ force: true });
            }

            // 4. 验证是否发送成功 (检查聊天记录里有没有刚才发的话)
            // 这一步非常重要，能告诉你到底发出去没
            try {
                // 等待刚才发的消息出现在屏幕上
                await page.waitForSelector(`text=${message}`, { timeout: 5000 });
                writeLog('>>>检测到消息已上屏，发送成功！');
            } catch (e) {
                writeLog('>>> 警告：未在聊天区检测到发送的消息，可能发送失败');
                // 截图留证
                await takeScreenshot(page, 'send_failed_check');
            }

            await page.waitForTimeout(2000);
            await takeScreenshot(page, '4_after_send');

            // -----------------------------------------------------
            // 成功处理逻辑
            // -----------------------------------------------------
            writeLog('任务执行成功');

            // 删除旧的截图，保持文件夹干净
            deleteFileIfExists('final_success.png');
            deleteFileIfExists('final_error.png');
            
        } catch (error) {
            // -----------------------------------------------------
            // 失败处理逻辑
            // -----------------------------------------------------
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
        // 释放锁
        releaseLock();
    }
})();
