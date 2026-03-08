const GITHUB_API = 'https://api.github.com';

export async function getState(token, owner, repo) {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/reminders/community-correction/state.json`,
    {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (!res.ok) {
    return { state: getDefaultState(), sha: null };
  }

  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { state: JSON.parse(content), sha: data.sha };
}

export async function updateState(token, owner, repo, newState, sha) {
  const content = Buffer.from(JSON.stringify(newState, null, 2)).toString('base64');

  const body = {
    message: `更新打卡状态 ${newState.date}`,
    content,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/reminders/community-correction/state.json`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  return await res.json();
}

export function getDefaultState() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return {
    date: today,
    noon: { verified: false, verifiedAt: null, screenshotTime: null },
    evening: { verified: false, verifiedAt: null, screenshotTime: null },
  };
}

// 获取当前北京时间的小时和分钟
function getBeijingTime() {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return { hour: beijing.getHours(), minute: beijing.getMinutes() };
}

// 判断当前处于哪个打卡时段
export function getCurrentPeriod() {
  const { hour } = getBeijingTime();
  if (hour >= 12 && hour < 15) return 'noon';
  if (hour >= 19 && hour < 22) return 'evening';
  return null;
}

// 判断当前应该提醒哪个时段
export function getPeriodToRemind() {
  return getCurrentPeriod();
}

// 根据时间推算催促等级（1=普通, 2=加急, 3=短信, 4=电话）
export function getEscalationLevel(period) {
  const { hour, minute } = getBeijingTime();
  const totalMinutes = hour * 60 + minute;

  let startMinutes;
  if (period === 'noon') {
    startMinutes = 12 * 60; // 12:00
  } else {
    startMinutes = 19 * 60; // 19:00
  }

  const elapsed = totalMinutes - startMinutes;

  if (elapsed < 30) return 1;  // 0-30分钟: 普通消息
  if (elapsed < 60) return 2;  // 30-60分钟: 应用内加急
  if (elapsed < 90) return 3;  // 60-90分钟: 短信加急
  return 4;                     // 90分钟+: 电话加急
}
