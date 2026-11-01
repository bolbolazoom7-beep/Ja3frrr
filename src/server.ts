import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express, { Request, Response } from 'express';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parse JSON bodies with up to 25MB for image attachments and docs
app.use(express.json({ limit: '25mb' }));

// ==========================================
// SYSTEM TIME & CAIRO TIMEZONE
// ==========================================
export function getCairoInfo() {
  const now = new Date();
  const optionsDate: Intl.DateTimeFormatOptions = {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  const optionsTime: Intl.DateTimeFormatOptions = {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };

  const arabicDate = new Intl.DateTimeFormat('ar-EG', optionsDate).format(now);
  const arabicTime = new Intl.DateTimeFormat('ar-EG', optionsTime).format(now);
  const englishDate = new Intl.DateTimeFormat('en-US', optionsDate).format(now);
  const englishTime = new Intl.DateTimeFormat('en-US', optionsTime).format(now);

  return {
    timestamp: now.getTime(),
    timezone: 'Africa/Cairo',
    cairoDateArabic: arabicDate,
    cairoTimeArabic: arabicTime,
    cairoDateEnglish: englishDate,
    cairoTimeEnglish: englishTime,
    fullSummary: `التاريخ الفعلي الحالي: ${arabicDate}، الوقت: ${arabicTime} بتوقيت القاهرة (مصر - Africa/Cairo). العام الحالي هو ${now.getFullYear()}.`,
  };
}

// ==========================================
// CONFIGURATION & SECRETS STATE
// ==========================================
let adminAccessCode = process.env['ADMIN_ACCESS_CODE'] || '098765';

// API Keys - Protected on backend only
const envKey = process.env['NOTRACK_API_KEY'] || '';
const isRevokedKey = envKey.includes('8572') || envKey.includes('693c');
const DEFAULT_NOTRACK_KEY =
  envKey && !isRevokedKey
    ? envKey
    : 'sk-notrack-6e8d90cd1a6054e839aa86aa192a0940eb37a3dd2b5b1cbf';
let activeNoTrackKey = DEFAULT_NOTRACK_KEY;
let activeNoTrackBaseUrl = (
  process.env['NOTRACK_BASE_URL'] || 'https://api.notrack.ai/v1'
).replace(/\/+$/, '');
let activeNoTrackModel = process.env['NOTRACK_MODEL'] || 'notrack-uncensored';

const activeGeminiKey = process.env['GEMINI_API_KEY'] || '';

// Rate Limiting for Admin Verification
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
}
const adminRateLimits = new Map<string, RateLimitRecord>();

function checkAdminRateLimit(ip: string): { allowed: boolean; waitSeconds?: number } {
  const record = adminRateLimits.get(ip);
  if (!record) return { allowed: true };

  const now = Date.now();
  if (record.lockedUntil > now) {
    const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, waitSeconds };
  }

  if (record.lockedUntil <= now && record.attempts >= 5) {
    // Lockout expired, reset attempts
    record.attempts = 0;
    record.lockedUntil = 0;
  }

  return { allowed: true };
}

function recordAdminFailure(ip: string) {
  const now = Date.now();
  let record = adminRateLimits.get(ip);
  if (!record) {
    record = { attempts: 1, lockedUntil: 0 };
    adminRateLimits.set(ip, record);
    return;
  }
  record.attempts += 1;
  if (record.attempts >= 5) {
    // 15 minutes lockout
    record.lockedUntil = now + 15 * 60 * 1000;
  }
}

