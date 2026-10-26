import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENV_FILE = path.join(__dirname, '.env');
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE = path.join(__dirname, 'monitor.log');
const PID_FILE = path.join(__dirname, 'monitor.pid');
const STOP_FILE = path.join(__dirname, 'stop.signal');

// Load .env
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        env[key] = val;
      }
    }
  }
  return env;
}

const envConfig = loadEnv();

function parseAccounts() {
  const rawAccounts =
    process.env.CORREIOS_ACCOUNTS ||
    envConfig.CORREIOS_ACCOUNTS ||
    '';
  const defaultPass = process.env.CORREIOS_PASS || envConfig.CORREIOS_PASS || '';

  return rawAccounts
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sepIdx = entry.indexOf(':');
      if (sepIdx > 0) {
        return {
          username: entry.slice(0, sepIdx).trim(),
          password: entry.slice(sepIdx + 1).trim(),
        };
      }
      return {
        username: entry,
        password: defaultPass,
      };
    });
}

function parseIgnoredPackages() {
  const raw = process.env.IGNORED_PACKAGES || envConfig.IGNORED_PACKAGES || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

const CONFIG = {
  portalUrl:
    process.env.PORTAL_URL ||
    envConfig.PORTAL_URL ||
    'https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf',
  accounts: parseAccounts(),
  ignoredPackages: parseIgnoredPackages(),
  activeMaxAgeDays: Number(process.env.ACTIVE_MAX_AGE_DAYS || envConfig.ACTIVE_MAX_AGE_DAYS || 60),
  intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || envConfig.CHECK_INTERVAL_MINUTES || 30),
  telegramToken:
    process.env.TELEGRAM_BOT_TOKEN ||
    envConfig.TELEGRAM_BOT_TOKEN ||
    '',
};

const IS_ONCE = process.argv.includes('--once');

