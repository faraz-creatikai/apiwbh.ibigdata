import { gemini } from "../config/gemini.js";
import { keywordSearchPrompt } from "./prompts/keywordSearchPrompt.js";


export function safeJsonParse(raw) {
  if (!raw) return null;

  // Remove ```json ... ``` or ``` ... ``` fences
  const cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn("Failed to parse JSON:", cleaned);
    return null;
  }
}


export async function keywordSearchAgent(userPrompt) {
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [{ text: `${keywordSearchPrompt}\n\nUser input:\n${userPrompt}` }]
      }
    ],
  });

  const raw = response?.text;

  console.log(" naeruto ",safeJsonParse(raw))

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  return safeJsonParse(raw);
}
