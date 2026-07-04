import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface EnvLoadResult {
  loaded: string[];
}

export function loadEnvFiles(cwd = process.cwd()): EnvLoadResult {
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "..", ".env")
  ];
  const loaded: string[] = [];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    loaded.push(file);
  }

  return { loaded };
}

export function parseEnv(input: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawValue = line.slice(separator + 1).trim();
    result[key] = unquote(stripInlineComment(rawValue));
  }

  return result;
}

function stripInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && quote === "\"") {
      index += 1;
      continue;
    }
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];

  if (first === "\"" && last === "\"") {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  if (first === "'" && last === "'") {
    return value.slice(1, -1);
  }

  return value;
}
