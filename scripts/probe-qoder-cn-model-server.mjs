#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const AUTH_FILE = join(process.env.HOME || homedir(), ".pi", "agent", "auth.json");
const USERINFO_URL = "https://openapi.qoder.com.cn/api/v1/userinfo";
const EXCHANGE_URL = "https://openapi.qoder.com.cn/api/v1/jobToken/exchange";
const MODEL_SERVER_URL =
  process.env.QODER_MODEL_SERVER_URL || "https://api2-v2.qoder.sh/model/v1/chat/completions";
const MODEL = process.env.QODER_PROBE_MODEL || "gmodel";

function redact(value) {
  if (value == null) return "";
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:pt|jt|jrt)-[A-Za-z0-9._-]+\b/g, "<redacted-token>")
    .replace(/"?(?:security_oauth_token|securityOauthToken|access_token|accessToken|token|refresh_token)"?\s*:\s*"[^"]+"/gi, (m) => {
      const key = m.split(":")[0];
      return `${key}: "<redacted>"`;
    });
}

function parsePat(refresh) {
  if (typeof refresh !== "string" || !refresh.startsWith("pat|")) return "";
  return refresh.split("|")[1] || "";
}

async function exchangePat(pat) {
  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "pi-provider-qoder-probe",
    },
    body: JSON.stringify({ personal_token: pat }),
  });
  if (!res.ok) {
    const text = redact((await res.text().catch(() => "")).slice(0, 300));
    throw new Error(`PAT exchange failed: HTTP ${res.status}${text ? ` - ${text}` : ""}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error("PAT exchange returned no job token");
  return data.token;
}

async function loadCredentials() {
  let raw;
  try {
    raw = await readFile(AUTH_FILE, "utf8");
  } catch {
    throw new Error(`Could not read ${AUTH_FILE}. Run /login qoder-cn in Pi first.`);
  }

  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${AUTH_FILE}`);
  }

  const creds = auth?.["qoder-cn"];
  if (!creds) {
    throw new Error(`No qoder-cn credentials found in ${AUTH_FILE}. Run /login qoder-cn in Pi first.`);
  }

  let jobToken = typeof creds.access === "string" ? creds.access : "";
  const expires = Number(creds.expires || 0);
  const pat = parsePat(creds.refresh);

  if ((!jobToken || (expires > 0 && expires <= Date.now() + 60_000)) && pat) {
    console.log("Job token: refreshing from saved PAT");
    jobToken = await exchangePat(pat);
  } else {
    console.log("Job token: found");
  }

  if (!jobToken) {
    throw new Error("qoder-cn credentials contain no usable job token and no saved PAT.");
  }

  if (expires > 0) {
    const mins = Math.round((expires - Date.now()) / 60_000);
    console.log(`Stored token expiry: ${mins} min`);
  } else {
    console.log("Stored token expiry: unknown");
  }

  return { jobToken };
}

