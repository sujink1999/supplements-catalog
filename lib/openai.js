// Two transports, one function. chat.completions with a strict function tool is the cheap
// default; it rejects reasoning_effort alongside tools, so anything above "none" has to go
// through /v1/responses with text.format.json_schema (exactly what legacy extract2.js did).
// Plain fetch: the repo's only dependencies are sharp, pg and dotenv.
import { requireEnv } from "./env.js";
import { MODELS } from "../config/rules.js";
import * as ledger from "./ledger.js";

const API = "https://api.openai.com/v1";
const isGpt5plus = (model) => /^gpt-(5\.[56]|6)[.-]/.test(model);

async function post(pathname, body) {
  const res = await fetch(API + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * One structured call. `content` is [{type:"text",text} | {type:"image_url",url}].
 * Returns { out, usage: {in, out}, usd }. Every call is written to the ledger; a budget,
 * when given, aborts the run once the cap is passed.
 */
export async function callJson({
  system,
  content,
  name,
  schema,
  maxTokens,
  effort = "none",
  model = MODELS.default,
  stage,
  key,
  runId,
  budget,
}) {
  let out;
  let usage;
  if (isGpt5plus(model) && effort !== "none") {
    const res = await post("/responses", {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        {
          role: "user",
          content: content.map((c) =>
            c.type === "text"
              ? { type: "input_text", text: c.text }
              : { type: "input_image", image_url: c.url, detail: c.detail || "high" },
          ),
        },
      ],
      reasoning: { effort },
      max_output_tokens: Math.max(maxTokens, 16000),
      text: { format: { type: "json_schema", name, schema, strict: true } },
    });
    const txt =
      res.output_text ||
      (res.output || [])
        .flatMap((o) => o.content || [])
        .map((c) => c.text)
        .filter(Boolean)
        .join("");
    if (!txt) throw new Error(`empty response (${res.status || "?"}${res.incomplete_details ? " " + res.incomplete_details.reason : ""})`);
    out = JSON.parse(txt);
    usage = { in: res.usage.input_tokens, out: res.usage.output_tokens };
  } else {
    const res = await post("/chat/completions", {
      model,
      max_completion_tokens: maxTokens,
      ...(isGpt5plus(model) ? { reasoning_effort: "none" } : { temperature: 0 }),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: content.map((c) =>
            c.type === "text" ? { type: "text", text: c.text } : { type: "image_url", image_url: { url: c.url, detail: c.detail || "high" } },
          ),
        },
      ],
      tools: [{ type: "function", function: { name, description: name, parameters: schema, strict: true } }],
      tool_choice: { type: "function", function: { name } },
    });
    out = JSON.parse(res.choices[0].message.tool_calls[0].function.arguments);
    usage = { in: res.usage.prompt_tokens, out: res.usage.completion_tokens };
  }
  const row = ledger.record({ runId, stage, call: name, key, model, effort, tokensIn: usage.in, tokensOut: usage.out });
  if (budget) budget.add(row.usd || 0);
  return { out, usage, usd: row.usd };
}

// Label images are fetched by the model, at the width that is already at its patch budget.
export const atWidth = (url, width) => String(url).split("?")[0] + `?width=${width}`;