function resetAdminFailures(ip: string) {
  adminRateLimits.delete(ip);
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function isValidUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ==========================================
// SYSTEM PROMPT BUILDER FOR JA3FAR AI
// ==========================================
interface PromptContext {
  userName?: string;
  userInterests?: string;
  personalNotes?: string;
  preferredLanguage?: 'ar' | 'en';
  preferredDialect?: 'egyptian' | 'saudi' | 'levantine' | 'msa' | 'english';
  assistantName?: string;
  personality?: 'friendly_humorous' | 'professional' | 'concise' | 'creative';
  tone?: 'casual' | 'formal';
  responseLength?: 'concise' | 'medium' | 'detailed';
  formattingStyle?: 'structured' | 'conversational' | 'code_heavy';
  customInstructions?: string;
  memories?: { key: string; value: string }[];
  enableLiveSearch?: boolean;
}

function buildSystemPrompt(context: PromptContext = {}): string {
  const cairoInfo = getCairoInfo();
  const assistantName = context.assistantName || 'جعفر';
  const dialect = context.preferredDialect || 'egyptian';
  const personality = context.personality || 'friendly_humorous';
  const tone = context.tone || 'casual';
  const length = context.responseLength || 'medium';

  let dialectGuideline = '';
  switch (dialect) {
    case 'egyptian':
      dialectGuideline = 'تحدث باللهجة المصرية الطبيعية الذكية والودية (مثل: تمام يا غالي، حاضر من عيوني، مفيش مشكلة، يا باشمهندس، على راسي، إلخ) مع صياغة واضحة وذكية بدون تصنع أو ابتذال، مع الحفاظ على القواعد العلمية والتقنية الصحيحة.';
      break;
    case 'saudi':
      dialectGuideline = 'تحدث باللهجة السعودية الخليجية البيضاء والمهذبة مع الحفاظ على الدقة العلمية.';
      break;
    case 'levantine':
      dialectGuideline = 'تحدث باللهجة الشامية اللطيفة والمحببة مع الدقة والوضوح.';
      break;
    case 'msa':
      dialectGuideline = 'تحدث باللغة العربية الفصحى السليمة والراقية مع صياغة فصيحة ومتقنة.';
      break;
    case 'english':
      dialectGuideline = 'Communicate in clear, natural, and highly articulate English.';
      break;
  }

  let personalityGuideline = '';
  switch (personality) {
    case 'friendly_humorous':
      personalityGuideline = 'كن ودوداً، ذكياً، وخفيف الظل بروح مصرية أصيلة دون مبالغة، واجعل المستخدم يشعر بالراحة والاهتمام.';
      break;
    case 'professional':
      personalityGuideline = 'كن مهنياً، منظماً، موضوعياً، ودقيقاً بأسلوب احترافي رفيع.';
      break;
    case 'concise':
      personalityGuideline = 'كن مباشراً، سريعاً، وركز على الإجابة المفيدة دون مقدمات طويلة أو حشو.';
      break;
    case 'creative':
      personalityGuideline = 'كن مبدعاً وغنياً بالأفكار والمجازات الجميلة والحلول غير التقليدية.';
      break;
  }

  let lengthGuideline = '';
  switch (length) {
    case 'concise':
      lengthGuideline = 'اجعل الردود موجزة ومباشرة وتفي بالغرض بدقة.';
      break;
    case 'detailed':
      lengthGuideline = 'قدم شروحات وافية وشاملة وتفاصيل دقيقة مع أمثلة واضحة وتنسيق منظم.';
      break;
    default:
      lengthGuideline = 'اجعل طول الرد متوازناً، يغطي المطلوب دون إطالة مملة.';
  }

  let userContextDetails = '';
  if (context.userName) {
    userContextDetails += `\n- اسم المستخدم: ${context.userName}`;
  }
  if (context.userInterests) {
    userContextDetails += `\n- اهتمامات المستخدم: ${context.userInterests}`;
  }
  if (context.personalNotes) {
    userContextDetails += `\n- ملاحظات وتفضيلات المستخدم: ${context.personalNotes}`;
  }
  if (context.memories && context.memories.length > 0) {
    userContextDetails += '\n- معلومات محفوظة عن المستخدم بالذاكرة:';
    for (const mem of context.memories) {
      userContextDetails += `\n  * [${mem.key}]: ${mem.value}`;
    }
  }

  let customInstructionText = '';
  if (context.customInstructions && context.customInstructions.trim()) {
    customInstructionText = `\n\nتعليمات خاصة من المستخدم يجب الالتزام بها بدقة:\n${context.customInstructions.trim()}`;
  }

  return `أنت "${assistantName}" (Ja3far AI)، المساعد الذكي المستقل وفائق الخصوصية المبني على تقنيات NoTrack.ai (نموذج notrack-uncensored).
أنت جعفر فقط، ولا تنسب نفسك أو تذكر أي شركة ذكاء اصطناعي أخرى تحت أي ظرف من الظروف.

معلومات الزمان والمكان المؤكدة حالياً:
- ${cairoInfo.fullSummary}
- يجب أن تعتمد على هذا التاريخ والتوقيت في كل إجاباتك التي تتطلب معرفة التاريخ والوقت الحالي (مثال: المباريات الجارية، السنة الحالية، الأعياد والمواسم، آخر التطورات).

شخصيتك وأسلوبك:
- ${dialectGuideline}
- ${personalityGuideline}
- النبرة المطلوبة: ${tone === 'formal' ? 'رسمية وأنيقة' : 'عفوية وودية وغير متكلفة'}.
- تفضيل طول الرد: ${lengthGuideline}
- أنت تفهم بطلاقة العامية المصرية، اللهجات العربية الأخرى، الفصحى، واللغة الإنجليزية، وتجيب وفق لغة وسياق حديث المستخدم.
- إذا سألك المستخدم عن أخبار الرياضة ومباريات اليوم (خاصة الأهلي والزمالك والدوري المصري والإنجليزي ودوري أبطال أوروبا) أو التكنولوجيا أو الأسعار، استخدم أحدث المعلومات الموثوقة والمدققة، واذكر مصادرك أو تواريخ النشر إن وجدت.
- عندما تقدم كوداً برمجياً، نسقه دائماً داخل كتل كود مع تحديد اللغة، واستخدم أفضل الممارسات.
- عندما تحتوي الإجابة على معادلات رياضية، اكتبها بتنسيق LaTeX ($للمعادلات المضمنة$ أو $$للمعادلات المستقلة$$).
- نسق إجاباتك بمهارة باستخدام العناوين، القوائم المنقطة، والجداول المنظمة عند المقارنات.
${userContextDetails}${customInstructionText}
تذكر: أنت جعفر فقط، رفيق ذكي، أمين، عالي الكفاءة، وذو حضور مميز ومريح وفائق الخصوصية.`;
}

// ==========================================
// API ROUTES
// ==========================================

// 1. System Time in Egypt (Africa/Cairo)
app.get('/api/time', (_req: Request, res: Response) => {
  res.json(getCairoInfo());
});

// 2. Health Endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    service: 'Ja3far AI Backend (Powered by NoTrack.ai)',
    activeProvider: 'notrack',
    notrackReady: !!activeNoTrackKey,
    model: activeNoTrackModel,
    cairoTime: getCairoInfo().fullSummary,
  });
});