// Logger with timestamp
function log(level, message, meta = null) {
  const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const metaStr = meta ? ` | ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level}] ${message}${metaStr}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {
    // Ignore file logging error
  }
}

// Persistent State Manager
function createDefaultState() {
  return {
    ownerChatId: null,
    ownerName: null,
    ownerUsername: null,
    ownerRegisteredAt: null,
    lastUpdateId: 0,
    lastCheckAt: null,
    lastSuccessAt: null,
    packages: {},
    accountsStatus: {},
    shutdownAt: null,
  };
}

let state = createDefaultState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      // Migrate legacy single-package state if present
      const migratedPackages = { ...(parsed.packages || {}) };
      if (parsed.trackingCode && parsed.lastStatus && !migratedPackages[parsed.trackingCode]) {
        migratedPackages[parsed.trackingCode] = {
          trackingCode: parsed.trackingCode,
          accountUser: parsed.accountUser ?? null,
          accountHolder: parsed.accountHolder ?? null,
          lastStatus: parsed.lastStatus,
          lastStatusDate: parsed.lastStatusDate || null,
          requiresAction: Boolean(parsed.requiresAction),
          active: true,
          lastSeenAt: parsed.lastSuccessAt || new Date().toISOString(),
          lastChangeAt: parsed.lastChangeAt || parsed.lastSuccessAt || new Date().toISOString(),
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }

      state = {
        ...createDefaultState(),
        ownerChatId: parsed.ownerChatId ?? null,
        ownerName: parsed.ownerName ?? null,
        ownerUsername: parsed.ownerUsername ?? null,
        ownerRegisteredAt: parsed.ownerRegisteredAt ?? null,
        lastUpdateId: parsed.lastUpdateId ?? 0,
        lastCheckAt: parsed.lastCheckAt ?? null,
        lastSuccessAt: parsed.lastSuccessAt ?? null,
        packages: migratedPackages,
        accountsStatus: parsed.accountsStatus || {},
        shutdownAt: parsed.shutdownAt ?? null,
      };

      saveState();
      log('INFO', 'Estado carregado de state.json', {
        ownerChatId: state.ownerChatId,
        trackedPackages: Object.keys(state.packages),
      });
    } else {
      saveState();
      log('INFO', 'Arquivo state.json inicializado.');
    }
  } catch (err) {
    log('ERROR', 'Erro ao carregar state.json, criando estado padrão', err.message);
    state = createDefaultState();
    saveState();
  }
}

function saveState() {
  try {
    const tmpFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (innerErr) {
      log('ERROR', 'Falha crítica ao salvar state.json', innerErr.message);
    }
  }
}

// Single-instance check
function acquirePidLock() {
  if (IS_ONCE) return true;
  try {
    if (fs.existsSync(PID_FILE)) {
      const existingPid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (existingPid && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          log('WARN', `Monitor já está em execução no PID ${existingPid}. Encerrando instância duplicada.`);
          process.exit(0);
        } catch {
          // Stale PID file
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
    return true;
  } catch (err) {
    log('WARN', 'Não foi possível gravar monitor.pid', err.message);
    return true;
  }
}

function releasePidLock() {
  if (IS_ONCE) return;
  try {
    if (fs.existsSync(PID_FILE)) {
      const currentPid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (currentPid === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {
    // Ignore
  }
}

// HTML Entity Decoder
function decodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Active vs Delivered/Returned Filter
function normalizeText(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseBrDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0);
}

function isFinalOrReturnStatus(status) {
  const norm = normalizeText(status);
  if (!norm) return true;

  const excludedKeywords = [
    'entregue',
    'devolucao',
    'devolvido',
    'nao autorizada',
    'sujeito a devolucao',
    'refugo',
    'abandonad',
    'apreendid',
    'cancelad',
    'extraviad',
    'roubad',
    'sinistrad',
  ];

  return excludedKeywords.some((kw) => norm.includes(kw));
}

function isPackageActiveAndIncoming(pkg) {
  const code = (pkg.trackingCode || '').toUpperCase();
  if (!code) return false;

  if (CONFIG.ignoredPackages.has(code)) {
    return false;
  }

  if (isFinalOrReturnStatus(pkg.status)) {
    return false;
  }

  // Filter out stagnant old packages beyond max age window
  const dt = parseBrDate(pkg.date);
  if (dt && CONFIG.activeMaxAgeDays > 0) {
    const ageDays = (Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > CONFIG.activeMaxAgeDays) {
      return false;
    }
  }

  return true;
}

// Portal Importador Scraper for an Account
async function fetchAccountPackages(account) {
  const cookies = new Map();

  function storeCookies(res, reqUrl) {
    const u = new URL(reqUrl);
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim();
        const val = pair.slice(eqIdx + 1).trim();
        if (!cookies.has(u.hostname)) cookies.set(u.hostname, new Map());
        cookies.get(u.hostname).set(key, val);
      }
    }
  }

  function buildCookieHeader(targetUrl) {
    const u = new URL(targetUrl);
    const pairs = [];
    for (const [host, map] of cookies.entries()) {
      if (u.hostname === host || (u.hostname.endsWith('.correios.com.br') && host.endsWith('.correios.com.br'))) {
        for (const [k, v] of map.entries()) {
          pairs.push(`${k}=${v}`);
        }
      }
    }
    return pairs.join('; ');
  }

  async function requestWithRedirects(targetUrl, options = {}) {
    let currentUrl = targetUrl;
    let currentOpts = { ...options, redirect: 'manual' };

    for (let hop = 0; hop < 15; hop++) {
      const cookieHeader = buildCookieHeader(currentUrl);
      currentOpts.headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        Connection: 'close',
        ...(currentOpts.headers || {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      };

      const res = await fetch(currentUrl, {
        ...currentOpts,
        signal: AbortSignal.timeout(30000),
      });
      storeCookies(res, currentUrl);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        currentOpts = { method: 'GET', redirect: 'manual' };
        continue;
      }

      return { res, finalUrl: currentUrl };
    }
    throw new Error('Limite de redirecionamentos excedido ao acessar o portal.');
  }

  const loginPage = await requestWithRedirects(CONFIG.portalUrl);
  const loginHtml = await loginPage.res.text();

  let portalHtml = loginHtml;
  let portalFinalUrl = loginPage.finalUrl;

  const execMatch = loginHtml.match(/name="execution"\s+value="([^"]+)"/);
  if (execMatch) {
    const execution = execMatch[1];
    const formData = new URLSearchParams({
      username: account.username,
      password: account.password,
      execution,
      _eventId: 'submit',
      geolocation: '',
    });

    const authStep = await requestWithRedirects(loginPage.finalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(loginPage.finalUrl).origin,
        Referer: loginPage.finalUrl,
      },
      body: formData.toString(),
    });

    portalHtml = await authStep.res.text();
    portalFinalUrl = authStep.finalUrl;

    if (portalFinalUrl.includes('cas.correios.com.br/login') || authStep.res.status === 401) {
      throw new Error(`Credenciais não reconhecidas no idCorreios para o CPF ${account.username}.`);
    }
  }

  const nameMatch = portalHtml.match(/<span class="name">([^<]+)<\/span>/i);
  const accountHolder = nameMatch ? decodeHtml(nameMatch[1]) : account.username;

  const tableMatch = portalHtml.match(/<table id="tableEncomendas">([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    throw new Error(`Tabela de encomendas não encontrada para a conta ${account.username}.`);
  }

  const packages = [];
  const rowRegex =
    /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(tableMatch[1])) !== null) {
    const trackingCode = decodeHtml(match[2]).toUpperCase();
    const statusIconHtml = match[3] || '';
    const status = decodeHtml(match[4]);
    const date = decodeHtml(match[5]);
    const requiresAction = statusIconHtml.includes('s_pend');

    if (trackingCode) {
      packages.push({
        trackingCode,
        accountUser: account.username,
        accountHolder,
        status,
        date,
        requiresAction,
      });
    }
  }

  return {
    accountUser: account.username,
    accountHolder,
    packages,
  };
}

// Telegram API Helpers
async function sendTelegramMessage(chatId, text) {
  if (!chatId) return false;
  const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!data.ok) {
      log('ERROR', 'Erro retornado pela API do Telegram ao enviar mensagem', data);
      return false;
    }
    return true;
  } catch (err) {
    log('ERROR', 'Falha de rede ao enviar mensagem no Telegram', err.message);
    return false;
  }
}

function formatPackageAlert(title, pkg, previousStatus = null) {
  const lines = [
    `📦 <b>${title}</b>`,
    ``,
    `🔖 <b>Encomenda:</b> <code>${pkg.trackingCode}</code>`,
    `👤 <b>Conta:</b> ${pkg.accountHolder} (<code>${pkg.accountUser}</code>)`,
  ];

  if (previousStatus) {
    lines.push(`🔄 <b>Status Anterior:</b> ${previousStatus}`);
  }

  lines.push(`📌 <b>Status Atual:</b> <b>${pkg.status}</b>`);

  if (pkg.date) {
    lines.push(`📅 <b>Data da Situação:</b> ${pkg.date}`);
  }

  if (pkg.requiresAction) {
    lines.push(
      `⚠️ <b>Atenção:</b> O portal indica que é necessário realizar uma ação (ex: pagamento ou envio de documentos)!`
    );
  }

  lines.push(`🕒 <b>Verificado em:</b> ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  lines.push(`🔗 <a href="${CONFIG.portalUrl}">Abrir Minhas Importações</a>`);

  return lines.join('\n');
}

