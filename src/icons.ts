/**
 * Server icon: served over HTTP (/favicon.ico, /icon.png, /icon-128.png) and
 * declared in the MCP server info, so clients can show it instead of a
 * default icon. Works in Bun and Cloudflare Workers (no file access).
 */
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { FAVICON_ICO_BASE64, ICON_128_PNG_BASE64, ICON_512_PNG_BASE64 } from "./icon-data.ts";

export const PROJECT_URL = "https://github.com/gnucoop/indicators-mcp";

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Static files served by the HTTP servers. */
export const ICON_FILES: Record<string, { body: Uint8Array<ArrayBuffer>; contentType: string }> = {
  "/favicon.ico": { body: decode(FAVICON_ICO_BASE64), contentType: "image/x-icon" },
  "/icon.png": { body: decode(ICON_512_PNG_BASE64), contentType: "image/png" },
  "/apple-touch-icon.png": { body: decode(ICON_512_PNG_BASE64), contentType: "image/png" },
  "/icon-128.png": { body: decode(ICON_128_PNG_BASE64), contentType: "image/png" },
};

/** Icons for a server reachable over HTTP at `origin`. */
export function httpIcons(origin: string): Icon[] {
  return [
    { src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
    { src: `${origin}/icon-128.png`, mimeType: "image/png", sizes: ["128x128"] },
  ];
}

/** Icons for the stdio server, which has no URL: an inline data URI. */
export function inlineIcons(): Icon[] {
  return [{ src: `data:image/png;base64,${ICON_128_PNG_BASE64}`, mimeType: "image/png", sizes: ["128x128"] }];
}
