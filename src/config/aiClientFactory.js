// utils/aiClientFactory.js
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Groq from "groq-sdk";
import Anthropic from "@anthropic-ai/sdk"; // <-- NEW: npm i @anthropic-ai/sdk
import prisma from "../config/prismaClient.js";
import { decryptKey } from "../utils/cryptoHelper.js";

// DO NOT remove these! The useFallback function needs them.
import { gemini } from "../config/gemini.js";
import { openai } from "../config/openai.js";
// Optional: import { groq } from "../config/groq.js" / import { anthropic } from "../config/anthropic.js"

/** DB / controller may say "CLAUDE" or "ANTHROPIC"; everything inside uses "ANTHROPIC". */
const normalizeProvider = (p) => {
  const v = String(p || "").trim().toUpperCase();
  return v === "CLAUDE" ? "ANTHROPIC" : v;
};

/** Builds the right SDK client for a provider. Returns null for an unsupported provider. */
const buildClient = (provider, apiKey) => {
  switch (provider) {
    case "GEMINI":
      return new GoogleGenAI({ apiKey });
    case "OPENAI":
      return new OpenAI({ apiKey });
    case "GROQ":
      return new Groq({ apiKey });
    case "ANTHROPIC":
      return new Anthropic({ apiKey });
    default:
      return null;
  }
};

/**
 * Resolves the SDK by finding the SINGLE globally active master system key.
 * Falls back to hardcoded defaults if no custom master key is configured.
 * @param {'GEMINI' | 'OPENAI' | 'GROQ' | 'ANTHROPIC'} defaultProvider - The fallback provider if DB is empty
 * @param {string} defaultModel - The hardcoded model string to fall back to
 * @returns {Promise<{ client: any, model: string, provider: string }>}
 *
 * NOTE for callers: each SDK has its own call style. Check `provider` before calling:
 *   GEMINI     -> client.models.generateContent({ model, contents })
 *   OPENAI/GROQ-> client.chat.completions.create({ model, messages })
 *   ANTHROPIC  -> client.messages.create({ model, max_tokens, system, messages })   (max_tokens is REQUIRED)
 */
export async function getDynamicAIContext(defaultProvider, defaultModel) {
  const requested = normalizeProvider(defaultProvider);
  console.log(`[AI Factory] Requested Default Provider: ${requested}, Model: ${defaultModel}`);

  const useFallback = () => {
    console.log(`[AI Factory] USING FALLBACK FOR: ${requested}`);

    let fallbackClient;
    if (requested === "GEMINI") {
      fallbackClient = gemini;
    } else if (requested === "GROQ") {
      fallbackClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else if (requested === "ANTHROPIC") {
      fallbackClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
      fallbackClient = openai;
    }

    return { client: fallbackClient, model: defaultModel, provider: requested };
  };

  try {
    const configRecord = await prisma.adminAiApiKey.findFirst({
      where: {
        status: "ACTIVE",
        admin: { role: "administrator" },
      },
    });

    if (!configRecord) {
      console.log("[AI Factory] No active DB key found. Triggering fallback.");
      return useFallback();
    }

    const plainTextKey = decryptKey(configRecord.apiKey);
    if (!plainTextKey) {
      console.warn(`[AI Factory] Failed to decrypt master key for ${configRecord.provider}. Triggering fallback.`);
      return useFallback();
    }

    const activeProvider = normalizeProvider(configRecord.provider);
    const clientInstance = buildClient(activeProvider, plainTextKey);

    if (!clientInstance) {
      console.warn(`[AI Factory] Unsupported active provider in DB: ${activeProvider}. Triggering fallback.`);
      return useFallback();
    }

    console.log(`[AI Factory] SUCCESS: Database override active. Using DB Provider: ${activeProvider}`);

    return {
      client: clientInstance,
      model: configRecord.model || defaultModel,
      provider: activeProvider,
    };
  } catch (error) {
    console.error(`[AI Factory] Error resolving system AI context:`, error.message);
    return useFallback();
  }
}