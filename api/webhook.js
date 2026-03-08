import { getAccessToken, sendMessage, downloadImage } from '../lib/feishu.js';
import { verifyScreenshot } from '../lib/gemini.js';
import { getState, updateState, getDefaultState } from '../lib/state.js';

// 事件去重
const processedEvents = new Set();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;

  // 飞书 URL 验证（配置 webhook 时的验证请求）
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 处理 v2 schema 事件
  if (body.schema === '2.0') {
    const eventId = body.header?.event_id;

    // 去重检查
    if (eventId && processedEvents.has(eventId)) {
      return res.status(200).json({ code: 0 });
    }
    if (eventId) {
      processedEvents.add(eventId);
      // 防止内存泄漏，最多保留 100 个
      if (processedEvents.size > 100) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
      }
    }

    try {
      await handleEvent(body);
    } catch (err) {
      console.error('处理事件出错:', err);
    }

    return res.status(200).json({ code: 0 });
  }

  return res.status(200).json({ code: 0 });
}

async function handleEvent(body) {
  const eventType = body.header?.event_type;
  if (eventType === 'im.message.receive_v1') {
    await handleMessage(body.event);
  }
}

async function handleMessage(event) {
  const message = event.message;
  const sender = event.sender;
  const openId = sender.sender_id.open_id;

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const accessToken = await getAccessToken(appId, appSecret);

  // 只处理图片消息
  if (message.message_type !== 'image') {
    // 文字消息：回复当前打卡状态
    const statusText = await getStatusText();
    await sendMessage(accessToken, openId, 'text', JSON.stringify({
      text: statusText + '\n\n请发送打卡截图（图片）给我审核。',
    }));
    return;
  }

  // 解析图片 key
  const content = JSON.parse(message.content);
  const imageKey = content.image_key;

  if (!imageKey) {
    await sendMessage(accessToken, openId, 'text', JSON.stringify({
      text: '无法获取图片，请重新发送。',
    }));
    return;
  }

  // 获取打卡状态
  const githubToken = process.env.GH_PAT;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  let { state, sha } = await getState(githubToken, owner, repo);

  // 新的一天，重置状态
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (state.date !== today) {
    state = getDefaultState();
  }

  // 判断该审核哪个时段
  const targetPeriod = determineTargetPeriod(state);

  if (!targetPeriod) {
    await sendMessage(accessToken, openId, 'text', JSON.stringify({
      text: '今天的打卡已经全部完成了！不用再发截图了。',
    }));
    return;
  }

  // 下载图片
  await sendMessage(accessToken, openId, 'text', JSON.stringify({
    text: '正在审核截图，请稍候...',
  }));

  const imageBuffer = await downloadImage(accessToken, message.message_id, imageKey);

  // 调用 Gemini 审核截图
  const geminiKey = process.env.GEMINI_API_KEY;
  const result = await verifyScreenshot(geminiKey, imageBuffer, targetPeriod);

  const periodName = targetPeriod === 'noon' ? '中午' : '晚上';

  if (result.isValid) {
    // 审核通过，更新状态
    state[targetPeriod] = {
      verified: true,
      verifiedAt: new Date().toISOString(),
      screenshotTime: result.time,
    };

    await updateState(githubToken, owner, repo, state, sha);

    const bothDone = state.noon.verified && state.evening.verified;
    let replyText = `${periodName}打卡审核通过！\n截图时间：${result.time}`;
    if (bothDone) {
      replyText += '\n\n今天的打卡任务全部完成！';
    } else {
      const remaining = !state.noon.verified ? '中午' : '晚上';
      replyText += `\n\n还需要完成${remaining}的打卡。`;
    }

    await sendMessage(accessToken, openId, 'text', JSON.stringify({ text: replyText }));
  } else {
    await sendMessage(accessToken, openId, 'text', JSON.stringify({
      text: `${periodName}打卡审核未通过\n原因：${result.reason}\n\n请重新截图发送。`,
    }));
  }
}

// 判断当前应该审核哪个时段
function determineTargetPeriod(state) {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false,
  }));

  // 优先判断当前时段
  if (hour >= 12 && hour < 19) {
    // 中午时段或中午之后、晚上之前
    if (!state.noon.verified) return 'noon';
    if (!state.evening.verified) return 'evening';
  } else if (hour >= 19) {
    // 晚上时段
    if (!state.evening.verified) return 'evening';
    if (!state.noon.verified) return 'noon';
  } else {
    // 凌晨到中午前
    if (!state.noon.verified) return 'noon';
    if (!state.evening.verified) return 'evening';
  }

  return null; // 全部完成
}

// 获取当前打卡状态文字
async function getStatusText() {
  try {
    const githubToken = process.env.GH_PAT;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    let { state } = await getState(githubToken, owner, repo);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    if (state.date !== today) {
      state = getDefaultState();
    }

    const noonStatus = state.noon.verified
      ? `已完成 (${state.noon.screenshotTime})`
      : '未完成';
    const eveningStatus = state.evening.verified
      ? `已完成 (${state.evening.screenshotTime})`
      : '未完成';

    return `今日打卡状态 (${today})：\n中午：${noonStatus}\n晚上：${eveningStatus}`;
  } catch (e) {
    return '无法获取打卡状态';
  }
}