function buildActiveSummaryMessage(headerTitle = 'Encomendas Ativas Monitoradas') {
  const activePkgs = Object.values(state.packages).filter((p) => p.active);
  const lines = [`📦 <b>${headerTitle}</b>`, ``];

  if (activePkgs.length === 0) {
    lines.push(`Nenhuma encomenda ativa em trânsito encontrada no momento.`);
  } else {
    for (const p of activePkgs) {
      lines.push(
        `🔹 <code>${p.trackingCode}</code> — <b>${p.lastStatus}</b>`,
        `   📅 Data: ${p.lastStatusDate || 'N/A'} | 👤 ${p.accountHolder} (<code>${p.accountUser}</code>)` +
          (p.requiresAction ? `\n   ⚠️ <b>Requer ação no portal!</b>` : ``),
        ``
      );
    }
  }

  const accSummary = Object.values(state.accountsStatus);
  if (accSummary.length > 0) {
    lines.push(`🔐 <b>Status das Contas:</b>`);
    for (const acc of accSummary) {
      if (acc.ok) {
        lines.push(`• <code>${acc.accountUser}</code> (${acc.accountHolder}): ✅ OK (${acc.activeCount} ativa(s))`);
      } else {
        const lastOkStr = acc.lastOkAt
          ? ` (último sucesso: ${new Date(acc.lastOkAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`
          : '';
        lines.push(`• <code>${acc.accountUser}</code> (${acc.accountHolder || acc.accountUser}): ⏳ Instabilidade temporária no portal${lastOkStr}`);
      }
    }
    lines.push(``);
  }

  lines.push(
    `🕒 <b>Última Verificação:</b> ${
      state.lastSuccessAt
        ? new Date(state.lastSuccessAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : 'Agora'
    }`,
    `⏱️ <b>Intervalo:</b> a cada ${CONFIG.intervalMinutes} minutos`,
    ``,
    `Comandos: /status | /consultar | /historico | /parar`
  );

  return lines.join('\n');
}

