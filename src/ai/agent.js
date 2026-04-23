import { gemini } from "../config/gemini.js";
import { openai } from "../config/openai.js";
import { callingAgentSystemPrompt } from "./prompts/callingAgentPrompt.js";
import { dataminingPrompt, miningDataPrompt } from "./prompts/dataminingAgentPrompt.js";
import { followupPrompt } from "./prompts/followupPrompt.js";
import { keywordSearchPrompt } from "./prompts/keywordSearchPrompt.js";
import { propertyRecommendationPrompt } from "./prompts/propertyRecommendationPrompt.js";
import { qualifyCustomerPrompt } from "./prompts/qualifyCustomerPrompt.js";


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

  console.log(" naeruto ", safeJsonParse(raw))

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  return safeJsonParse(raw);
}

export async function keywordSearchAgentOpenai(userPrompt) {
  const response = await openai.chat.completions.create({
    model: "openai/gpt-oss-120b:free",
    messages: [
      {
        role: "user",
        content: `${keywordSearchPrompt}\n\nUser input:\n${userPrompt}`
      }
    ],
  });

  const raw = response.choices?.[0]?.message?.content;

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  return safeJsonParse(raw);
}

export async function followupAgent(userPrompt) {
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${followupPrompt}\n\nUser input:\n${userPrompt}`
          }
        ]
      }
    ],
  });

  const raw = response?.text;
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
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${qualifyCustomerPrompt}
DATA:
${JSON.stringify(userPrompt, null, 2)}`
          }
        ]
      }
    ],
  });

  const raw = response?.text;
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
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${callingAgentSystemPrompt}
DATA:
${JSON.stringify(userPrompt, null, 2)}`
          }
        ]
      }
    ],
  });

  const raw = response?.text;
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
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${propertyRecommendationPrompt}
DATA:
${JSON.stringify(userPrompt, null, 2)}`
          }
        ]
      }
    ],
  });

  const raw = response?.text;
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
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `
${dataminingPrompt}
DATA:
${JSON.stringify(data, null, 2)}
            `
          }
        ]
      }
    ],
  });

  const raw = response?.text;

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid AI response");

  return JSON.parse(jsonMatch[0]);
}

export async function MiningDataAgent(userPrompt) {
  const response = await gemini.models.generateContent({
    model: "models/gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${miningDataPrompt}
DATA:
${JSON.stringify(userPrompt, null, 2)}`
          }
        ]
      }
    ],
  });

  const raw = response?.text;
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

export async function followupAgentOpenai(userPrompt) {
  const response = await openai.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `${followupPrompt}\n\nUser input:\n${userPrompt}`
      }
    ],
  });

  const raw = response.choices?.[0]?.message?.content;

  if (!raw || !raw.trim()) {
    throw new Error("AI returned empty response");
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Invalid AI response format");
  }

  return safeJsonParse(jsonMatch[0]);
}