async function fetchUserInfo(jobToken) {
  const res = await fetch(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${jobToken}`,
      Accept: "application/json",
      "User-Agent": "pi-provider-qoder-probe",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`userinfo failed: HTTP ${res.status} - ${redact(text.slice(0, 300))}`);
  }

  let info;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error("userinfo returned invalid JSON");
  }

  const candidates = [
    ["security_oauth_token", info.security_oauth_token],
    ["securityOauthToken", info.securityOauthToken],
    ["access_token", info.access_token],
    ["accessToken", info.accessToken],
  ].filter(([, value]) => typeof value === "string" && value.length > 0);

  console.log(`userinfo: OK (model-server token fields: ${candidates.map(([name]) => name).join(", ") || "none"})`);
  return candidates;
}

function buildRequest() {
  const requestId = crypto.randomUUID();
  const sessionId = `pi-qoder-probe-${crypto.randomUUID()}`;

  return {
    requestId,
    sessionId,
    body: {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are testing native tool calling. When asked, call the provided tool instead of writing an XML or textual tool call.",
        },
        {
          role: "user",
          content: "Call get_probe_value with key set to ping. Do not answer the request in plain text.",
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "get_probe_value",
            description: "Returns a probe value for a supplied key.",
            parameters: {
              type: "object",
              properties: {
                key: { type: "string" },
              },
              required: ["key"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 256,
      reasoning_effort: "low",
      metadata: {
        context: {
          request_id: requestId,
          request_set_id: requestId,
          session_id: sessionId,
          task_id: "qoder-cn-model-server-probe",
          client_type: "5",
        },
      },
    },
  };
}

async function probeWithToken(tokenName, token) {
  const { requestId, sessionId, body } = buildRequest();
  const started = performance.now();

  const response = await fetch(MODEL_SERVER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Request-ID": requestId,
      "X-Session-ID": sessionId,
      "User-Agent": "pi-provider-qoder-probe",
    },
    body: JSON.stringify(body),
  });

  console.log(`Token candidate: ${tokenName}`);
  console.log(`Endpoint: ${MODEL_SERVER_URL}`);
  console.log(`HTTP: ${response.status}`);

  if (!response.ok) {
    const text = redact((await response.text().catch(() => "")).slice(0, 500));
    console.log(`Error: ${text || response.statusText || "no response body"}`);
    return { accepted: false, status: response.status };
  }

  if (!response.body) {
    console.log("Error: response has no body");
    return { accepted: true, status: response.status, parsed: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstEventMs = null;
  let structuredToolCalls = 0;
  let xmlToolCalls = 0;
  let finishReason = "";
  let responseModel = "";
  let eventCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstEventMs == null) firstEventMs = Math.round(performance.now() - started);

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      eventCount += 1;

      xmlToolCalls += (data.match(/<\/?tool_call\b/gi) || []).length;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (typeof parsed?.model === "string") responseModel = parsed.model;
      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const calls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
      if (Array.isArray(calls)) {
        structuredToolCalls += calls.filter(
          (call) => call && (call.id || call.function?.name || call.function?.arguments),
        ).length;
      }

      const content = choice?.delta?.content ?? choice?.message?.content;
      if (typeof content === "string") {
        xmlToolCalls += (content.match(/<\/?tool_call\b/gi) || []).length;
      }
    }
  }

  const totalMs = Math.round(performance.now() - started);
  console.log(`First event: ${firstEventMs ?? "n/a"} ms`);
  console.log(`Total: ${totalMs} ms`);
  console.log(`SSE events: ${eventCount}`);
  console.log(`Response model: ${responseModel || "unknown"}`);
  console.log(`Finish reason: ${finishReason || "unknown"}`);
  console.log(`Structured tool-call fragments: ${structuredToolCalls}`);
  console.log(`XML tool-call markers: ${xmlToolCalls}`);

  return {
    accepted: true,
    status: response.status,
    structuredToolCalls,
    xmlToolCalls,
  };
}

async function main() {
  console.log("Qoder CN model-server probe");
  console.log("===========================");
  console.log(`Auth file: ${AUTH_FILE}`);
  console.log(`Model: ${MODEL}`);

  const { jobToken } = await loadCredentials();
  const candidates = await fetchUserInfo(jobToken);

  const tokenCandidates =
    candidates.length > 0
      ? candidates
      : [["job_token_fallback", jobToken]];

  for (const [name, token] of tokenCandidates) {
    const result = await probeWithToken(name, token);
    if (result.accepted) {
      console.log("");
      if ((result.structuredToolCalls || 0) > 0 && (result.xmlToolCalls || 0) === 0) {
        console.log("RESULT: new model-server accepted the Qoder CN credentials and returned native tool_calls.");
      } else if ((result.xmlToolCalls || 0) > 0) {
        console.log("RESULT: request succeeded, but XML-style tool calling was still observed.");
      } else {
        console.log("RESULT: request succeeded, but no tool call was observed.");
      }
      return;
    }
    if (result.status !== 401 && result.status !== 403) return;
    console.log("Trying the next token field...");
  }

  console.log("");
  console.log("RESULT: model-server rejected all available Qoder CN token fields.");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error("");
  console.error(`Probe failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
