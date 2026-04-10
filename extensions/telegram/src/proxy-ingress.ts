import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBot } from "./bot.js";
import { resolveTelegramTransport } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { getTelegramRuntime } from "./runtime.js";

const log = createSubsystemLogger("telegram/proxy-ingress");

const TELEGRAM_PROXY_INGRESS_PATH = "/api/channels/telegram/proxy-ingress";
const TELEGRAM_PROXY_INGRESS_MAX_BODY_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PROXY_INGRESS_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_TELEGRAM_ACCOUNT_ID = "default";

type TelegramIngressBot = ReturnType<typeof createTelegramBot>;
type TelegramIngressUpdate = Parameters<TelegramIngressBot["handleUpdate"]>[0];

type IngressBotEntry = {
  bot: TelegramIngressBot;
  ready: Promise<void>;
};

const ingressBotCache = new Map<string, IngressBotEntry>();

class ProxyIngressAccessError extends Error {}

function isTelegramIngressUpdate(value: unknown): value is TelegramIngressUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const maybeUpdate = value as { update_id?: unknown };
  return typeof maybeUpdate.update_id === "number" && Number.isFinite(maybeUpdate.update_id);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  message: string,
  details?: string,
): void {
  sendJson(res, status, {
    error: {
      message,
      ...(details ? { details } : {}),
    },
  });
}

function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function resolveRequestedAccountId(req: IncomingMessage): string {
  const accountParam = parseRequestUrl(req).searchParams.get("account")?.trim();
  return accountParam && accountParam.length > 0 ? accountParam : DEFAULT_TELEGRAM_ACCOUNT_ID;
}

async function readProxyIngressUpdateBody(req: IncomingMessage): Promise<
  | {
      ok: true;
      update: TelegramIngressUpdate;
    }
  | {
      ok: false;
      status: number;
      message: string;
    }
> {
  const body = await readJsonBodyWithLimit(req, {
    maxBytes: TELEGRAM_PROXY_INGRESS_MAX_BODY_BYTES,
    timeoutMs: TELEGRAM_PROXY_INGRESS_BODY_TIMEOUT_MS,
    emptyObjectOnEmpty: false,
  });
  if (!body.ok) {
    if (body.code === "PAYLOAD_TOO_LARGE") {
      return { ok: false, status: 413, message: body.error };
    }
    if (body.code === "REQUEST_BODY_TIMEOUT") {
      return { ok: false, status: 408, message: body.error };
    }
    return { ok: false, status: 400, message: body.error };
  }

  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, status: 400, message: "Request body must be a JSON object" };
  }

  if (!isTelegramIngressUpdate(body.value)) {
    return {
      ok: false,
      status: 400,
      message: "Telegram update must include a numeric update_id",
    };
  }

  return { ok: true, update: body.value };
}

function getOrCreateIngressBot(params: { accountId: string }): {
  entry: IngressBotEntry;
  resolvedAccountId: string;
} {
  const runtime = getTelegramRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveTelegramAccount({ cfg, accountId: params.accountId });
  const resolvedAccountId = account.accountId;

  const cached = ingressBotCache.get(resolvedAccountId);
  if (cached) {
    return { entry: cached, resolvedAccountId };
  }

  if (account.tokenSource === "none" || !account.token) {
    throw new ProxyIngressAccessError(
      `No Telegram token configured for account "${resolvedAccountId}"`,
    );
  }

  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const telegramTransport = resolveTelegramTransport(proxyFetch, {
    network: account.config.network,
  });
  const bot = createTelegramBot({
    token: account.token,
    accountId: resolvedAccountId,
    config: cfg,
    telegramTransport,
  });

  const ready = bot
    .init()
    .then(() => {
      const username = bot.botInfo?.username ?? "unknown";
      log.info(`proxy-ingress bot initialized for account "${resolvedAccountId}" (@${username})`);
    })
    .catch((error) => {
      ingressBotCache.delete(resolvedAccountId);
      throw error;
    });

  const entry = { bot, ready };
  ingressBotCache.set(resolvedAccountId, entry);
  return { entry, resolvedAccountId };
}

function dispatchUpdateInBackground(bot: TelegramIngressBot, update: TelegramIngressUpdate): void {
  setImmediate(() => {
    void Promise.resolve()
      .then(async () => {
        await bot.handleUpdate(update);
      })
      .catch((error) => {
        log.warn(`proxy-ingress background update failed: ${formatErrorMessage(error)}`);
      });
  });
}

export function createProxyIngressHandler(
  _api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestUrl = parseRequestUrl(req);
    if (requestUrl.pathname !== TELEGRAM_PROXY_INGRESS_PATH) {
      return false;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJsonError(res, 405, "Method Not Allowed");
      return true;
    }

    const bodyResult = await readProxyIngressUpdateBody(req);
    if (!bodyResult.ok) {
      sendJsonError(res, bodyResult.status, bodyResult.message);
      return true;
    }

    const requestedAccountId = resolveRequestedAccountId(req);
    try {
      const { entry } = getOrCreateIngressBot({
        accountId: requestedAccountId,
      });
      await entry.ready;
      sendJson(res, 200, { ok: true });
      dispatchUpdateInBackground(entry.bot, bodyResult.update);
      return true;
    } catch (error) {
      const details = formatErrorMessage(error);
      if (error instanceof ProxyIngressAccessError) {
        log.warn(`proxy-ingress rejected (requestedAccount=${requestedAccountId}): ${details}`);
        sendJsonError(res, 403, "Gateway access denied", details);
        return true;
      }
      log.warn(`proxy-ingress failed (requestedAccount=${requestedAccountId}): ${details}`);
      sendJsonError(res, 500, "Failed to process Telegram update");
      return true;
    }
  };
}

export function clearIngressBotCache(): void {
  ingressBotCache.clear();
}