// Core Check Logic across all accounts
let isChecking = false;

async function performCheck(triggerReason = 'scheduled') {
  if (isChecking) {
    log('INFO', 'Consulta já em andamento, aguardando conclusão...');
    return null;
  }
  isChecking = true;

  try {
    log('INFO', `Iniciando varredura de ${CONFIG.accounts.length} conta(s) (motivo: ${triggerReason})...`);
    const nowIso = new Date().toISOString();
    state.lastCheckAt = nowIso;
    saveState();

    const currentlyActiveCodes = new Set();
    let anyAccountSuccess = false;

    for (let i = 0; i < CONFIG.accounts.length; i++) {
      const account = CONFIG.accounts[i];
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 4000));
      }
      try {
        let accountData = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            accountData = await fetchAccountPackages(account);
            break;
          } catch (e) {
            lastErr = e;
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 2500));
            }
          }
        }
        if (!accountData) throw lastErr;
        anyAccountSuccess = true;

        const activePackages = accountData.packages.filter((pkg) => isPackageActiveAndIncoming(pkg));

        state.accountsStatus[account.username] = {
          accountUser: account.username,
          accountHolder: accountData.accountHolder,
          ok: true,
          totalFound: accountData.packages.length,
          activeCount: activePackages.length,
          checkedAt: nowIso,
          lastOkAt: nowIso,
          error: null,
        };

        log(
          'INFO',
          `Conta ${account.username} (${accountData.accountHolder}): ${activePackages.length} encomenda(s) ativa(s) de ${accountData.packages.length} listada(s).`,
          activePackages.map((p) => `${p.trackingCode}: ${p.status} (${p.date})`)
        );

        // Process active packages
        for (const pkg of activePackages) {
          currentlyActiveCodes.add(pkg.trackingCode);
          const existing = state.packages[pkg.trackingCode];

          if (!existing) {
            // New active package discovered
            state.packages[pkg.trackingCode] = {
              trackingCode: pkg.trackingCode,
              accountUser: pkg.accountUser,
              accountHolder: pkg.accountHolder,
              lastStatus: pkg.status,
              lastStatusDate: pkg.date,
              requiresAction: pkg.requiresAction,
              active: true,
              lastSeenAt: nowIso,
              lastChangeAt: nowIso,
              history: [
                {
                  status: pkg.status,
                  date: pkg.date,
                  requiresAction: pkg.requiresAction,
                  detectedAt: nowIso,
                },
              ],
            };
            saveState();

            log('INFO', `Nova encomenda ativa adicionada ao monitoramento: ${pkg.trackingCode} -> "${pkg.status}"`);

            if (state.ownerChatId) {
              const msg = formatPackageAlert('Nova Encomenda Ativa em Monitoramento!', pkg);
              await sendTelegramMessage(state.ownerChatId, msg);
            }
          } else {
            // Existing tracked package: check if status changed
            const previousStatus = existing.lastStatus;
            const hasChanged = previousStatus !== pkg.status;

            existing.accountUser = pkg.accountUser;
            existing.accountHolder = pkg.accountHolder;
            existing.lastStatus = pkg.status;
            existing.lastStatusDate = pkg.date;
            existing.requiresAction = pkg.requiresAction;
            existing.active = true;
            existing.lastSeenAt = nowIso;

            if (hasChanged) {
              existing.lastChangeAt = nowIso;
              existing.history = existing.history || [];
              existing.history.push({
                status: pkg.status,
                date: pkg.date,
                requiresAction: pkg.requiresAction,
                detectedAt: nowIso,
              });
              saveState();

              log(
                'INFO',
                `MUDANÇA DE STATUS DETECTADA (${pkg.trackingCode}): "${previousStatus}" -> "${pkg.status}"`
              );

              if (state.ownerChatId) {
                const msg = formatPackageAlert(
                  'ALERTA: Status da Encomenda Atualizado!',
                  pkg,
                  previousStatus
                );
                await sendTelegramMessage(state.ownerChatId, msg);
              }
            } else {
              saveState();
            }
          }
        }

        // Check if any previously active package in this account just finished (Delivered / Returned)
        for (const pkg of accountData.packages) {
          const tracked = state.packages[pkg.trackingCode];
          if (tracked && tracked.active && !currentlyActiveCodes.has(pkg.trackingCode)) {
            const previousStatus = tracked.lastStatus;
            const hasChanged = previousStatus !== pkg.status;

            tracked.lastStatus = pkg.status;
            tracked.lastStatusDate = pkg.date;
            tracked.requiresAction = pkg.requiresAction;
            tracked.active = false;
            tracked.lastSeenAt = nowIso;

            if (hasChanged) {
              tracked.lastChangeAt = nowIso;
              tracked.history = tracked.history || [];
              tracked.history.push({
                status: pkg.status,
                date: pkg.date,
                requiresAction: pkg.requiresAction,
                detectedAt: nowIso,
              });
            }
            saveState();

            log(
              'INFO',
              `Encomenda ${pkg.trackingCode} mudou para status finalizador ("${pkg.status}") e concluiu o acompanhamento ativo.`
            );

            if (hasChanged && state.ownerChatId) {
              const msg = formatPackageAlert(
                'ALERTA FINAL: Encomenda Concluída / Atualizada!',
                pkg,
                previousStatus
              );
              await sendTelegramMessage(state.ownerChatId, msg);
            }
          }
        }
      } catch (accErr) {
        const causeMsg = accErr.cause ? ` (${accErr.cause.code || accErr.cause.message || accErr.cause})` : '';
        log('WARN', `Não foi possível consultar a conta ${account.username}: ${accErr.message}${causeMsg}`);
        const prevAcc = state.accountsStatus[account.username] || {};
        state.accountsStatus[account.username] = {
          accountUser: account.username,
          accountHolder: prevAcc.accountHolder || account.username,
          ok: false,
          totalFound: prevAcc.totalFound || 0,
          activeCount: prevAcc.activeCount || 0,
          checkedAt: nowIso,
          lastOkAt: prevAcc.lastOkAt || null,
          error: `${accErr.message}${causeMsg}`,
        };
        saveState();
      }
    }

    if (anyAccountSuccess) {
      state.lastSuccessAt = nowIso;
      saveState();
    }

    return state.packages;
  } catch (err) {
    log('ERROR', 'Erro geral durante verificação de encomendas', err.message);
    saveState();
    return null;
  } finally {
    isChecking = false;
  }
}