// 3. Public Masked Config
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    provider: 'notrack',
    baseUrl: activeNoTrackBaseUrl,
    model: activeNoTrackModel,
    apiKeyMasked: maskKey(activeNoTrackKey),
    isConfigured: !!activeNoTrackKey,
  });
});

// 4. Admin Authentication
app.post('/api/admin/verify', (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const { code } = req.body;

  const rateCheck = checkAdminRateLimit(ip);
  if (!rateCheck.allowed) {
    res.status(429).json({
      success: false,
      error: `تم قفل محاولات الدخول مؤقتاً بسبب تكرار الرمز الخاطئ. يرجى الانتظار ${rateCheck.waitSeconds} ثانية.`,
      locked: true,
      waitSeconds: rateCheck.waitSeconds,
    });
    return;
  }

  if (typeof code !== 'string' || code.trim() !== adminAccessCode) {
    recordAdminFailure(ip);
    res.status(401).json({
      success: false,
      error: 'رمز الوصول غير صحيح. يرجى التأكد والمحاولة مجدداً.',
    });
    return;
  }

  resetAdminFailures(ip);
  res.json({
    success: true,
    message: 'تم التحقق بنجاح من صلاحيات الإدارة.',
  });
});

// 5. Admin Change Access Code
app.post('/api/admin/change-code', (req: Request, res: Response) => {
  const { currentCode, newCode } = req.body;

  if (currentCode !== adminAccessCode) {
    res.status(401).json({ success: false, error: 'رمز الوصول الحالي غير صحيح.' });
    return;
  }

  if (!newCode || typeof newCode !== 'string' || newCode.trim().length < 6) {
    res.status(400).json({
      success: false,
      error: 'الرمز الجديد يجب أن يتكون من 6 خانات على الأقل.',
    });
    return;
  }

  adminAccessCode = newCode.trim();
  res.json({
    success: true,
    message: 'تم تغيير رمز الوصول الإداري بنجاح.',
  });
});

// 6. Admin Get Full API Configuration Status
app.get('/api/admin/config', (req: Request, res: Response) => {
  const authHeader = req.headers['x-admin-code'];
  if (authHeader !== adminAccessCode) {
    res.status(401).json({ error: 'غير مصرح بالوصول إلى لوحة الإدارة.' });
    return;
  }

  res.json({
    provider: 'notrack',
    notrack: {
      hasKey: !!activeNoTrackKey,
      maskedKey: maskKey(activeNoTrackKey),
      baseUrl: activeNoTrackBaseUrl,
      model: activeNoTrackModel,
    },
  });
});

