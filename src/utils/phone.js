// utils/phone.js
export const DEFAULT_COUNTRY_CODE = "91";
export const cleanNationalNumber = (num) => {
  if (!num) return "";
  return String(num).trim().replace(/[^0-9]/g, "");
};

// Builds the number Baileys needs: country code + national number, digits only (no "+").
// Today:  toWaNumber(c.ContactNumber)
// Later:  toWaNumber(c.ContactNumber, c.CountryCode)  // falls back to the default if it's empty
export const toWaNumber = (phone, countryCode = DEFAULT_COUNTRY_CODE) => {
  let digits = cleanNationalNumber(phone);
  if (!digits) return "";

  const cc = cleanNationalNumber(countryCode) || DEFAULT_COUNTRY_CODE;

  // drop the local "0" trunk prefix and the "00" international prefix
  digits = digits.replace(/^0+/, "");

  // a 10-digit number is national only, so add the country code.
  // anything longer is assumed to already include one.
  return digits.length <= 10 ? `${cc}${digits}` : digits;
};