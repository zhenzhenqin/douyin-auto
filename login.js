// login.js
const { chromium } = require('playwright');

(async () => {
    // 1. 启动有界面的浏览器
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 2. 打开抖音
    await page.goto('https://www.douyin.com/');

    console.log('>>> 请在浏览器中手动扫码登录...');
    console.log('>>> 登录成功后，脚本会自动保存状态并退出');

    // 3. 等待登录成功的标志
    // 这里我们检测你的头像元素出现，或者简单点：等待 URL 不再是登录页
    // 为了稳妥，这里设置一个长等待，登录完你可以手动关闭，或者等脚本检测
    // 更好的方式是检测某个只有登录后才有的元素，比如 "消息" 按钮
    try {
        // 等待页面上出现 "我的" 或者 "消息" 相关的特定文字/元素
        // 注意：这里的等待时间可以设置长一点
        await page.waitForURL('**', { timeout: 0 }); // 你手动登录，直到你满意为止

        // 你可以在控制台按 Ctrl+C 结束，或者我们加个手动确认逻辑
        // 为了演示简单，建议你登录后，在控制台看下一步提示，或者我们硬性等待 60秒
        await page.waitForTimeout(60000);

    } catch (e) {
        // 忽略等待超时
    }

    // 4. 保存登录状态 (Cookies, LocalStorage 等)
    await context.storageState({ path: 'auth.json' });
    console.log('>>> 登录状态已保存到 auth.json');

    await browser.close();
})();