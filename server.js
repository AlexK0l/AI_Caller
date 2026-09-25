import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import { z } from 'zod';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import { CatalogKnowledgeBase } from './src/catalog.js';
import { parseClientsExcel } from './src/excel.js';
import { VoximplantProvider } from './src/telephony/voximplant.js';

const requiredEnv = [
  'OPENAI_API_KEY',
  'VOXIMPLANT_ACCOUNT_ID',
  'VOXIMPLANT_API_KEY',
  'VOXIMPLANT_RULE_ID',
  'VOXIMPLANT_PHONE_NUMBER',
  'VOXIMPLANT_MEDIA_SECRET',
  'PUBLIC_BASE_URL',
  'CALL_API_KEY',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Не задана переменная окружения ${key}`);
    process.exit(1);
  }
}

const config = {
  port: Number(process.env.PORT || 5050),
  openAiApiKey: process.env.OPENAI_API_KEY,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
  voice: process.env.OPENAI_VOICE || 'marin',
  voximplantAccountId: process.env.VOXIMPLANT_ACCOUNT_ID,
  voximplantApiKey: process.env.VOXIMPLANT_API_KEY,
  voximplantRuleId: process.env.VOXIMPLANT_RULE_ID,
  fromNumber: process.env.VOXIMPLANT_PHONE_NUMBER,
  mediaSecret: process.env.VOXIMPLANT_MEDIA_SECRET,
  publicBaseUrl: process.env.PUBLIC_BASE_URL.replace(/\/$/, ''),
  callApiKey: process.env.CALL_API_KEY,
  companyName: process.env.COMPANY_NAME || 'Спецавтотехника',
  agentName: process.env.AGENT_NAME || 'Алексей',
  defaultPurpose:
    process.env.DEFAULT_CALL_PURPOSE ||
    'Рассказать о продукции САТ, выяснить потребность клиента, ответить на вопросы и определить следующий шаг.',
  maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS || 3),
  allowedPhonePrefixes: (process.env.ALLOWED_PHONE_PREFIXES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  campaignDelayMs: Number(process.env.CAMPAIGN_DELAY_MS || 3000),
  catalogUrl:
    process.env.CATALOG_URL || 'https://www.satpricep.by/catalog/filter/clear/apply/',
  catalogMaxAgeHours: Number(process.env.CATALOG_MAX_AGE_HOURS || 6),
  catalogMaxPages: Number(process.env.CATALOG_MAX_PAGES || 20),
  catalogMaxProductPages: Number(process.env.CATALOG_MAX_PRODUCT_PAGES || 200),
  requireFreshCatalog:
    String(process.env.REQUIRE_FRESH_CATALOG || 'true').toLowerCase() === 'true',
};

const DATA_DIR = path.resolve('data');
const CALLS_DIR = path.join(DATA_DIR, 'calls');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const RESULTS_FILE = path.join(DATA_DIR, 'call-results.jsonl');
const DNC_FILE = path.join(DATA_DIR, 'do-not-call.json');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog-knowledge.json');
const DASHBOARD_FILE = path.resolve('public/index.html');
const TEMPLATE_FILE = path.resolve('clients-template.xlsx');

await fs.mkdir(CALLS_DIR, { recursive: true });
await fs.mkdir(CAMPAIGNS_DIR, { recursive: true });

const telephony = new VoximplantProvider({
  accountId: config.voximplantAccountId,
  apiKey: config.voximplantApiKey,
  ruleId: config.voximplantRuleId,
  fromNumber: config.fromNumber,
  mediaSecret: config.mediaSecret,
  publicBaseUrl: config.publicBaseUrl,
});
const fastify = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyMultipart, {
  limits: { files: 1, fileSize: 8 * 1024 * 1024 },
});
await fastify.register(fastifyWebsocket);

const catalogKb = new CatalogKnowledgeBase({
  catalogUrl: config.catalogUrl,
  dataFile: CATALOG_FILE,
  maxPages: config.catalogMaxPages,
  maxProductPages: config.catalogMaxProductPages,
});
await catalogKb.load();

// В production замените Map на Redis/PostgreSQL.
const pendingCalls = new Map();
const activeCalls = new Map();
const campaigns = new Map();

const callRequestSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Номер должен быть в формате E.164'),
  name: z.string().trim().min(1).max(100),
  purpose: z.string().trim().min(5).max(1000).optional(),
  consent: z.literal(true),
  consentSource: z.string().trim().min(3).max(500),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

function assertInternalApiKey(request, reply) {
  const key = request.headers['x-api-key'];
  if (key !== config.callApiKey) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function publicUrl(relativePath) {
  return new URL(relativePath, `${config.publicBaseUrl}/`).toString();
}

function publicWebsocketUrl(relativePath) {
  const url = new URL(relativePath, `${config.publicBaseUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function isAllowedMediaRequest(token, signature) {
  if (typeof signature !== 'string' || signature.length < 10) return false;
  const expected = telephony.signMediaToken(token);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAllowedDestination(phone) {
  if (config.allowedPhonePrefixes.length === 0) return true;
  return config.allowedPhonePrefixes.some((prefix) => phone.startsWith(prefix));
}

async function readDncList() {
  try {
    const content = await fs.readFile(DNC_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function addToDnc(phone, reason) {
  const list = await readDncList();
  if (!list.some((item) => item.phone === phone)) {
    list.push({ phone, reason, createdAt: new Date().toISOString() });
    await fs.writeFile(DNC_FILE, JSON.stringify(list, null, 2));
  }
}

async function appendResult(result) {
  await fs.appendFile(RESULTS_FILE, `${JSON.stringify(result)}\n`);
}

async function saveHistory(callContext, history) {
  const safeId = callContext.callId || callContext.token;
  const filename = path.join(CALLS_DIR, `${safeId}.json`);
  await fs.writeFile(
    filename,
    JSON.stringify(
      {
        call: {
          callId: callContext.callId,
          providerSessionId: callContext.providerSessionId || null,
          to: callContext.to,
          name: callContext.name,
          purpose: callContext.purpose,
          consentSource: callContext.consentSource,
          metadata: callContext.metadata,
        },
        updatedAt: new Date().toISOString(),
        history,
      },
      null,
      2,
    ),
  );
}

async function persistCampaign(campaign) {
  await fs.writeFile(
    path.join(CAMPAIGNS_DIR, `${campaign.id}.json`),
    JSON.stringify(campaign, null, 2),
  );
}

async function ensureFreshCatalog({ force = false } = {}) {
  if (!force && catalogKb.isFresh(config.catalogMaxAgeHours)) return catalogKb.status();
  try {
    return await catalogKb.sync({ logger: fastify.log });
  } catch (error) {
    fastify.log.error(error, 'Не удалось обновить каталог satpricep.by');
    if (config.requireFreshCatalog || catalogKb.documents.length === 0) throw error;
    return { ...catalogKb.status(), warning: `Обновление не удалось: ${error.message}` };
  }
}

function createAgent(callContext) {
  const searchCatalog = tool({
    name: 'search_catalog',
    description:
      'Единственный разрешённый источник фактов о продукции САТ. Ищи здесь перед КАЖДЫМ ответом о модели, характеристике, назначении, комплектации, наличии, цене, массе, объёме, осях, условиях эксплуатации или сравнении продукции.',
    parameters: z.object({
      query: z.string().min(2).max(500),
    }),
    execute: async ({ query }) => {
      const results = catalogKb.search(query, { limit: 5 });
      return JSON.stringify({
        sourceRestriction: 'Используй только эти результаты. Не добавляй знания от себя.',
        catalogStatus: catalogKb.status(),
        results,
      });
    },
  });

  const saveCallResult = tool({
    name: 'save_call_result',
    description: 'Сохраняет итог звонка. Вызови один раз ближе к завершению разговора.',
    parameters: z.object({
      status: z.enum([
        'interested',
        'not_interested',
        'callback',
        'wrong_number',
        'no_decision',
      ]),
      summary: z.string().min(5).max(1000),
      nextAction: z.string().max(500).optional(),
      callbackAt: z.string().max(100).optional(),
    }),
    execute: async ({ status, summary, nextAction, callbackAt }) => {
      const result = {
        callId: callContext.callId,
        campaignId: callContext.campaignId || null,
        to: callContext.to,
        name: callContext.name,
        status,
        summary,
        nextAction: nextAction || null,
        callbackAt: callbackAt || null,
        metadata: callContext.metadata,
        createdAt: new Date().toISOString(),
      };
      await appendResult(result);
      callContext.resultSaved = true;
      return 'Результат звонка сохранён.';
    },
  });

  const doNotCall = tool({
    name: 'add_to_do_not_call',
    description: 'Добавляет номер в стоп-лист, если клиент просит больше ему не звонить.',
    parameters: z.object({ reason: z.string().min(3).max(500) }),
    execute: async ({ reason }) => {
      await addToDnc(callContext.to, reason);
      await appendResult({
        callId: callContext.callId,
        campaignId: callContext.campaignId || null,
        to: callContext.to,
        name: callContext.name,
        status: 'do_not_call',
        summary: reason,
        metadata: callContext.metadata,
        createdAt: new Date().toISOString(),
      });
      callContext.resultSaved = true;
      return 'Номер добавлен в стоп-лист. Вежливо попрощайся и заверши разговор.';
    },
  });

  const endCall = tool({
    name: 'end_call',
    description: 'Завершает звонок после прощания.',
    parameters: z.object({ reason: z.string().min(3).max(300) }),
    execute: async ({ reason }) => {
      if (!callContext.resultSaved) {
        await appendResult({
          callId: callContext.callId,
          campaignId: callContext.campaignId || null,
          to: callContext.to,
          name: callContext.name,
          status: 'no_decision',
          summary: reason,
          metadata: callContext.metadata,
          createdAt: new Date().toISOString(),
        });
        callContext.resultSaved = true;
      }

      setTimeout(() => {
        telephony.hangup(callContext).catch((error) =>
          fastify.log.error(error, 'Не удалось завершить звонок'),
        );
      }, 900);
      return 'Звонок будет завершён.';
    },
  });

  const productHint = callContext.metadata?.product
    ? `Из Excel известно, что клиент ранее проявлял интерес к: ${callContext.metadata.product}. Это только контекст интереса, НЕ источник характеристик.`
    : 'Конкретная модель интереса в Excel не указана.';

  return new RealtimeAgent({
    name: `${config.agentName} — AI-ассистент`,
    instructions: `
Ты голосовой AI-ассистент компании «${config.companyName}» и совершаешь исходящий звонок клиенту.

Данные звонка:
- Имя клиента: ${callContext.name}
- Цель: ${callContext.purpose}
- ${productHint}

КРИТИЧЕСКОЕ ПРАВИЛО ИСТОЧНИКА:
Любые факты о продукции, моделях, назначении, характеристиках, комплектации, наличии, цене, массе, объёме, осях, эксплуатации и сравнении продукции можно сообщать ТОЛЬКО после вызова search_catalog и ТОЛЬКО если факт прямо присутствует в результате этого инструмента.
Никогда не используй собственные знания модели, догадки, типичные отраслевые значения или правдоподобные предположения.
Перед КАЖДЫМ новым вопросом клиента о продукции снова вызывай search_catalog, сформулировав запрос по смыслу вопроса.
Если подтверждённого ответа нет, прямо скажи: «В подтверждённых данных каталога на сайте я этого не нашёл. Могу зафиксировать вопрос для менеджера». Это считается корректным ответом; придумывать запрещено.
Если клиент спрашивает цену, а конкретная цена не найдена в search_catalog, не называй цену и не оценивай диапазон.
Если клиент спрашивает наличие, называй товар находящимся в наличии только если это прямо написано в найденном фрагменте.
При сравнении двух моделей сначала найди сведения о каждой и сравнивай только найденные характеристики.

Правила разговора:
1. Всегда говори по-русски, естественно и короткими фразами.
2. В первой реплике честно скажи, что ты AI-ассистент компании «${config.companyName}».
3. Уточни, удобно ли клиенту говорить. Если неудобно — спроси время повторного звонка.
4. Расскажи о продукции с учётом потребности клиента, но каждое фактическое утверждение о продукции подтверждай через search_catalog.
5. Отвечай на каждый вопрос клиента. Если сайт не содержит ответа, сообщи об отсутствии подтверждённых данных и предложи передачу вопроса менеджеру.
6. Не проси пароль, SMS-код, данные банковской карты или другие секреты.
7. Если клиент просит не звонить — вызови add_to_do_not_call, попрощайся и затем end_call.
8. Если клиент не заинтересован — не дави и не спорь.
9. Перед завершением вызови save_call_result, затем попрощайся и вызови end_call.
10. Не скрывай, что разговор ведёт искусственный интеллект.
`.trim(),
    tools: [searchCatalog, saveCallResult, doNotCall, endCall],
  });
}

async function createOutboundCall(payload, { campaignId = null } = {}) {
  const parsed = callRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const error = new Error('validation_error');
    error.details = parsed.error.flatten();
    error.statusCode = 400;
    throw error;
  }

  const data = parsed.data;
  if (!isAllowedDestination(data.to)) {
    const error = new Error('destination_not_allowed');
    error.statusCode = 403;
    throw error;
  }

  const dncList = await readDncList();
  if (dncList.some((item) => item.phone === data.to)) {
    const error = new Error('number_in_do_not_call_list');
    error.statusCode = 409;
    throw error;
  }

  if (activeCalls.size + pendingCalls.size >= config.maxConcurrentCalls) {
    const error = new Error('concurrency_limit_reached');
    error.statusCode = 429;
    throw error;
  }

  const token = crypto.randomBytes(16).toString('hex');
  const callContext = {
    token,
    campaignId,
    to: data.to,
    name: data.name,
    purpose: data.purpose || config.defaultPurpose,
    consentSource: data.consentSource,
    metadata: data.metadata,
    createdAt: new Date().toISOString(),
    callId: null,
    providerSessionId: null,
    bridgeSocket: null,
    realtimeSession: null,
    resultSaved: false,
  };

  pendingCalls.set(token, callContext);

  if (config.dryRun) {
    pendingCalls.delete(token);
    return {
      dryRun: true,
      token,
      to: data.to,
      provider: 'voximplant',
      mediaUrl: telephony.buildMediaUrl(token),
    };
  }

  try {
    const started = await telephony.createCall(callContext);
    callContext.providerSessionId = started.providerSessionId;
    pendingCalls.set(token, callContext);
    return {
      callId: callContext.callId,
      providerSessionId: started.providerSessionId,
      status: started.status,
      to: data.to,
      token,
      provider: 'voximplant',
    };
  } catch (error) {
    pendingCalls.delete(token);
    throw error;
  }
}

async function waitForCallSlot() {
  while (activeCalls.size + pendingCalls.size >= config.maxConcurrentCalls) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function runCampaign(campaign) {
  campaign.status = 'running';
  campaign.startedAt = new Date().toISOString();
  await persistCampaign(campaign);

  for (const [index, client] of campaign.clients.entries()) {
    if (campaign.status === 'stopped') break;
    await waitForCallSlot();
    try {
      const result = await createOutboundCall(client, { campaignId: campaign.id });
      campaign.progress.completed += 1;
      campaign.progress.started += 1;
      campaign.progress.last = { row: client.metadata?.excelRow, phone: client.to, result };
    } catch (error) {
      campaign.progress.completed += 1;
      campaign.progress.failed += 1;
      campaign.errors.push({
        row: client.metadata?.excelRow,
        phone: client.to,
        error: error.message,
      });
    }
    await persistCampaign(campaign);
    if (index < campaign.clients.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, config.campaignDelayMs));
    }
  }

  if (campaign.status !== 'stopped') campaign.status = 'completed';
  campaign.finishedAt = new Date().toISOString();
  await persistCampaign(campaign);
}

fastify.get('/', async (_request, reply) => {
  reply.type('text/html; charset=utf-8').send(await fs.readFile(DASHBOARD_FILE, 'utf8'));
});

fastify.get('/template.xlsx', async (_request, reply) => {
  const buffer = await fs.readFile(TEMPLATE_FILE);
  reply
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', 'attachment; filename="clients-template.xlsx"')
    .send(buffer);
});

fastify.get('/health', async () => ({ ok: true }));
fastify.get('/catalog/status', async () => ({ ok: true, ...catalogKb.status() }));

fastify.post('/catalog/sync', async (request, reply) => {
  if (!assertInternalApiKey(request, reply)) return;
  try {
    const status = await ensureFreshCatalog({ force: true });
    return { ok: true, ...status };
  } catch (error) {
    return reply.code(502).send({ error: 'catalog_sync_failed', message: error.message });
  }
});

fastify.post('/campaigns/upload', async (request, reply) => {
  if (!assertInternalApiKey(request, reply)) return;
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: 'xlsx_file_required' });
  if (!/\.xlsx$/i.test(part.filename || '')) {
    return reply.code(400).send({ error: 'xlsx_only' });
  }

  try {
    const parsed = await parseClientsExcel(await part.toBuffer());
    const id = crypto.randomUUID();
    const campaign = {
      id,
      filename: part.filename,
      sheetName: parsed.sheetName,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      status: 'uploaded',
      clients: parsed.clients,
      rejected: parsed.rejected,
      progress: {
        total: parsed.clients.length,
        started: 0,
        completed: 0,
        failed: 0,
        last: null,
      },
      errors: [],
    };
    campaigns.set(id, campaign);
    await persistCampaign(campaign);
    return reply.code(201).send({
      campaignId: id,
      filename: part.filename,
      totalRows: parsed.totalRows,
      validClients: parsed.clients.length,
      rejectedRows: parsed.rejected,
      status: campaign.status,
    });
  } catch (error) {
    return reply.code(400).send({ error: 'invalid_excel', message: error.message });
  }
});

fastify.get('/campaigns/:id', async (request, reply) => {
  if (!assertInternalApiKey(request, reply)) return;
  const campaign = campaigns.get(request.params.id);
  if (!campaign) return reply.code(404).send({ error: 'campaign_not_found' });
  return {
    id: campaign.id,
    filename: campaign.filename,
    status: campaign.status,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    finishedAt: campaign.finishedAt,
    rejectedRows: campaign.rejected,
    progress: campaign.progress,
    errors: campaign.errors.slice(-20),
  };
});

fastify.post('/campaigns/:id/start', async (request, reply) => {
  if (!assertInternalApiKey(request, reply)) return;
  const campaign = campaigns.get(request.params.id);
  if (!campaign) return reply.code(404).send({ error: 'campaign_not_found' });
  if (campaign.status !== 'uploaded') {
    return reply.code(409).send({ error: 'campaign_already_started', status: campaign.status });
  }
  if (!campaign.clients.length) return reply.code(400).send({ error: 'no_valid_clients' });

  try {
    const catalog = await ensureFreshCatalog();
    campaign.catalogSnapshot = catalog;
    campaign.status = 'queued';
    await persistCampaign(campaign);
    runCampaign(campaign).catch((error) => {
      fastify.log.error(error, 'Кампания завершилась с ошибкой');
      campaign.status = 'failed';
      campaign.errors.push({ error: error.message });
      campaign.finishedAt = new Date().toISOString();
      persistCampaign(campaign).catch(() => {});
    });
    return reply.code(202).send({
      ok: true,
      campaignId: campaign.id,
      status: campaign.status,
      clients: campaign.clients.length,
      catalog,
      dryRun: config.dryRun,
    });
  } catch (error) {
    return reply.code(502).send({
      error: 'fresh_catalog_required',
      message: `Обзвон не запущен: не удалось получить подтверждённые данные с сайта. ${error.message}`,
    });
  }
});

fastify.post('/calls', async (request, reply) => {
  if (!assertInternalApiKey(request, reply)) return;
  try {
    await ensureFreshCatalog();
    const result = await createOutboundCall(request.body);
    return reply.code(config.dryRun ? 200 : 201).send(result);
  } catch (error) {
    request.log.error(error, 'Ошибка создания звонка');
    return reply.code(error.statusCode || 502).send({
      error: error.message || 'call_provider_error',
      details: error.details,
    });
  }
});

fastify.register(async (scope) => {
  scope.get('/voximplant/media/:token', { websocket: true }, async (connection, request) => {
    const { token } = request.params;
    const signature = request.query?.sig;
    const callContext = pendingCalls.get(token) || activeCalls.get(token);

    if (!callContext || !isAllowedMediaRequest(token, signature)) {
      connection.close(1008, 'Unknown, expired or unsigned call token');
      return;
    }

    callContext.bridgeSocket = connection;
    let session = null;
    let realtimeStarted = false;

    const startRealtime = async () => {
      if (realtimeStarted) return;
      realtimeStarted = true;

      pendingCalls.delete(token);
      activeCalls.set(token, callContext);

      const agent = createAgent(callContext);
      session = new RealtimeSession(agent, {
        transport: 'websocket',
        model: config.realtimeModel,
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              format: 'g711_ulaw',
              turnDetection: { type: 'semantic_vad' },
            },
            output: {
              format: 'g711_ulaw',
              voice: config.voice,
            },
          },
        },
        workflowName: 'outbound-satpricep-voximplant-call',
        traceMetadata: {
          callToken: token,
          callId: callContext.callId || 'pending',
          campaignId: callContext.campaignId || 'single',
          telephonyProvider: 'voximplant',
        },
      });
      callContext.realtimeSession = session;

      session.on('audio', (event) => {
        if (connection.readyState === 1 && event?.data) {
          connection.send(Buffer.from(event.data), { binary: true });
        }
      });
      session.on('audio_interrupted', () => {
        if (connection.readyState === 1) {
          connection.send(JSON.stringify({ type: 'clear_audio' }));
        }
      });
      session.on('history_updated', (history) => {
        saveHistory(callContext, history).catch((error) =>
          fastify.log.error(error, 'Не удалось сохранить историю разговора'),
        );
      });
      session.on('error', (...args) => {
        fastify.log.error({ args, token }, 'Ошибка Realtime-сессии');
      });

      await session.connect({ apiKey: config.openAiApiKey });
      fastify.log.info({ token, callId: callContext.callId }, 'OpenAI Realtime подключён');
      session.sendMessage(
        `Начни звонок сейчас. Поздоровайся с ${callContext.name}, представься как AI-ассистент компании «${config.companyName}», кратко объясни цель и спроси, удобно ли говорить. Не называй ни одной характеристики продукции до использования search_catalog.`,
      );
    };

    const finishCall = async (status, summary = null) => {
      pendingCalls.delete(token);
      activeCalls.delete(token);
      if (session) session.close();

      if (!callContext.resultSaved) {
        await appendResult({
          callId: callContext.callId,
          providerSessionId: callContext.providerSessionId,
          campaignId: callContext.campaignId || null,
          to: callContext.to,
          name: callContext.name,
          status,
          summary: summary || `Звонок завершён со статусом ${status}.`,
          metadata: callContext.metadata,
          createdAt: new Date().toISOString(),
        });
        callContext.resultSaved = true;
      }
    };

    connection.on('message', async (data, isBinary) => {
      try {
        if (isBinary) {
          if (!session) return;
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const audio = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          session.sendAudio(audio);
          return;
        }

        const event = JSON.parse(data.toString());
        fastify.log.info({ token, event }, 'Voximplant event');

        if (event.callId && !callContext.callId) callContext.callId = String(event.callId);

        if (event.type === 'connected') {
          await startRealtime();
        } else if (event.type === 'failed') {
          await finishCall(event.reason || 'failed', event.message);
        } else if (event.type === 'disconnected') {
          await finishCall(event.reason || 'completed');
        }
      } catch (error) {
        fastify.log.error(error, 'Ошибка обработки Voximplant WebSocket');
      }
    });

    connection.on('close', () => {
      if (session) session.close();
      callContext.bridgeSocket = null;
      activeCalls.delete(token);
      pendingCalls.delete(token);
    });
  });
});

async function shutdown(signal) {
  fastify.log.info({ signal }, 'Завершение работы');
  for (const context of activeCalls.values()) {
    await telephony.hangup(context).catch(() => {});
  }
  await fastify.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  fastify.log.info(
    {
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      dryRun: config.dryRun,
      catalog: catalogKb.status(),
    },
    'Сервис запущен',
  );
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
