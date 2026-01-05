const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const open = require('open');

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

app.listen(3000, () => {
    console.log('UI启动成功: http://localhost:3000');
    open('http://localhost:3000'); // 自动打开浏览器
});