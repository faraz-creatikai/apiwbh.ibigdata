
import { getDynamicAIContext } from "../config/aiClientFactory.js";
import { gemini } from "../config/gemini.js";
import { openai } from "../config/openai.js";
import { fetchTabblyAgentPrompt } from "../controllers/controller.tabbly.js";
import { buildCallingAgentSystemPrompt, callingAgentSystemPrompt } from "./prompts/callingAgentPrompt.js";
import { dataminingPrompt, miningDataPrompt } from "./prompts/dataminingAgentPrompt.js";
import { emailCampaignPrompt } from "./prompts/emailCampaignPrompt.js";
import { followupPrompt } from "./prompts/followupPrompt.js";
import { keywordSearchPrompt } from "./prompts/keywordSearchPrompt.js";
import { propertyRecommendationPrompt } from "./prompts/propertyRecommendationPrompt.js";
import { qualifyCustomerPrompt } from "./prompts/qualifyCustomerPrompt.js";
import { scriptGenerationPrompt } from "./prompts/scriptGenerationPrompt.js";
import { socialAgentPrompt } from "./prompts/socialAgentPrompt.js";

export function safeJsonParse(raw) {
  if (!raw) return null;

  // 1. Remove ```json ... ``` or ``` ... ``` fences
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // 2. Try standard parse first (Fast Path - preserves existing agent behavior)
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // 3. Fallback Repair Path: Only executes if standard parse failed
    try {
      // Fix A: Remove rogue backslashes before non-JSON escape characters (e.g. \枉 -> 枉, \m -> m)
      // Valid JSON escapes: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
      let sanitized = cleaned.replace(/\\(?:[^"\\\/bfnrtu]|u(?![0-9a-fA-F]{4}))/g, (match) => {
        return match.slice(1); // Strip only the invalid backslash
      });

      // Fix B: Escape literal unescaped control characters / raw line breaks inside string values
      sanitized = sanitized.replace(/[\u0000-\u001F\u007F-\u009F]/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return '';
      });

      return JSON.parse(sanitized);
    } catch (secondErr) {
      console.warn("Failed to parse JSON:", cleaned);
      return null;
    }
  }
}

/**
 * HELPER: Routes the prompt to the correct SDK based on the active provider.
 * This prevents crashes when switching between Gemini, OpenAI, or future platforms.
 */
async function executeDynamicPrompt(client, model, provider, promptText) {
  if (provider === "OPENAI") {
    const response = await client.chat.completions.create({
      model: model,
      messages: [{ role: "user", content: promptText }],
    });
    return response.choices?.[0]?.message?.content;
  } else if (provider === "GEMINI") {
    const response = await client.models.generateContent({
      model: model,
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      config: {
        responseMimeType: "application/json", // Hard-enforces valid JSON syntax
        temperature: 0.2
      }
    });
    return response?.text;
  } else {
    // Ready for you to add ANTHROPIC, GROQ, etc. later!
    throw new Error(`Unsupported AI Provider: ${provider}`);
  }
}

export async function keywordSearchAgent(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash");

  const promptText = `${keywordSearchPrompt}\n\nUser input:\n${userPrompt}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  console.log(" naeruto ", safeJsonParse(raw))

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  return safeJsonParse(raw);
}

export async function keywordSearchAgentOpenai(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("OPENAI", "openai/gpt-oss-120b:free");

  const promptText = `${keywordSearchPrompt}\n\nUser input:\n${userPrompt}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  return safeJsonParse(raw);
}