// 7. Admin Update API Keys
app.post('/api/admin/update-keys', (req: Request, res: Response) => {
  const authHeader = req.headers['x-admin-code'];
  if (authHeader !== adminAccessCode) {
    res.status(401).json({ error: 'غير مصرح بالوصول.' });
    return;
  }

  const { notrackKey, notrackBaseUrl, notrackModel } = req.body;

  if (typeof notrackKey === 'string' && notrackKey.trim()) {
    activeNoTrackKey = notrackKey.trim();
  }
  if (typeof notrackBaseUrl === 'string' && notrackBaseUrl.trim()) {
    if (!isValidUrl(notrackBaseUrl)) {
      res.status(400).json({ error: 'عنوان رابط NoTrack غير صالح أو محظور أمنياً.' });
      return;
    }
    activeNoTrackBaseUrl = notrackBaseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof notrackModel === 'string' && notrackModel.trim()) {
    activeNoTrackModel = notrackModel.trim();
  }

  res.json({
    success: true,
    message: 'تم تحديث تكوين NoTrack بنجاح.',
    activeProvider: 'notrack',
    notrackMasked: maskKey(activeNoTrackKey),
    model: activeNoTrackModel,
  });
});

// 8. Test API Connection (for diagnostics and admin validation)
app.post('/api/diagnostics/test-connection', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  if (!activeNoTrackKey) {
    res.status(400).json({
      success: false,
      provider: 'notrack',
      message: 'مفتاح NoTrack API غير مهيأ.',
    });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const targetUrl = `${activeNoTrackBaseUrl}/models`;
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${activeNoTrackKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({
        success: false,
        provider: 'notrack',
        statusCode: response.status,
        latencyMs,
        message: `خطأ من NoTrack (${response.status}): ${errText.slice(0, 100)}`,
      });
      return;
    }

    const data = await response.json();
    const modelsList = Array.isArray(data?.data)
      ? data.data.map((m: { id: string }) => m.id)
      : [activeNoTrackModel];

    res.json({
      success: true,
      provider: 'notrack',
      statusCode: 200,
      latencyMs,
      endpoint: activeNoTrackBaseUrl,
      activeModel: activeNoTrackModel,
      availableModels: modelsList,
      message: `تم التحقق بنجاح من اتصال NoTrack.ai (${activeNoTrackModel})!`,
    });
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      success: false,
      provider: 'notrack',
      statusCode: 502,
      latencyMs,
      message: `فشل الاتصال بـ NoTrack: ${msg}`,
    });
  }
});

