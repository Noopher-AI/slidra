import { next } from "@vercel/functions";

const COOKIE_NAME = "__Host-slidra_demo_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const encoder = new TextEncoder();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requiredEnv("DEMO_SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([hmac(`compare:${left}`), hmac(`compare:${right}`)]);
  if (leftDigest.length !== rightDigest.length) return false;
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest.charCodeAt(index) ^ rightDigest.charCodeAt(index);
  }
  return difference === 0;
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

async function validSession(request: Request): Promise<{ valid: boolean; id?: string }> {
  const token = cookieValue(request);
  if (!token) return { valid: false };
  const [id, expiresRaw, signature] = token.split(".");
  const expires = Number(expiresRaw);
  if (!id || !signature || !Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) {
    return { valid: false };
  }
  return { valid: await safeEqual(signature, await hmac(`${id}.${expires}`)), id };
}

function unauthorized(api: boolean): Response {
  if (api) {
    return Response.json({ error: "Demo access key required" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new Response("Demo access key required", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const suppliedKey = url.searchParams.get("key");

  if (suppliedKey !== null && await safeEqual(suppliedKey, requiredEnv("DEMO_ACCESS_KEY"))) {
    const id = base64Url(crypto.getRandomValues(new Uint8Array(18)));
    const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const signature = await hmac(`${id}.${expires}`);
    url.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        "Set-Cookie": `${COOKIE_NAME}=${id}.${expires}.${signature}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
        "Cache-Control": "no-store",
      },
    });
  }

  const session = await validSession(request);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (!session.valid || !session.id) return unauthorized(isApi);

  if (!isApi) return next();

  const headers = new Headers(request.headers);
  headers.delete("x-slidra-origin-token");
  headers.delete("x-slidra-client-id");
  headers.set("x-slidra-origin-token", requiredEnv("SLIDRA_ORIGIN_TOKEN"));
  headers.set("x-slidra-client-id", session.id);
  return next({ request: { headers } });
}

export const config = {
  runtime: "nodejs",
  matcher: ["/", "/api/:path*"],
};
