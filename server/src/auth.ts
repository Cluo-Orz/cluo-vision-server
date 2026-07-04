import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { AppConfig } from "./config.js";
import type { User } from "./types.js";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: User["role"];
}

interface TokenPayload extends AuthUser {
  exp: number;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function hashPassword(password: string, salt = randomBytes(16).toString("base64url")) {
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("base64url"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createToken(user: AuthUser, config: AppConfig): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: TokenPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds
  };
  const body = base64Url(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, config.tokenSecret);
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string, config: AppConfig): AuthUser | null {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) return null;

  const expected = sign(`${header}.${body}`, config.tokenSecret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

  return {
    id: payload.id,
    username: payload.username,
    displayName: payload.displayName,
    role: payload.role
  };
}

export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role
  };
}