// ==========================================
// 9. CHAT COMPLETION & STREAMING ENDPOINT
// ==========================================
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  const {
    messages,
    context = {},
    attachments = [],
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'قائمة الرسائل مطلوبة.' });
    return;
  }

  const systemInstruction = buildSystemPrompt(context);

  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  // Helper to format messages for Gemini
  function formatGeminiContents(
    rawMsgs: { role: string; content: string }[],
    rawAttachments: { dataUrl?: string; mimeType?: string }[]
  ) {
    const formatted: { role: string; parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[] = [];
    for (let i = 0; i < rawMsgs.length; i++) {
      const m = rawMsgs[i];
      const isLast = i === rawMsgs.length - 1;
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [{ text: m.content || ' ' }];

      if (isLast && role === 'user' && Array.isArray(rawAttachments) && rawAttachments.length > 0) {
        for (const att of rawAttachments) {
          if (att.dataUrl && typeof att.dataUrl === 'string') {
            const base64Data = att.dataUrl.includes('base64,')
              ? att.dataUrl.split('base64,')[1]
              : att.dataUrl;

            parts.push({
              inlineData: {
                mimeType: att.mimeType || 'image/jpeg',
                data: base64Data,
              },
            });
          }
        }
      }

      formatted.push({ role, parts });
    }
    return formatted;
  }

  // Fast fallback streamer (No latency, zero tools overhead, pure Ja3far persona)
  async function streamFastFallback(): Promise<boolean> {
    if (!activeGeminiKey) return false;
    const ai = new GoogleGenAI({ apiKey: activeGeminiKey });
    const formattedContents = formatGeminiContents(messages, attachments);

    const candidateModels = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];

    let responseStream = null;
    for (const modelCandidate of candidateModels) {
      if (abortController.signal.aborted) return false;
      try {
        responseStream = await ai.models.generateContentStream({
          model: modelCandidate,
          contents: formattedContents,
          config: {
            systemInstruction,
          },
        });
        break;
      } catch (err: unknown) {
        console.warn(`Fallback on ${modelCandidate} failed:`, err);
      }
    }

    if (!responseStream) return false;

    for await (const chunk of responseStream) {
      if (abortController.signal.aborted) break;
      const text = chunk.text;
      if (text) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return true;
  }

  // 1. Direct NoTrack.ai streaming
  if (activeNoTrackKey) {
    try {
      const apiMessages: Record<string, unknown>[] = [
        { role: 'system', content: systemInstruction },
      ];

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const isLast = i === messages.length - 1;

        if (isLast && m.role === 'user' && Array.isArray(attachments) && attachments.length > 0) {
          const parts: Record<string, unknown>[] = [{ type: 'text', text: m.content || '' }];
          for (const att of attachments) {
            if (att.dataUrl) {
              parts.push({
                type: 'image_url',
                image_url: { url: att.dataUrl },
              });
            }
          }
          apiMessages.push({ role: m.role, content: parts });
        } else {
          apiMessages.push({ role: m.role, content: m.content });
        }
      }

      const response = await fetch(`${activeNoTrackBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeNoTrackKey}`,
        },
        body: JSON.stringify({
          model: activeNoTrackModel,
          messages: apiMessages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (response.ok && response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (abortController.signal.aborted) break;
          res.write(chunk);
        }
        res.end();
        return;
      }

      // If NoTrack returns 402/no_credit or temporary error, fulfill seamlessly as Ja3far
      console.warn('NoTrack direct stream returned status:', response.status);
      if (activeGeminiKey) {
        const ok = await streamFastFallback();
        if (ok) return;
      }

      const errText = await response.text();
      res.write(`data: [ERROR] خطأ من NoTrack (${response.status}): ${errText.slice(0, 150)}\n\n`);
      res.end();
      return;
    } catch (noTrackErr: unknown) {
      if (abortController.signal.aborted) {
        res.end();
        return;
      }
      if (activeGeminiKey) {
        try {
          const ok = await streamFastFallback();
          if (ok) return;
        } catch {
          // ignore
        }
      }
      const message = noTrackErr instanceof Error ? noTrackErr.message : String(noTrackErr);
      res.write(`data: [ERROR] ${message}\n\n`);
      res.end();
      return;
    }
  }

  // 2. Direct fallback if NoTrack key is absent
  if (activeGeminiKey) {
    try {
      const ok = await streamFastFallback();
      if (ok) return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.write(`data: [ERROR] ${msg}\n\n`);
      res.end();
      return;
    }
  }

  res.write('data: [ERROR] لم يتم تكوين مفتاح NoTrack API.\n\n');
  res.end();
});

// Non-streaming chat endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  const { messages, context = {} } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'قائمة الرسائل مطلوبة.' });
    return;
  }

  const systemInstruction = buildSystemPrompt(context);

  async function generateFastNonStream() {
    if (!activeGeminiKey) return null;
    const ai = new GoogleGenAI({ apiKey: activeGeminiKey });
    const formattedContents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    try {
      const result = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: formattedContents,
        config: { systemInstruction },
      });
      return {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: result.text || '',
        model: activeNoTrackModel,
      };
    } catch {
      return null;
    }
  }

  // 1. NoTrack direct call
  if (activeNoTrackKey) {
    try {
      const apiMessages = [
        { role: 'system', content: systemInstruction },
        ...messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      const response = await fetch(`${activeNoTrackBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeNoTrackKey}`,
        },
        body: JSON.stringify({
          model: activeNoTrackModel,
          messages: apiMessages,
          stream: false,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        res.json({
          id: data.id || `msg_${Date.now()}`,
          role: 'assistant',
          content: data.choices?.[0]?.message?.content || '',
          model: data.model || activeNoTrackModel,
        });
        return;
      }

      // If NoTrack returns error, fallback as Ja3far
      if (activeGeminiKey) {
        const resObj = await generateFastNonStream();
        if (resObj) {
          res.json(resObj);
          return;
        }
      }

      const errText = await response.text();
      res.status(response.status).json({ error: errText });
      return;
    } catch (err: unknown) {
      if (activeGeminiKey) {
        const resObj = await generateFastNonStream();
        if (resObj) {
          res.json(resObj);
          return;
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
      return;
    }
  }

  if (activeGeminiKey) {
    const resObj = await generateFastNonStream();
    if (resObj) {
      res.json(resObj);
      return;
    }
  }

  res.status(401).json({ error: 'المفتاح غير مهيأ.' });
});

// ==========================================
// STATIC FILES & SSR CATCH-ALL
// ==========================================
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }
    console.log(`Ja3far AI server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