// Telegram Long-Polling Loop
let isShuttingDown = false;
let pollAbortController = null;

async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const fromUser = msg.from || {};
  const firstName = fromUser.first_name || 'Usuário';
  const username = fromUser.username ? `@${fromUser.username}` : null;
  const text = (msg.text || '').trim();

  // First person to message claims ownership
  if (!state.ownerChatId) {
    state.ownerChatId = chatId;
    state.ownerName = firstName;
    state.ownerUsername = username;
    state.ownerRegisteredAt = new Date().toISOString();
    saveState();

    log('INFO', `Novo dono registrado no Telegram: ${firstName} (${chatId})`);
    await sendTelegramMessage(
      chatId,
      `✅ <b>Olá, ${firstName}! Você foi registrado como dono deste bot.</b>\n\n` +
        buildActiveSummaryMessage('Encomendas Ativas Monitoradas')
    );
    return;
  }

  // Reject non-owner messages
  if (String(chatId) !== String(state.ownerChatId)) {
    log('WARN', `Mensagem ignorada de usuário não autorizado: ${chatId} (${firstName})`);
    await sendTelegramMessage(chatId, '⛔ Este bot já possui um proprietário vinculado e é de uso privado.');
    return;
  }

  // Owner commands
  const lower = text.toLowerCase();
  if (lower.startsWith('/consultar') || lower.startsWith('/check') || lower.startsWith('/atualizar')) {
    await sendTelegramMessage(chatId, `🔍 Consultando todas as contas nos Correios agora, aguarde...`);
    await performCheck('manual_telegram_command');
    await sendTelegramMessage(chatId, buildActiveSummaryMessage('Resultado da Consulta Manual'));
  } else if (lower.startsWith('/historico') || lower.startsWith('/history')) {
    const allPkgs = Object.values(state.packages);
    if (allPkgs.length === 0) {
      await sendTelegramMessage(chatId, '📭 Ainda não há histórico de status registrado.');
    } else {
      const blocks = allPkgs.map((p) => {
        const histLines = (p.history || []).map((h, i) => {
          const dt = new Date(h.detectedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
          return `   ${i + 1}. <b>${h.status}</b> (${h.date || 's/ data'}) — <i>${dt}</i>`;
        });
        return (
          `📦 <code>${p.trackingCode}</code> (${p.accountHolder}) ${p.active ? '🟢' : '⚪'}\n` +
          histLines.join('\n')
        );
      });
      await sendTelegramMessage(chatId, `📜 <b>Histórico de Encomendas Monitoradas:</b>\n\n` + blocks.join('\n\n'));
    }
  } else if (lower.startsWith('/parar') || lower.startsWith('/stop') || lower.startsWith('/desligar')) {
    await sendTelegramMessage(
      chatId,
      `🛑 <b>Comando de desligamento recebido.</b>\nSalvando todos os status atuais e encerrando o monitor com segurança.`
    );
    gracefulShutdown('TELEGRAM_STOP_COMMAND');
  } else {
    await sendTelegramMessage(chatId, buildActiveSummaryMessage('Encomendas Ativas Monitoradas'));
  }
}