export async function followupAgent(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash");

  const promptText = `${followupPrompt}\n\nUser input:\n${userPrompt}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  console.log(" raw ", raw)

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

export async function QualifyAgent(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash");

  console.log(" naruto is here ", " client", client, "model", model)

  const promptText = `${qualifyCustomerPrompt}\nDATA:\n${JSON.stringify(userPrompt, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  console.log(" raw ", raw)

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

export async function CallingAgent(userPrompt) {
  const basePrompt = await fetchTabblyAgentPrompt();
  const systemPrompt = buildCallingAgentSystemPrompt(basePrompt);

  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `${systemPrompt}\nDATA:\n${JSON.stringify(userPrompt, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  //console.log(" raw ", raw)

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

export async function PropertyRecommendationAgent(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `${propertyRecommendationPrompt}\nDATA:\n${JSON.stringify(userPrompt, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  //console.log(" raw ", raw)

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

export async function DataMiningAgent(data) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `\n${dataminingPrompt}\nDATA:\n${JSON.stringify(data, null, 2)}\n`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response");

  return JSON.parse(jsonMatch[0]);
}

export async function MiningDataAgent(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `${miningDataPrompt}\nDATA:\n${JSON.stringify(userPrompt, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  console.log(" raw ", raw)

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

// Added 'mode' as the third parameter with a default value
export async function ScriptGenerationAgent(userPrompt, customerContext = {}, mode = "hindi") {
  // Construct the payload dynamically
  const payload = {
    userPrompt: userPrompt,
    mode: mode, // Provide the mode to the AI so it knows which language to output
    // Only include customer/followups if they exist in the context
    ...(customerContext.customer && { customer: customerContext.customer }),
    ...(customerContext.followups && { followups: customerContext.followups }),
  };

  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `${scriptGenerationPrompt}\nDATA:\n${JSON.stringify(payload, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  // Extract JSON safely
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  // Assuming safeJsonParse is a utility function you have defined elsewhere
  return safeJsonParse(jsonMatch[0]);
}

export async function followupAgentOpenai(userPrompt) {
  const { client, model, provider } = await getDynamicAIContext("OPENAI", "openai/gpt-4o-mini");

  const promptText = `${followupPrompt}\n\nUser input:\n${userPrompt}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}

export async function SocialContentAgent(payload) {
  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

  const promptText = `\n${socialAgentPrompt}\nDATA:\n${JSON.stringify(payload, null, 2)}\n`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response");

  return JSON.parse(jsonMatch[0]);
}


// Drop-in replacement for EmailCampaignAgent.
// Only change: a 4th optional `templateHtml` param, forwarded into the
// payload the prompt sees as DATA.templateHtml. See emailCampaignPrompt.js
// for the matching instruction that tells the model how to use it.

export async function EmailCampaignAgent(userPrompt, customerContext = {}, mode = "hindi") {
  const payload = {
    userPrompt,
    mode,
    ...(customerContext.customer && { customer: customerContext.customer }),
  };

  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash");
  const promptText = `${emailCampaignPrompt}\nDATA:\n${JSON.stringify(payload, null, 2)}`;
  const raw = await executeDynamicPrompt(client, model, provider, promptText);

  if (!raw || !raw.trim()) throw new Error("AI returned empty response");
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response format");
  return safeJsonParse(jsonMatch[0]);
}


// webhook integrated agent 

/**
 * Fully Dynamic Webhook Agent
 * Handles custom methods, headers, and merges static API keys with AI-generated payloads.
 */
// ── URL template helpers ──────────────────────────────────────────────
// Pulls the templated parts out of a URL string so the AI can fill them
// the same way it fills the body: path params (":id") and query params
// whose current value is just a placeholder/example (e.g. "?catalog=mango").
function parseUrlTemplate(rawUrl) {
  const [pathPart, queryPart] = rawUrl.split("?");

  const pathParams = {};
  const pathParamNames = pathPart.match(/:([a-zA-Z0-9_]+)/g) || [];
  pathParamNames.forEach((token) => {
    pathParams[token.slice(1)] = ""; // empty placeholder, same convention as body fields
  });

  const queryParams = {};
  if (queryPart) {
    new URLSearchParams(queryPart).forEach((value, key) => {
      queryParams[key] = value; // existing value treated as an example/placeholder to refine
    });
  }

  return { pathTemplate: pathPart, pathParams, queryParams };
}

function buildFinalUrl(pathTemplate, pathParams = {}, queryParams = {}) {
  let finalPath = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    finalPath = finalPath.replace(`:${key}`, encodeURIComponent(value ?? ""));
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, value);
  }
  const qsString = qs.toString();
  return qsString ? `${finalPath}?${qsString}` : finalPath;
}

export async function WebhookIntegratedAgent(userPrompt, webhookConfig = {}) {
  const {
    url,
    method = "POST",
    headers = { "Content-Type": "application/json" },
    basePayload = {},
    customPrompt = "Analyze the data and generate a valid JSON payload.",
  } = webhookConfig;

  const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash");

  // Break the configured URL into its templated pieces (path params, query
  // params) so they can be resolved by the AI exactly like body fields are.
  const { pathTemplate, pathParams, queryParams } = url ? parseUrlTemplate(url) : {};

  // Combine URL pieces and body into one TEMPLATE structure. Sections with
  // nothing to fill are omitted so the prompt doesn't carry empty noise.
  const combinedTemplate = {
    ...(pathParams && Object.keys(pathParams).length ? { urlPathParams: pathParams } : {}),
    ...(queryParams && Object.keys(queryParams).length ? { urlQueryParams: queryParams } : {}),
    ...(Object.keys(basePayload).length ? { body: basePayload } : {}),
  };

  const promptText = `
${customPrompt}

You will be given TEMPLATE, a JSON object describing every place real values are needed for this
request, and DATA, the real information available (which may include a customer record, a raw
user instruction, timestamps, or other context).

TEMPLATE may contain any of these top-level sections — only the ones present apply:
- "urlPathParams": values that get substituted into the request URL's path (e.g. a route like
  "/thing/:id" needs the real id here).
- "urlQueryParams": values that get appended to the request URL's query string. Their current
  value is only an example/placeholder of the expected format, not a literal default.
- "body": the JSON body sent to the webhook, in whatever shape it needs to be.

Your job: return a single JSON object with EXACTLY the same top-level sections and the same nested
keys as TEMPLATE, with every value replaced by the correct real value drawn from DATA.

Rules for filling any placeholder, in any section, regardless of key names:
- Infer each key's intent from its name and from the shape/type of its placeholder value (empty
  string, empty array, empty object, 0, false, or an example value — these are all placeholders to
  be replaced, not values to keep).
- Match each key to the most semantically relevant field(s) in DATA. Use your judgment the way a
  competent integration engineer would — you are not limited to exact name matches.
- Preserve the exact type of each placeholder (string stays string, array stays array, object
  stays object, number stays number, boolean stays boolean) unless DATA makes it clear the value
  should be a specific literal.
- Values destined for a URL (urlPathParams, urlQueryParams) must be simple strings or numbers —
  never an object or array — since they get inserted directly into a URL.
- If a key's placeholder looks like free text (an instruction, note, prompt, or message field), you
  may lightly clean up or rephrase the relevant DATA text for clarity — but never invent facts that
  aren't in DATA.
- If TEMPLATE has a key you cannot confidently map to anything in DATA, keep its original
  placeholder value rather than guessing.
- Never add keys/sections that aren't in TEMPLATE, and never omit one that is.

Return ONLY the filled JSON object. No markdown fences, no explanation, no commentary.

TEMPLATE:
${JSON.stringify(combinedTemplate, null, 2)}

DATA:
${JSON.stringify(userPrompt, null, 2)}
  `;

  const raw = await executeDynamicPrompt(client, model, provider, promptText);
  if (!raw || !raw.trim()) throw new Error("AI returned empty response");

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response format");

  const filled = safeJsonParse(jsonMatch[0]);

  // aiData for display purposes stays focused on the body — that's the
  // part meant to be read as "what the agent extracted/decided".
  const aiPayload = filled?.body ?? filled ?? {};
  let finalResult = { aiData: aiPayload };

  if (url) {
    try {
      const finalUrl = buildFinalUrl(
        pathTemplate,
        filled?.urlPathParams ?? pathParams,
        filled?.urlQueryParams ?? queryParams
      );

      const fetchOptions = { method: method.toUpperCase(), headers };

      if (!["GET", "HEAD"].includes(fetchOptions.method)) {
        const finalBody = { ...basePayload, ...aiPayload };
        fetchOptions.body = JSON.stringify(finalBody);
      }

      const response = await fetch(finalUrl, fetchOptions);
      const responseData = await response.json().catch(() => null);
      finalResult.webhookResponse = { status: response.status, ok: response.ok, data: responseData };
    } catch (webhookError) {
      finalResult.webhookError = webhookError.message;
    }
  }

  return finalResult;
}


export async function productPriceCompareAgent(productName, products) {
  if (!products || products.length === 0) return "";
  const cheapest = products[0];
  const fallback = `The lowest price found for ${productName} is ${cheapest.price} on ${cheapest.platform}.`;

  try {
    // Dynamically pull your Master Key from Prisma just like your Sales Script agent
    const { client, model, provider } = await getDynamicAIContext("GEMINI", "models/gemini-2.5-flash-lite");

    const resultsText = products.map(p => `${p.platform}: ${p.price}`).join("\n");
    const promptText = `Product: ${productName}\nPrices:\n${resultsText}\nWrite exactly two short sentences. Mention the cheapest platform and price, and the total number of platforms found. Do not use markdown.`;

    const raw = await executeDynamicPrompt(client, model, provider, promptText);
    console.log(" output raw", raw)
    return raw ? raw.trim() : fallback;

  } catch (error) {
    console.error("AI Summary error:", error.message);
    return fallback; // Safe failover if the database AI key logic fails
  }
}

