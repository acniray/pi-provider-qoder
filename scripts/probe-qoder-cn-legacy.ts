/**
 * Qoder CN legacy protocol A/B probe.
 *
 * Compares the current pi-provider-qoder request shape against selected fields
 * from the official @qodercn-ai/qoderclicn 1.1.58 legacy request builder.
 *
 * It never prints credentials, PATs, COSY headers, or full responses.
 *
 * Usage:
 *   npm run probe:qoder-cn-legacy
 *   npm run probe:qoder-cn-legacy -- GLM-5.3
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { getCachedModelConfig } from "../src/catalog.js";
import { buildAuthHeaders } from "../src/cosy.js";
import { qoderEncodeBody } from "../src/protocol/encoding.js";
import { getQoderChatURL } from "../src/region.js";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const MODEL_ID = process.argv[2] || "GLM-5.3";
const MAX_CURRENT = 131072;
const MAX_OFFICIAL = 32000;
const SYSTEM_TEXT =
  "You are testing native tool calling. When asked to use a tool, return a native structured tool call. Do not write XML or a textual imitation of a tool call.";
const USER_TEXT =
  "Call get_probe_value exactly once with key set to ping. Do not answer in plain text.";

type JsonObject = Record<string, any>;

interface QoderCreds {
  access: string;
  userID: string;
  name: string;
  email: string;
  machineID?: string;
}

interface ProbeResult {
  label: string;
  http: number;
  upstream: number | null;
  structured: number;
  xml: number;
  finish: string;
  firstMs: number | null;
  totalMs: number;
  preview: string;
  error?: string;
}

function loadCreds(): QoderCreds {
  const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  const c = auth?.["qoder-cn"];
  if (!c?.access) {
    throw new Error("No qoder-cn credentials in ~/.pi/agent/auth.json. Run /login qoder-cn in Pi first.");
  }
  return c;
}

function officialModelConfig(raw: JsonObject): JsonObject {
  const source = raw?.source ?? "system";
  const serverSceneCustom = raw?.server_scene === "custom";
  const isCustom = source === "custom" && !serverSceneCustom;

  return {
    key: isCustom ? "custom_model" : raw.key,
    display_name: raw.display_name ?? raw.key,
    ...(raw.outer_provider ? { outer_provider: raw.outer_provider } : { model: "" }),
    format: raw.format ?? "openai",
    is_vl: raw.is_vl ?? false,
    is_reasoning: raw.is_reasoning ?? false,
    api_key: "",
    url: "",
    source: isCustom ? "system" : source,
    max_input_tokens: raw.max_input_tokens ?? 200000,
    ...(raw.custom_provider_adapter
      ? { custom_provider_adapter: raw.custom_provider_adapter }
      : {}),
  };
}

function toolDef(): JsonObject {
  return {
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
  };
}

function currentMessages(): JsonObject[] {
  return [
    { role: "system", content: SYSTEM_TEXT },
    { role: "user", content: USER_TEXT },
  ];
}

function officialMessages(): JsonObject[] {
  const systemBlocks = [{ type: "text", text: SYSTEM_TEXT }];
  return [
    { role: "system", content: systemBlocks },
    {
      role: "user",
      content: USER_TEXT,
      contents: [{ type: "text", text: USER_TEXT }],
    },
  ];
}

function makeIds() {
  const requestId = crypto.randomUUID();
  const recordId = crypto
    .createHash("sha256")
    .update("qoder-legacy-probe")
    .update(MODEL_ID)
    .update(USER_TEXT)
    .digest("hex")
    .slice(0, 16);
  const sessionId = `pi-qoder-legacy-probe-${crypto.randomUUID()}`;
  return { requestId, recordId, sessionId };
}

function baseBody(raw: JsonObject): JsonObject {
  const { requestId, recordId, sessionId } = makeIds();
  const key = raw.key;
  const reasoning = !!raw.is_reasoning || !!raw.thinking_config;

  return {
    request_id: requestId,
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages: currentMessages(),
    tools: [toolDef()],
    parameters: {
      max_tokens: MAX_CURRENT,
      enable_thinking: true,
      reasoning_effort: "high",
    },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: {
          key,
          is_reasoning: reasoning,
        },
        originalContent: USER_TEXT,
      },
      features: [],
      text: USER_TEXT,
    },
    model_config: raw,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: USER_TEXT.substring(0, 30),
      begin_at: Date.now(),
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function variantBodies(raw: JsonObject): Array<{ label: string; body: JsonObject }> {
  const baseline = baseBody(raw);

  const sessionType = clone(baseline);
  sessionType.session_type = "qoderclicn";

  const modelConfig = clone(baseline);
  modelConfig.model_config = officialModelConfig(raw);

  const systemContents = clone(baseline);
  const systemBlocks = [{ type: "text", text: SYSTEM_TEXT }];
  systemContents.system = systemBlocks;
  systemContents.messages = officialMessages();

  const max32k = clone(baseline);
  max32k.parameters.max_tokens = MAX_OFFICIAL;

  const officialIds = clone(baseline);
  officialIds.chat_record_id = officialIds.request_id;
  officialIds.request_set_id = officialIds.request_id;

  const toolChoiceAuto = clone(baseline);
  toolChoiceAuto.parameters.tool_choice = "auto";

  const officialVisible = clone(baseline);
  officialVisible.session_type = "qoderclicn";
  officialVisible.model_config = officialModelConfig(raw);
  officialVisible.system = systemBlocks;
  officialVisible.messages = officialMessages();
  officialVisible.parameters.max_tokens = MAX_OFFICIAL;
  officialVisible.chat_record_id = officialVisible.request_id;
  officialVisible.request_set_id = officialVisible.request_id;
  delete officialVisible.code_language;
  delete officialVisible.chat_prompt;
  delete officialVisible.image_urls;

  const officialPlusToolChoice = clone(officialVisible);
  officialPlusToolChoice.parameters.tool_choice = "auto";

  return [
    { label: "baseline-current", body: baseline },
    { label: "session_type=qoderclicn", body: sessionType },
    { label: "official-model_config", body: modelConfig },
    { label: "official-system+contents", body: systemContents },
    { label: "max_tokens=32000", body: max32k },
    { label: "official-request-ids", body: officialIds },
    { label: "tool_choice=auto", body: toolChoiceAuto },
    { label: "all-visible-official", body: officialVisible },
    { label: "all-visible+tool_choice", body: officialPlusToolChoice },
  ];
}

function safePreview(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function countXml(text: string): number {
  const patterns = [
    /<\/?tool_call\b/gi,
    /<\/?function_call\b/gi,
    /<\/?function_calls\b/gi,
  ];
  return patterns.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
}

async function send(
  label: string,
  body: JsonObject,
  rawModel: JsonObject,
  creds: QoderCreds,
): Promise<ProbeResult> {
  const url = getQoderChatURL("cn");
  const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(body)));
  const headers = buildAuthHeaders(encoded, url, {
    userID: creds.userID,
    authToken: creds.access,
    name: creds.name,
    email: creds.email,
    machineID: creds.machineID,
  });

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": rawModel.key,
      "X-Model-Source": rawModel.source || "system",
      ...headers,
    },
    body: encoded,
  });

  if (!response.ok) {
    const err = safePreview((await response.text().catch(() => "")).slice(0, 1000));
    return {
      label,
      http: response.status,
      upstream: null,
      structured: 0,
      xml: 0,
      finish: "",
      firstMs: null,
      totalMs: Math.round(performance.now() - started),
      preview: "",
      error: err || response.statusText,
    };
  }

  if (!response.body) {
    return {
      label,
      http: response.status,
      upstream: null,
      structured: 0,
      xml: 0,
      finish: "",
      firstMs: null,
      totalMs: Math.round(performance.now() - started),
      preview: "",
      error: "No response body",
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstMs: number | null = null;
  let structured = 0;
  let xml = 0;
  let finish = "";
  let upstream: number | null = null;
  let preview = "";
  let done = false;

  while (!done) {
    const part = await reader.read();
    if (part.done) break;
    if (firstMs === null) firstMs = Math.round(performance.now() - started);

    buffer += decoder.decode(part.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        done = true;
        break;
      }

      let envelope: any;
      try {
        envelope = JSON.parse(data);
      } catch {
        continue;
      }

      if (typeof envelope?.statusCodeValue === "number") {
        upstream = envelope.statusCodeValue;
      }

      const innerStr = envelope?.body;
      if (innerStr === "[DONE]") {
        done = true;
        break;
      }
      if (typeof innerStr !== "string" || !innerStr) continue;

      let inner: any;
      try {
        inner = JSON.parse(innerStr);
      } catch {
        xml += countXml(innerStr);
        if (!preview) preview = safePreview(innerStr);
        continue;
      }

      const choice = inner?.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const delta = choice?.delta ?? choice?.message;
      if (!delta) continue;

      if (Array.isArray(delta.tool_calls)) {
        structured += delta.tool_calls.filter(
          (tc: any) => tc && (tc.id || tc.function?.name || tc.function?.arguments),
        ).length;
      }
      if (delta.function_call) structured += 1;

      if (typeof delta.content === "string") {
        xml += countXml(delta.content);
        if (!preview && delta.content.trim()) preview = safePreview(delta.content);
      }
    }
  }

  return {
    label,
    http: response.status,
    upstream,
    structured,
    xml,
    finish,
    firstMs,
    totalMs: Math.round(performance.now() - started),
    preview,
  };
}

function printRawSummary(raw: JsonObject) {
  console.log("Catalog entry:");
  console.log(`  key: ${raw.key}`);
  console.log(`  display_name: ${raw.display_name ?? ""}`);
  console.log(`  source: ${raw.source ?? "system"}`);
  console.log(`  format: ${raw.format ?? "(default openai)"}`);
  console.log(`  is_reasoning: ${String(raw.is_reasoning ?? false)}`);
  console.log(`  max_input_tokens: ${String(raw.max_input_tokens ?? "(missing)")}`);
  console.log(
    `  context_config keys: ${raw.context_config ? Object.keys(raw.context_config).join(",") : "(none)"}`,
  );
  console.log(
    `  thinking efforts: ${raw.thinking_config?.enabled?.efforts ? Object.keys(raw.thinking_config.enabled.efforts).join(",") : "(none)"}`,
  );
}

async function main() {
  const creds = loadCreds();
  const raw = getCachedModelConfig(MODEL_ID, "cn") as JsonObject | null;

  if (!raw?.key) {
    throw new Error(
      `No cached Qoder CN config for ${MODEL_ID}. Open Pi, /login qoder-cn, and refresh the model list first.`,
    );
  }

  console.log("Qoder CN legacy A/B probe");
  console.log("========================");
  console.log(`Model: ${MODEL_ID}`);
  printRawSummary(raw);
  console.log("");
  console.log("Each request uses the same prompt/tool and only changes the labeled field(s).");
  console.log("No credentials or full model output are printed.");
  console.log("");

  const results: ProbeResult[] = [];
  for (const { label, body } of variantBodies(raw)) {
    process.stdout.write(`[${label}] ... `);
    const result = await send(label, body, raw, creds);
    results.push(result);
    console.log(
      `HTTP ${result.http}` +
        `${result.upstream !== null ? ` upstream=${result.upstream}` : ""}` +
        ` structured=${result.structured} xml=${result.xml}` +
        `${result.finish ? ` finish=${result.finish}` : ""}` +
        ` first=${result.firstMs ?? "n/a"}ms total=${result.totalMs}ms`,
    );
    if (result.error) console.log(`  error: ${result.error}`);
    if (result.preview) console.log(`  text: ${result.preview}`);
  }

  console.log("");
  console.log("Summary");
  console.log("-------");
  console.log("variant | http | upstream | structured | xml | finish | first_ms | total_ms");
  for (const r of results) {
    console.log(
      [
        r.label,
        r.http,
        r.upstream ?? "",
        r.structured,
        r.xml,
        r.finish,
        r.firstMs ?? "",
        r.totalMs,
      ].join(" | "),
    );
  }

  const native = results.filter((r) => r.structured > 0 && r.xml === 0);
  console.log("");
  if (native.length > 0) {
    console.log(
      `Native tool-call variants: ${native.map((r) => r.label).join(", ")}`,
    );
  } else {
    console.log("Native tool-call variants: none");
  }
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
