// 由 GitHub Actions 定时调用，检查打卡状态并通过飞书提醒
import { getAccessToken, sendMessage, urgentApp, urgentSms, urgentPhone } from '../lib/feishu.js';
import { getState, updateState, getDefaultState, getPeriodToRemind, getEscalationLevel } from '../lib/state.js';

async function main() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const githubToken = process.env.GH_PAT;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const userId = process.env.FEISHU_USER_OPEN_ID;

  // 判断当前时段
  const period = getPeriodToRemind();
  if (!period) {
    console.log('当前不在打卡时段，跳过。');
    return;
  }

  // 获取打卡状态
  let { state, sha } = await getState(githubToken, owner, repo);

  // 新的一天，重置状态
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (state.date !== today) {
    console.log(`新的一天 (${today})，重置打卡状态。`);
    state = getDefaultState();
    const result = await updateState(githubToken, owner, repo, state, sha);
    sha = result?.content?.sha || sha;
  }

  // 已打卡则跳过
  if (state[period].verified) {
    console.log(`${period} 已打卡，跳过。`);
    return;
  }

  // 计算催促等级
  const level = getEscalationLevel(period);
  const periodName = period === 'noon' ? '中午' : '晚上';

  const accessToken = await getAccessToken(appId, appSecret);

  // 根据催促等级构造消息
  const messages = {
    1: `提醒：${periodName}打卡时间到了，请尽快完成打卡并把截图发给我。`,
    2: `再次提醒：${periodName}打卡还未完成！已经过了半小时了，请尽快打卡！`,
    3: `紧急提醒：${periodName}打卡还未完成！时间已经不多了，请立即打卡！`,
    4: `最后警告：${periodName}打卡即将截止！请立刻打卡并发送截图！`,
  };

  const messageText = messages[level] || messages[1];

  // 发送消息
  const msgResult = await sendMessage(
    accessToken, userId, 'text',
    JSON.stringify({ text: messageText })
  );

  const messageId = msgResult?.data?.message_id;
  console.log(`已发送 ${periodName} 提醒 (等级 ${level})，message_id: ${messageId}`);

  // 根据等级逐步加急
  if (messageId && level >= 2) {
    try {
      await urgentApp(accessToken, messageId, [userId]);
      console.log('已应用：应用内加急');

      if (level >= 3) {
        await urgentSms(accessToken, messageId, [userId]);
        console.log('已应用：短信加急');
      }

      if (level >= 4) {
        await urgentPhone(accessToken, messageId, [userId]);
        console.log('已应用：电话加急');
      }
    } catch (err) {
      console.error('加急操作失败:', err.message);
    }
  }
}

main().catch((err) => {
  console.error('提醒脚本执行失败:', err);
  process.exit(1);
});
