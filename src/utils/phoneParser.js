// utils/phoneParser.js
//
// npm i libphonenumber-js
//
// Strict contact-number parsing for bulk import.
// - Country code is detected from the number itself (explicit "+" / "00", or digit prefix).
// - If nothing is detected, the number must be a valid INDIAN number (default "91").
// - Per-country length rules come from libphonenumber metadata, so 1/2/3-digit
//   country codes and their different national lengths are all handled.
// - 1010101010 is a special "no contact number" placeholder: it is accepted with the
//   default country code (91) and flagged with noContact: true so the import report
//   can tell the user which leads still need a real number.
// - Never throws. Always returns
//   { valid, countryCode, number, source, noContact, warnings, reason }.

import {
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from "libphonenumber-js/max";

export const DEFAULT_COUNTRY_CODE = "91";
const DEFAULT_REGION = "IN";

// Placeholder the user types for leads that have no contact number
export const NO_CONTACT_NUMBER = "1010101010";
const NO_CONTACT_WARNING =
  "Contact number is 1010101010 - this lead has no contact number. Add the real number later";

const LENGTH_REASONS = {
  TOO_SHORT: "Number is too short",
  TOO_LONG: "Number is too long",
  INVALID_LENGTH: "Number length is not valid",
  INVALID_COUNTRY: "Country code is not recognised",
  NOT_A_NUMBER: "Not a phone number",
};

const fail = (reason, extra = {}) => ({
  valid: false,
  countryCode: DEFAULT_COUNTRY_CODE,
  number: "",
  source: null,
  noContact: false,
  warnings: [],
  reason,
  ...extra,
});

// Matches: 1010101010, 01010101010, 911010101010, +911010101010, 00911010101010
const isNoContactPlaceholder = (digits) => {
  let d = digits.replace(/^0+/, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  return d === NO_CONTACT_NUMBER;
};

// Junk like 0000000000, 1111111111, 1234567890, 9999900000
const looksLikePlaceholder = (national) => {
  const d = national.replace(/\D/g, "");
  if (d.length < 6) return false;
  if (new Set(d).size <= 2) return true;
  const asc = "01234567890123456789";
  const desc = "98765432109876543210";
  return asc.includes(d) || desc.includes(d);
};

const explainFailure = (digits, withPlus) => {
  try {
    const r = validatePhoneNumberLength(withPlus ? `+${digits}` : digits, withPlus ? undefined : DEFAULT_REGION);
    if (r && LENGTH_REASONS[r]) return LENGTH_REASONS[r];
  } catch {
    /* ignore */
  }
  return withPlus
    ? "Not a valid number for the detected country code"
    : "Not a valid Indian number and no valid country code found";
};

// Parse ONE number (no multi-number splitting here)
const parseSingle = (rawIn) => {
  let raw = String(rawIn ?? "").trim();
  if (!raw) return fail("Contact number is empty");

  // Excel artefacts
  if (/^\d(\.\d+)?e[+-]?\d+$/i.test(raw.replace(/\s/g, ""))) {
    return fail(
      "Number was saved in scientific notation (e.g. 9.19E+11) – digits are lost. Format the column as Text in Excel and re-upload"
    );
  }
  if (/^\d+\.0+$/.test(raw)) raw = raw.replace(/\.0+$/, ""); // 9876543210.0 -> 9876543210

  // Strict character set: digits, + space - ( ) .
  if (!/^[+\d\s\-().]+$/.test(raw)) {
    return fail("Contains letters or invalid characters");
  }

  const digitsOnly = raw.replace(/\D/g, "");
  if (!digitsOnly) return fail("No digits found");
  if (digitsOnly.length < 6) return fail("Number is too short");
  if (digitsOnly.length > 15) return fail("Number is too long (max 15 digits incl. country code)");

  // ---------- 0) "No contact number" placeholder (1010101010) ----------
  if (isNoContactPlaceholder(digitsOnly)) {
    return {
      valid: true,
      countryCode: DEFAULT_COUNTRY_CODE,
      number: NO_CONTACT_NUMBER,
      source: "no-contact",
      noContact: true,
      warnings: [NO_CONTACT_WARNING],
      reason: null,
    };
  }

  const hasPlus = raw.startsWith("+");
  const hasZeroZero = !hasPlus && digitsOnly.startsWith("00");

  // ---------- 1) Explicit international format ----------
  if (hasPlus || hasZeroZero) {
    const intl = hasZeroZero ? digitsOnly.slice(2) : digitsOnly;
    const p = parsePhoneNumberFromString(`+${intl}`);
    if (!p || !p.isValid()) return fail(explainFailure(intl, true));
    if (looksLikePlaceholder(p.nationalNumber)) return fail("Looks like a placeholder / test number");
    return {
      valid: true,
      countryCode: String(p.countryCallingCode),
      number: String(p.nationalNumber),
      source: "explicit",
      noContact: false,
      warnings: [],
      reason: null,
    };
  }

  // ---------- 2) No "+" : try as Indian number first (default) ----------
  const inP = parsePhoneNumberFromString(digitsOnly, DEFAULT_REGION);
  if (inP && inP.isValid() && inP.country === "IN") {
    if (looksLikePlaceholder(inP.nationalNumber)) return fail("Looks like a placeholder / test number");
    return {
      valid: true,
      countryCode: DEFAULT_COUNTRY_CODE,
      number: String(inP.nationalNumber),
      source: "default",
      noContact: false,
      warnings: [],
      reason: null,
    };
  }

  // ---------- 3) Country code written without "+" (e.g. 18475970044) ----------
  const stripped = digitsOnly.replace(/^0+/, "");
  const pre = parsePhoneNumberFromString(`+${stripped}`);
  if (pre && pre.isValid()) {
    if (looksLikePlaceholder(pre.nationalNumber)) return fail("Looks like a placeholder / test number");
    return {
      valid: true,
      countryCode: String(pre.countryCallingCode),
      number: String(pre.nationalNumber),
      source: "prefix",
      noContact: false,
      warnings: [`Country code +${pre.countryCallingCode} was detected from the digits (no "+" in file)`],
      reason: null,
    };
  }

  return fail(explainFailure(digitsOnly, false));
};

// Parse a whole cell: may hold several numbers separated by , ; / | or new line.
// Returns the FIRST valid real number. If the cell only has the 1010101010
// placeholder, that is returned (noContact: true). A real number in the same
// cell always wins over the placeholder. Extra valid numbers become warnings.
export const parseContactCell = (cell) => {
  if (cell === null || cell === undefined || String(cell).trim() === "") {
    return { ...fail("Contact number is missing"), raw: "" };
  }

  const raw = String(cell).trim();
  const parts = raw.split(/[,;/|\n]/).map((s) => s.trim()).filter(Boolean);
  const results = parts.map(parseSingle);

  // prefer a real number over the 1010101010 placeholder
  const firstReal = results.findIndex((r) => r.valid && !r.noContact);
  const firstValidIdx = firstReal !== -1 ? firstReal : results.findIndex((r) => r.valid);

  if (firstValidIdx === -1) {
    const reasons = [...new Set(results.map((r) => r.reason))];
    return { ...fail(reasons.join(" / ")), raw };
  }

  const chosen = results[firstValidIdx];
  const ignored = results
    .map((r, i) => (i !== firstValidIdx && r.valid && !r.noContact ? parts[i] : null))
    .filter(Boolean);

  return {
    ...chosen,
    noContact: !!chosen.noContact,
    warnings: [
      ...chosen.warnings,
      ...(ignored.length ? [`Extra numbers in the cell were ignored: ${ignored.join(", ")}`] : []),
    ],
    raw,
  };
};