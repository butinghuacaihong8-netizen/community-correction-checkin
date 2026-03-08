const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// 缓存 access token（单次调用内有效）
let tokenCache = { token: null, expiresAt: 0 };

export async function getAccessToken(appId, appSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const res = await fetch(`${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 access token 失败: ${data.msg}`);
  }

  tokenCache = {
    token: data.app_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };

  return data.app_access_token;
}

export async function sendMessage(accessToken, openId, msgType, content) {
  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    }),
  });

  return await res.json();
}

export async function urgentApp(accessToken, messageId, userIds) {
  return await applyUrgent(accessToken, messageId, userIds, 'urgent_app');
}

export async function urgentSms(accessToken, messageId, userIds) {
  return await applyUrgent(accessToken, messageId, userIds, 'urgent_sms');
}

export async function urgentPhone(accessToken, messageId, userIds) {
  return await applyUrgent(accessToken, messageId, userIds, 'urgent_phone');
}

async function applyUrgent(accessToken, messageId, userIds, type) {
  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/messages/${messageId}/${type}?user_id_type=open_id`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ user_id_list: userIds }),
  });

  return await res.json();
}

export async function downloadImage(accessToken, messageId, imageKey) {
  const res = await fetch(
    `${FEISHU_BASE_URL}/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    throw new Error(`下载图片失败: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}
