// 由 GitHub Actions 定时调用
// 功能：1) 检查用户是否发了打卡截图并审核  2) 未打卡则发加急提醒
import { getAccessToken, sendMessage, urgentApp, listMessages, downloadImage } from '../lib/feishu.js';
import { getState, updateState, getDefaultState, getCurrentPeriod } from '../lib/state.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GITHUB_API = 'https://api.github.com';

// ===== 读取/保存 user-config（含 chatId） =====
async function getUserConfig(githubToken, owner, repo) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/reminders/community-correction/user-config.json`,
      { headers: { 'Authorization': `token ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const config = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
      return { config, sha: data.sha };
    }
  } catch {}
  return { config: {}, sha: null };
}

async function saveUserConfig(githubToken, owner, repo, config, sha) {
  const content = Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64');
  const body = { message: '更新 user-config', content };
  if (sha) body.sha = sha;

  await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/reminders/community-correction/user-config.json`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

// ===== Gemini 截图审核 =====
async function verifyScreenshot(geminiKey, imageBuffer, period) {
  const genAI = new GoogleGenerativeAI(geminiKey);
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

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } },
  ]);
  const text = result.response.text();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return { isValid: false, time: null, reason: '无法解析审核结果，请重新发送截图' };
}

// ===== 主流程 =====
async function main() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const geminiKey = process.env.GEMINI_API_KEY;
  const githubToken = process.env.GH_PAT;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  // 1. 获取用户配置
  const { config: userConfig, sha: configSha } = await getUserConfig(githubToken, owner, repo);
  const userId = process.env.FEISHU_USER_OPEN_ID || userConfig.openId;

  if (!userId) {
    console.log('未找到用户 Open ID，跳过。');
    return;
  }

  // 2. 判断当前时段
  const period = getCurrentPeriod();
  if (!period) {
    console.log('当前不在打卡时段，跳过。');
    return;
  }

  // 3. 获取打卡状态
  let { state, sha } = await getState(githubToken, owner, repo);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (state.date !== today) {
    console.log(`新的一天 (${today})，重置打卡状态。`);
    state = getDefaultState();
    const result = await updateState(githubToken, owner, repo, state, sha);
    sha = result?.content?.sha || sha;
  }

  if (state[period].verified) {
    console.log(`${period} 已打卡，跳过。`);
    return;
  }

  const accessToken = await getAccessToken(appId, appSecret);
  const periodName = period === 'noon' ? '中午' : '晚上';

  // 4. 获取/建立 chatId
  let chatId = userConfig.chatId || null;

  if (!chatId) {
    // 发一条消息来获取 chatId
    const initMsg = await sendMessage(accessToken, userId, 'text',
      JSON.stringify({ text: '打卡监督系统已上线，请在打卡后发送截图给我审核。' }));
    chatId = initMsg?.data?.chat_id;

    if (chatId) {
      userConfig.chatId = chatId;
      await saveUserConfig(githubToken, owner, repo, userConfig, configSha);
      console.log(`chatId 已保存: ${chatId}`);
    }
  }

  // 5. 检查是否有新的打卡截图
  if (chatId) {
    const screenshotProcessed = await checkAndProcessScreenshots(
      accessToken, geminiKey, chatId, userId, period, periodName,
      state, sha, userConfig, githubToken, owner, repo
    );
    if (screenshotProcessed) return; // 审核通过，不需要再提醒
  }

  // 6. 未打卡，发送加急提醒
  const messageText = `【加急提醒】${periodName}打卡还未完成！请立即打卡并把截图发给我！`;
  const msgResult = await sendMessage(accessToken, userId, 'text',
    JSON.stringify({ text: messageText }));

  // 保存 chatId（如果之前没有）
  if (!chatId && msgResult?.data?.chat_id) {
    userConfig.chatId = msgResult.data.chat_id;
    await saveUserConfig(githubToken, owner, repo, userConfig, configSha);
  }

  const messageId = msgResult?.data?.message_id;
  console.log(`已发送 ${periodName} 加急提醒`);

  if (messageId) {
    try {
      await urgentApp(accessToken, messageId, [userId]);
      console.log('已应用：应用内加急');
    } catch (err) {
      console.error('加急操作失败:', err.message);
    }
  }
}

// ===== 检查并处理截图 =====
async function checkAndProcessScreenshots(
  accessToken, geminiKey, chatId, userId, period, periodName,
  state, sha, userConfig, githubToken, owner, repo
) {
  // 拉取最近 15 分钟的消息
  const startTime = Math.floor((Date.now() - 15 * 60 * 1000) / 1000).toString();
  const msgResult = await listMessages(accessToken, chatId, startTime);

  if (!msgResult?.data?.items?.length) {
    console.log('最近 15 分钟无新消息。');
    return false;
  }

  // 过滤：用户发的图片消息，排除已处理的
  const lastProcessedTime = state.lastProcessedTime || '0';
  const imageMessages = msgResult.data.items.filter(msg =>
    msg.msg_type === 'image' &&
    msg.sender?.sender_type === 'user' &&
    msg.create_time > lastProcessedTime
  );

  if (!imageMessages.length) {
    console.log('无新的图片消息。');
    return false;
  }

  // 处理最新一张图片
  const latestImage = imageMessages[imageMessages.length - 1];
  console.log(`发现用户图片消息, message_id=${latestImage.message_id}`);

  let content;
  try {
    content = JSON.parse(latestImage.content);
  } catch {
    console.error('解析图片消息内容失败');
    return false;
  }

  const imageKey = content.image_key;
  if (!imageKey) return false;

  // 通知用户正在审核
  await sendMessage(accessToken, userId, 'text',
    JSON.stringify({ text: `正在审核${periodName}打卡截图，请稍候...` }));

  try {
    // 下载图片
    const imageBuffer = await downloadImage(accessToken, latestImage.message_id, imageKey);
    console.log(`图片已下载, size=${imageBuffer.length} bytes`);

    // Gemini 审核
    const result = await verifyScreenshot(geminiKey, imageBuffer, period);
    console.log('审核结果:', result);

    // 记录已处理的消息时间
    state.lastProcessedTime = latestImage.create_time;

    if (result.isValid) {
      // 审核通过
      state[period] = {
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
      await sendMessage(accessToken, userId, 'text', JSON.stringify({ text: replyText }));
      console.log(`${periodName}打卡审核通过`);
      return true;
    } else {
      // 审核未通过
      await updateState(githubToken, owner, repo, state, sha);
      await sendMessage(accessToken, userId, 'text',
        JSON.stringify({ text: `${periodName}打卡审核未通过\n原因：${result.reason}\n\n请重新截图发送。` }));
      console.log(`审核未通过: ${result.reason}`);
      return false;
    }
  } catch (err) {
    console.error('截图审核失败:', err.message);
    await sendMessage(accessToken, userId, 'text',
      JSON.stringify({ text: `审核出错：${err.message}\n系统将在下次自动重试。` }));
    return false;
  }
}

main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
