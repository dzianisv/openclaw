import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { createProxyIngressHandler } from "../proxy-ingress.js";

const TELEGRAM_PROXY_INGRESS_PATH = "/api/channels/telegram/proxy-ingress";

export function registerTelegramPluginHttpRoutes(api: OpenClawPluginApi): void {
  const handler = createProxyIngressHandler(api);
  api.registerHttpRoute({
    path: TELEGRAM_PROXY_INGRESS_PATH,
    auth: "gateway",
    match: "exact",
    handler,
  });
}
