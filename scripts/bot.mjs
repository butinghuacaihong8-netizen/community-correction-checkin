// 飞书长连接机器人 - 本地运行，处理消息和打卡审核
import { ProxyAgent, setGlobalDispatcher } from 'undici';
// 设置全局代理，让 fetch 走代理访问 Google API
const PROXY_URL = 'http://127.0.0.1:7897';
setGlobalDispatcher(new ProxyAgent(PROXY_URL));

import * as lark from '@larksuiteoapi/node-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ===== 加载 .env 文件 =====
try {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

// ===== 配置 =====
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GH_PAT = process.env.GH_PAT;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;

if (!APP_ID || !APP_SECRET) {
  console.error('请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量，或创建 .env 文件');
  process.exit(1);
}

// ===== 飞书客户端 =====
const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

// ===== 事件去重 =====
const processedEvents = new Set();

// ===== 状态管理（本地文件 + GitHub 同步） =====
const STATE_FILE = path.join(PROJECT_ROOT, 'reminders/community-correction/state.json');
const USER_CONFIG_FILE = path.join(PROJECT_ROOT, 'reminders/community-correction/user-config.json');

function readLocalState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return getDefaultState();
  }
}

function writeLocalState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function getDefaultState() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return {
    date: today,
    noon: { verified: false, verifiedAt: null, screenshotTime: null },
    evening: { verified: false, verifiedAt: null, screenshotTime: null },
  };
}

// 保存用户 open_id（自动发现）
function saveUserOpenId(openId) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf-8'));
  } catch {}

  if (config.openId === openId) return; // 已保存

  config.openId = openId;
  config.discoveredAt = new Date().toISOString();
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  console.log(`[INFO] 用户 Open ID 已保存: ${openId}`);

  // 同步到 GitHub repo（用于 remind.js 读取）
  syncUserConfigToGitHub(config).catch(err => {
    console.error('[WARN] 同步 user-config 到 GitHub 失败:', err.message);
  });

  // 同时添加为 GitHub Actions secret
  addGitHubSecret('FEISHU_USER_OPEN_ID', openId).catch(err => {
    console.error('[WARN] 添加 FEISHU_USER_OPEN_ID secret 失败:', err.message);
  });
}

async function syncUserConfigToGitHub(config) {
  const filePath = 'reminders/community-correction/user-config.json';
  const content = Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64');

  // 先获取现有文件的 sha
  let sha = null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
      { headers: { 'Authorization': `token ${GH_PAT}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (res.ok) {
      const data = await res.json();
      sha = data.sha;
    }
  } catch {}

  const body = { message: '自动保存用户 Open ID', content };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  console.log('[INFO] user-config.json 已同步到 GitHub');
}

async function addGitHubSecret(name, value) {
  // 获取 repo public key
  const keyRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/secrets/public-key`,
    { headers: { 'Authorization': `token ${GH_PAT}` } }
  );
  const { key, key_id } = await keyRes.json();

  // 使用 libsodium 加密
  const sodium = await import('libsodium-wrappers');
  await sodium.default.ready;
  const keyBytes = sodium.default.from_base64(key, sodium.default.base64_variants.ORIGINAL);
  const secretBytes = sodium.default.from_string(value);
  const encryptedBytes = sodium.default.crypto_box_seal(secretBytes, keyBytes);
  const encrypted = sodium.default.to_base64(encryptedBytes, sodium.default.base64_variants.ORIGINAL);

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/secrets/${name}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encrypted_value: encrypted, key_id }),
    }
  );

  if (res.status === 201 || res.status === 204) {
    console.log(`[INFO] GitHub secret ${name} 已设置`);
  } else {
    throw new Error(`设置 secret 失败: ${res.status}`);
  }
}

