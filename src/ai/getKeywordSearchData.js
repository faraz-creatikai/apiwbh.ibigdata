import { keywordSearchAgent } from "./agent.js";


const DEFAULT_FIELDS = [
  "Description",
  "Campaign",
  "CustomerType",
  "CustomerSubType",
  "customerName",
  "ContactNumber",
  "City",
  "Location",
  "SubLocation",
  "Price",
  "ReferenceId",
  "CustomerDate",
];

export async function getKeywordSearchData(keyword) {
  try {
    const aiResult = await keywordSearchAgent(keyword);

    if (
      !Array.isArray(aiResult.tokens) ||
      !Array.isArray(aiResult.fields)
    ) {
      throw new Error("Invalid AI response");
    }
console.log(" working");
    return {
      tokens: aiResult.tokens.filter(Boolean),
      fields: aiResult.fields.filter(f => DEFAULT_FIELDS.includes(f)),
    };
  } catch (err) {
    // 🔥 HARD FALLBACK (never break search)
    const tokens = keyword.split(" ").filter(Boolean);
console.log(" somethng went wrong",err);
    return {
      tokens,
      fields: DEFAULT_FIELDS,
    };
  }
}
