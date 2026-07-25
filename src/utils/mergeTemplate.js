// utils/mergeTemplate.js

// ─────────────────────────────────────────────────────────────
// Shared responsive rules, injected via {{RESPONSIVE_STYLES}}.
// One place to edit breakpoint behavior for every template.
// ─────────────────────────────────────────────────────────────
const RESPONSIVE_STYLES = `
<style>
  @media only screen and (max-width: 600px) {
    .ec-outer { padding: 20px 12px !important; }
    .ec-inner-pad { padding: 24px 18px !important; }
    .ec-service-cell { display: block !important; width: 100% !important; padding: 6px 0 !important; }
    .ec-service-empty { display: none !important; }
  }
</style>`;

function toLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// variant: "light" (default, for white/light card backgrounds)
//        | "dark"  (for dark-card templates like promo-offer, dark-luxury-offer)
function renderCustomerFieldsRows(customerFields, variant = 'light') {
  const palette =
    variant === 'dark'
      ? { label: '#e2e8f0', value: '#94a3b8', empty: '#64748b' }
      : { label: '#0f172a', value: '#475569', empty: '#94a3b8' };

  const entries = Object.entries(customerFields || {}).filter(([, v]) => {
    if (v === null || v === undefined) return false;
    return String(v).trim().length > 0;
  });

  if (!entries.length) {
    return `<tr><td colspan="2" style="padding:6px 0; color:${palette.empty}; font-size:13px; font-style:italic;">No additional details available.</td></tr>`;
  }

  return entries
    .map(([key, value]) => {
      const label = escapeHtml(toLabel(key));
      const val = escapeHtml(value);
      return `<tr>
        <td width="35%" style="padding: 6px 0; color: ${palette.label}; font-weight: 600; font-size: 14px; vertical-align: top;">${label}:</td>
        <td width="65%" style="padding: 6px 0; color: ${palette.value}; font-size: 14px; vertical-align: top;">${val}</td>
      </tr>`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// "Our Services" — SINGLE SOURCE OF TRUTH.
// Edit this array only. It's used by every template automatically
// via the {{OUR_SERVICES_ROWS}} / {{OUR_SERVICES_ROWS_DARK}} tokens —
// no need to touch emailTemplate.ts when the offering changes.
// `icon` is a plain emoji so nothing needs to be hosted/uploaded.
// ─────────────────────────────────────────────────────────────
const OUR_SERVICES = [
  {
    icon: '🤖',
    title: 'AI Agents',
    description: 'Custom AI agents that handle leads, bookings, and support on your website automatically.',
  },
  {
    icon: '🔍',
    title: 'SEO-Optimized Website',
    description: 'Search-ready pages built to rank — clean structure, fast load times, proper metadata.',
  },
  {
    icon: '💬',
    title: 'AI Chatbot',
    description: 'A trained chatbot on your site that answers visitor questions and captures leads 24/7.',
  },
  {
    icon: '🎨',
    title: 'Design Improvement',
    description: 'A refreshed, modern look for your existing site — better UX, better conversions.',
  },
];



// variant: "light" (default) | "dark" — same idea as renderCustomerFieldsRows
function renderOurServicesRows(variant = 'light') {
  const palette =
    variant === 'dark'
      ? { cardBg: 'rgba(255,255,255,0.04)', cardBorder: 'rgba(255,255,255,0.1)', title: '#f1f5f9', desc: '#94a3b8' }
      : { cardBg: '#f8fafc', cardBorder: '#e2e8f0', title: '#0f172a', desc: '#64748b' };

  const cell = (s) => `
    <td width="50%" valign="top" class="ec-service-cell" style="padding:6px;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${palette.cardBg}; border:1px solid ${palette.cardBorder}; border-radius:8px;">
        <tr>
          <td style="padding:16px;">
            <p style="margin:0 0 8px 0; font-size:22px; line-height:1;">${escapeHtml(s.icon)}</p>
            <p style="margin:0 0 4px 0; font-size:13px; font-weight:700; color:${palette.title};">${escapeHtml(s.title)}</p>
            <p style="margin:0; font-size:11.5px; line-height:1.5; color:${palette.desc};">${escapeHtml(s.description)}</p>
          </td>
        </tr>
      </table>
    </td>`;

  const emptyCell = `<td width="50%" class="ec-service-empty" style="padding:6px;">&nbsp;</td>`;

  let rows = '';
  for (let i = 0; i < OUR_SERVICES.length; i += 2) {
    const first = cell(OUR_SERVICES[i]);
    const second = OUR_SERVICES[i + 1] ? cell(OUR_SERVICES[i + 1]) : emptyCell;
    rows += `<tr>${first}${second}</tr>\n`;
  }
  return rows;
}

export function replacePlaceholders(str, customer) {
  if (!str) return str;
  const map = {
    Name: customer.customerName || '',
    City: customer.City || '',
    Campaign: customer.Campaign || '',
    ContactNumber: customer.ContactNumber || '',
    Email: customer.Email || '',
  };
  let out = str;
  for (const [key, val] of Object.entries(map)) {
    out = out.replaceAll(`{{${key}}}`, val);
  }
  if (customer.CustomerFields) {
    for (const [k, v] of Object.entries(customer.CustomerFields)) {
      out = out.replaceAll(`{{CustomerFields.${k}}}`, v ?? '');
    }
  }
  out = out.replaceAll('{{CUSTOMER_FIELDS_ROWS}}', renderCustomerFieldsRows(customer.CustomerFields, 'light'));
  out = out.replaceAll('{{CUSTOMER_FIELDS_ROWS_DARK}}', renderCustomerFieldsRows(customer.CustomerFields, 'dark'));
  out = out.replaceAll('{{OUR_SERVICES_ROWS}}', renderOurServicesRows('light'));
  out = out.replaceAll('{{OUR_SERVICES_ROWS_DARK}}', renderOurServicesRows('dark'));
  out = out.replaceAll('{{RESPONSIVE_STYLES}}', RESPONSIVE_STYLES); // ← new
  return out;
}

export function mergeAiContentIntoTemplate(templateHtml, aiBody, customer) {
  const filled = replacePlaceholders(templateHtml, customer);
  return filled.includes('{{AI_CONTENT}}')
    ? filled.replace('{{AI_CONTENT}}', aiBody)
    : filled.replace('</body>', `<p>${aiBody}</p></body>`);
}

// utils/mergeTemplate.js

// ... keep everything you already have (toLabel, escapeHtml, renderCustomerFieldsRows, OUR_SERVICES, renderOurServicesRows, replacePlaceholders, mergeAiContentIntoTemplate) ...

// ─────────────────────────────────────────────────────────────
// Fallback template used whenever the frontend doesn't send a
// templateHtml (i.e. user didn't pick one from the picker).
// No branding/colors — just the AI message + the same info
// sections every other template shows.
// ─────────────────────────────────────────────────────────────
export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{Campaign}}</title>
  {{RESPONSIVE_STYLES}}
</head>
<body style="margin:0; padding:0; background-color:#ffffff; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" class="ec-outer" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
          <tr>
            <td style="padding-bottom:20px;">
              <p style="margin:0; font-size:14px; color:#64748b;">Hi {{Name}},</p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:24px; color:#1e293b; font-size:15px; line-height:1.7;">
              <p style="margin:0 0 16px 0;">{{AI_CONTENT}}</p>
              <p style="margin:0;">Best,<br>Creatik Ai Solution</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 0; border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 12px 0; font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Domain Status</p>
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                {{CUSTOMER_FIELDS_ROWS}}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 0; border-top:1px solid #e2e8f0;">
              <p style="margin:0 0 12px 0; font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Our Services</p>
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                {{OUR_SERVICES_ROWS}}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px; border-top:1px solid #e2e8f0;">
              <p style="margin:0; font-size:12px; color:#94a3b8;">{{Email}} · {{ContactNumber}} · {{City}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;