async function startTelegramPolling() {
  log('INFO', 'Iniciando escuta do bot no Telegram...');
  while (!isShuttingDown) {
    try {
      pollAbortController = new AbortController();
      const offset = (state.lastUpdateId || 0) + 1;
      const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/getUpdates?offset=${offset}&timeout=25`;

      const res = await fetch(url, {
        signal: pollAbortController.signal,
      });
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          state.lastUpdateId = update.update_id;
          saveState();
          await handleTelegramUpdate(update);
        }
      } else if (!data.ok) {
        log('WARN', 'Resposta inesperada de getUpdates do Telegram', data);
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      if (isShuttingDown || err.name === 'AbortError') break;
      log('WARN', 'Erro temporário no polling do Telegram, tentando novamente em 5s...', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Graceful Shutdown Handler
let checkIntervalTimer = null;
let stopSignalTimer = null;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('INFO', `Sinal de desligamento recebido (${signal}). Salvando estado atual para a próxima execução...`);

  if (checkIntervalTimer) {
    clearInterval(checkIntervalTimer);
    checkIntervalTimer = null;
  }

  if (stopSignalTimer) {
    clearInterval(stopSignalTimer);
    stopSignalTimer = null;
  }

  try {
    if (fs.existsSync(STOP_FILE)) {
      fs.unlinkSync(STOP_FILE);
    }
  } catch {
    // Ignore
  }

  if (pollAbortController) {
    try {
      pollAbortController.abort();
    } catch {
      // Ignore
    }
  }

  state.shutdownAt = new Date().toISOString();
  saveState();
  releasePidLock();

  const activeSummary = Object.values(state.packages)
    .filter((p) => p.active)
    .map((p) => `${p.trackingCode}="${p.lastStatus}"`)
    .join(', ');

  log('INFO', `Estado salvo com sucesso em state.json (${activeSummary || 'nenhuma ativa'}). Encerrando com segurança.`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
process.on('exit', () => {
  if (!isShuttingDown) {
    state.shutdownAt = new Date().toISOString();
    saveState();
    releasePidLock();
  }
});

// Main Entry Point
async function main() {
  try {
    if (fs.existsSync(STOP_FILE)) {
      fs.unlinkSync(STOP_FILE);
    }
  } catch {
    // Ignore
  }

  if (CONFIG.accounts.length === 0 || !CONFIG.telegramToken) {
    log('ERROR', 'Configure CORREIOS_ACCOUNTS e TELEGRAM_BOT_TOKEN no arquivo .env (veja .env.example).');
    process.exit(1);
  }

  acquirePidLock();
  loadState();

  log('INFO', `=== Monitor Correios Importador Multi-Contas Iniciado (PID: ${process.pid}) ===`);
  log(
    'INFO',
    `Contas configuradas: ${CONFIG.accounts.map((a) => a.username).join(', ')} | Intervalo: ${CONFIG.intervalMinutes} min`
  );

  if (!state.ownerChatId) {
    log(
      'INFO',
      'Nenhum dono registrado ainda. Envie qualquer mensagem para o bot no Telegram para se tornar o dono!'
    );
  } else {
    log('INFO', `Dono vinculado: ${state.ownerName || 'Proprietário'} (Chat ID: ${state.ownerChatId})`);
  }

  stopSignalTimer = setInterval(() => {
    if (fs.existsSync(STOP_FILE)) {
      gracefulShutdown('STOP_SIGNAL_FILE');
    }
  }, 1000);

  // Run initial check immediately on startup unless checked very recently (< 10 min ago)
  const lastSuccessMs = state.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : 0;
  if (!IS_ONCE && lastSuccessMs && Date.now() - lastSuccessMs < 10 * 60 * 1000) {
    log('INFO', 'Consulta inicial pulada pois já houve verificação bem-sucedida há menos de 10 minutos.');
  } else {
    await performCheck('startup');
  }

  if (IS_ONCE) {
    log('INFO', 'Modo --once concluído. Encerrando.');
    gracefulShutdown('ONCE_COMPLETE');
    return;
  }

  const intervalMs = CONFIG.intervalMinutes * 60 * 1000;
  checkIntervalTimer = setInterval(() => {
    performCheck('interval_30m');
  }, intervalMs);

  await startTelegramPolling();
}

main().catch((err) => {
  log('ERROR', 'Erro fatal no monitor', err.message);
  saveState();
  releasePidLock();
  process.exit(1);
});
