// utils/phone.js
export const DEFAULT_COUNTRY_CODE = "91";
export const cleanNationalNumber = (num) => {
  if (!num) return "";
  return String(num).trim().replace(/[^0-9]/g, "");
};