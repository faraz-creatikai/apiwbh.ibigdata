// utils/aiClientFactory.js
import { GoogleGenAI } from "@google/genai"; 
import OpenAI from "openai";
import prisma from "../config/prismaClient.js";
import { decryptKey } from "../utils/cryptoHelper.js";

// DO NOT remove these! The useFallback function needs them.
import { gemini } from "../config/gemini.js";
import { openai } from "../config/openai.js";

/**
 * Resolves the SDK by finding the SINGLE globally active master system key.
 * Falls back to hardcoded defaults if no custom master key is configured.
 * @param {'GEMINI' | 'OPENAI'} defaultProvider - The fallback provider if DB is empty
 * @param {string} defaultModel - The hardcoded model string to fall back to
 * @returns {Promise<{ client: any, model: string, provider: string }>}
 */
export async function getDynamicAIContext(defaultProvider, defaultModel) {
  // Helper to instantly serve your existing hardcoded setups based on the requested default
  const useFallback = () => ({
    client: defaultProvider === "GEMINI" ? gemini : openai,
    model: defaultModel,
    provider: defaultProvider, // Let the caller know which provider was loaded
  });

  try {
    // Look up the SINGLE active key belonging to the master 'administrator'.
    // Notice we REMOVED the provider filter. The DB dictates the global active AI.
    const configRecord = await prisma.adminAiApiKey.findFirst({
      where: {
        status: "ACTIVE",
        admin: {
          role: "administrator" // Automatically links to your Admin model's enum
        }
      },
    });

    // If absolutely nothing is active in the DB, use the fallback
    if (!configRecord) {
      return useFallback();
    }

    const plainTextKey = decryptKey(configRecord.apiKey);
    if (!plainTextKey) {
      console.warn(`Failed to decrypt master key for ${configRecord.provider}. Falling back to default.`);
      return useFallback();
    }

    let clientInstance;
    const activeProvider = configRecord.provider.toUpperCase();

    // Instantiate whichever client is marked ACTIVE in the database
    if (activeProvider === "GEMINI") {
      clientInstance = new GoogleGenAI({ apiKey: plainTextKey || process.env.GEMINI_API_KEY });
    } else if (activeProvider === "OPENAI") {
      clientInstance = new OpenAI({ apiKey: plainTextKey || process.env.OPENAI_API_KEY });
    } else {
      console.warn(`Unsupported active provider in DB: ${activeProvider}. Falling back to default.`);
      return useFallback();
    }

    return {
      client: clientInstance,
      model: configRecord.model || defaultModel, 
      provider: activeProvider // Let the caller know which provider was loaded
    };
    
  } catch (error) {
    console.error(`Error resolving system AI context:`, error.message);
    return useFallback(); // Safe failover if the database is unreachable
  }
}