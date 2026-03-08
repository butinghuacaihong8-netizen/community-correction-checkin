import { GoogleGenerativeAI } from '@google/generative-ai';

export async function verifyScreenshot(apiKey, imageBuffer, period) {
  const genAI = new GoogleGenerativeAI(apiKey);
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
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('解析 Gemini 响应失败:', e);
  }

  return {
    isValid: false,
    time: null,
    reason: '无法解析审核结果，请重新发送截图',
    hasTime: false,
    isSuccess: false,
  };
}