// ===== GitHub state 同步 =====
async function syncStateToGitHub(state) {
  const filePath = 'reminders/community-correction/state.json';
  const content = Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64');

  let sha = null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
      { headers: { 'Authorization': `token ${GH_PAT}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (res.ok) {
      const data = await res.json();
      sha = data.sha;
    }
  } catch {}

  const body = { message: `更新打卡状态 ${state.date}`, content };
  if (sha) body.sha = sha;

  await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

// ===== 发送消息 =====
async function sendMessage(openId, text) {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (err) {
    console.error('[ERROR] 发送消息失败:', err.message);
  }
}

// ===== 下载图片 =====
async function downloadImage(messageId, imageKey) {
  const res = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: 'image' },
  });

  // SDK v1.x 可能返回 { writeFile } 或 Readable stream 或直接是 Buffer
  if (Buffer.isBuffer(res)) return res;
  if (res instanceof ArrayBuffer) return Buffer.from(res);

  // SDK 可能返回一个带 writeFile 方法的对象，需要用另一种方式获取
  // 尝试用 stream/pipeline 方式
  if (res && typeof res.pipe === 'function') {
    const { Writable } = await import('stream');
    const chunks = [];
    return new Promise((resolve, reject) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  }

  // 如果 res 有 data 属性
  if (res && res.data) {
    if (Buffer.isBuffer(res.data)) return res.data;
    if (typeof res.data.pipe === 'function') {
      const chunks = [];
      return new Promise((resolve, reject) => {
        res.data.on('data', (chunk) => chunks.push(chunk));
        res.data.on('end', () => resolve(Buffer.concat(chunks)));
        res.data.on('error', reject);
      });
    }
  }

  // 如果 res 有 writeFile 方法，用临时文件
  if (res && typeof res.writeFile === 'function') {
    const tmpPath = path.join(PROJECT_ROOT, '.tmp-image.png');
    await res.writeFile(tmpPath);
    const buf = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return buf;
  }

  throw new Error(`无法处理 SDK 返回类型: ${res?.constructor?.name}, keys: ${res ? Object.keys(res) : 'null'}`);
}

// ===== Gemini 截图审核 =====
async function verifyScreenshot(imageBuffer, period) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const periodText = period === 'noon'
    ? '中午（12:00 - 15:00）'
    : '晚上（19:00 - 22:00）';

  const prompt = `你是社区矫正打卡审核员。请分析这张截图，判断是否为有效的社区矫正打卡截图。

请检查：
1. 截图中是否能看到打卡时间？时间是什么？
2. 打卡时间是否在 ${periodText} 时段内？
3. 是否显示打卡成功？

请严格以如下 JSON 格式回复（不要包含 markdown 代码块标记）：
{
  "isValid": true或false,
  "time": "截图中显示的时间，如 2026-03-08 12:30",
  "reason": "判断理由",
  "hasTime": true或false,
  "isSuccess": true或false
}`;

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: 'image/png',
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[ERROR] 解析 Gemini 响应失败:', e.message);
  }

  return { isValid: false, time: null, reason: '无法解析审核结果，请重新发送截图' };
}

// ===== 判断当前应审核哪个时段 =====
function determineTargetPeriod(state) {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false,
  }));

  if (hour >= 12 && hour < 19) {
    if (!state.noon.verified) return 'noon';
    if (!state.evening.verified) return 'evening';
  } else if (hour >= 19) {
    if (!state.evening.verified) return 'evening';
    if (!state.noon.verified) return 'noon';
  } else {
    if (!state.noon.verified) return 'noon';
    if (!state.evening.verified) return 'evening';
  }
  return null;
}

// ===== 消息处理 =====
async function handleMessage(data) {
  const message = data.message;
  const sender = data.sender;
  const openId = sender.sender_id.open_id;

  console.log(`[MSG] 收到消息 from ${openId}, type=${message.message_type}`);

  // 自动保存用户 open_id
  saveUserOpenId(openId);

  // 读取/初始化今日状态
  let state = readLocalState();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (state.date !== today) {
    state = getDefaultState();
    writeLocalState(state);
  }

  // 处理文字消息：返回状态
  if (message.message_type !== 'image') {
    const noonStatus = state.noon.verified
      ? `已完成 (${state.noon.screenshotTime})` : '未完成';
    const eveningStatus = state.evening.verified
      ? `已完成 (${state.evening.screenshotTime})` : '未完成';

    await sendMessage(openId,
      `今日打卡状态 (${today})：\n中午：${noonStatus}\n晚上：${eveningStatus}\n\n请发送打卡截图（图片）给我审核。`
    );
    return;
  }

  // 处理图片消息
  const targetPeriod = determineTargetPeriod(state);

  if (!targetPeriod) {
    await sendMessage(openId, '今天的打卡已经全部完成了！不用再发截图了。');
    return;
  }

  const periodName = targetPeriod === 'noon' ? '中午' : '晚上';
  await sendMessage(openId, `正在审核${periodName}打卡截图，请稍候...`);

  try {
    // 解析图片 key
    const content = JSON.parse(message.content);
    const imageKey = content.image_key;

    if (!imageKey) {
      await sendMessage(openId, '无法获取图片，请重新发送。');
      return;
    }

    // 下载图片
    const imageBuffer = await downloadImage(message.message_id, imageKey);
    console.log(`[INFO] 图片已下载, size=${imageBuffer.length} bytes`);

    // Gemini 审核
    const result = await verifyScreenshot(imageBuffer, targetPeriod);
    console.log(`[INFO] 审核结果:`, result);

    if (result.isValid) {
      // 审核通过
      state[targetPeriod] = {
        verified: true,
        verifiedAt: new Date().toISOString(),
        screenshotTime: result.time,
      };

      writeLocalState(state);
      syncStateToGitHub(state).catch(err =>
        console.error('[WARN] 同步状态到 GitHub 失败:', err.message)
      );

      const bothDone = state.noon.verified && state.evening.verified;
      let replyText = `${periodName}打卡审核通过！\n截图时间：${result.time}`;
      if (bothDone) {
        replyText += '\n\n今天的打卡任务全部完成！';
      } else {
        const remaining = !state.noon.verified ? '中午' : '晚上';
        replyText += `\n\n还需要完成${remaining}的打卡。`;
      }
      await sendMessage(openId, replyText);
    } else {
      await sendMessage(openId,
        `${periodName}打卡审核未通过\n原因：${result.reason}\n\n请重新截图发送。`
      );
    }
  } catch (err) {
    console.error('[ERROR] 处理图片消息失败:', err);
    await sendMessage(openId, `处理出错：${err.message}\n请稍后重试。`);
  }
}

// ===== 启动长连接 =====
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      // 事件去重
      const eventId = data.event_id || `${data.message?.message_id}`;
      if (processedEvents.has(eventId)) return;
      processedEvents.add(eventId);
      if (processedEvents.size > 200) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
      }

      try {
        await handleMessage(data);
      } catch (err) {
        console.error('[ERROR] 处理消息异常:', err);
      }
    },
  }),
});

console.log('========================================');
console.log('  打卡监督机器人已启动（长连接模式）');
console.log('  等待用户发送消息...');
console.log('========================================');
