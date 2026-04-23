import { keywordSearchAgent, PropertyRecommendationAgent } from "./agent.js";


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
      priceRange: aiResult.priceRange || { min: null, max: null }
    };
  } catch (err) {
    // 🔥 HARD FALLBACK (never break search)
    const tokens = keyword.split(" ").filter(Boolean);
    console.log(" somethng went wrong", err);
    return {
      tokens,
      fields: DEFAULT_FIELDS,
    };
  }
}


export async function getRecommendedKeywordSearchData(keyword,customer,
  followups) {
  try {

    const userMessage = {
  customer: {
    name: customer.customerName,
    description: customer.Description,
    price: customer.PriceNumber,
    city: customer.City,
    location: customer.Location,
    sublocation: customer.SubLocation,
    campaign: customer.Campaign,
    customertype: customer.CustomerType,
    customersubtype: customer.CustomerSubType
  },
  followups: followups.map((f) => ({
    description: f.Description,
    startdate: f.StartDate,
    followupNextDate: f.FollowupNextDate,
    status: f.Status,
  })),
  userPrompt: keyword
};

console.log(" userMessage ", userMessage)
    const aiResult = await PropertyRecommendationAgent(userMessage);
    console.log(" data ", aiResult)
    if (
      !aiResult.filters ||
      !Array.isArray(aiResult.filters.tokens) ||
      !Array.isArray(aiResult.filters.fields)
    ) {
      throw new Error("Invalid AI response");
    }
    console.log(" working");
    return {
      tokens: aiResult.filters.tokens.filter(Boolean),
      fields: aiResult.filters.fields.filter(f => DEFAULT_FIELDS.includes(f)),
      priceRange: aiResult.filters.priceRange || { min: null, max: null },
      answer: aiResult.answer || "No specific answer provided"
    };
  } catch (err) {
    // 🔥 HARD FALLBACK (never break search)
    const tokens = keyword.split(" ").filter(Boolean);
    console.log(" somethng went wrong", err);
    return {
      tokens,
      fields: DEFAULT_FIELDS,
    };
  }
}