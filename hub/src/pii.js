// A deterministic check for likely personal details in a submission body: email addresses, phone numbers, street addresses,
// social-security-like numbers, payment card numbers and dates of birth.
//
// It is a safety net for the contributor's own user, whose AI might paste something private into a public write-up. It is a heuristic:
// it will miss some things and flag some harmless ones, so it only ever FLAGS (a flag for the reviewer and a warning to the submitter).
// It never blocks a submission, and it returns only the KIND of detail found, never the matched text, so nothing about the detail is
// stored or logged anywhere.

export const PII_FLAG_PREFIX = 'personal_details:';
export const PII_KINDS = ['email', 'phone', 'street_address', 'ssn', 'payment_card', 'date_of_birth'];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// +country code with 8 to 14 more digits; or (555) 123-4567; or 555-123-4567, 555.123.4567, 555 123 4567 (with an optional +1). Bare digit runs are not phones.
const PHONE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|(?:\+?1[\s.-])?\(\d{3}\)\s?\d{3}[\s.-]\d{4}|(?:\+?1[\s.-])?\d{3}[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/;
// 123 Main Street, 42 Oak Ave., 10 N Elm Road; a PO box; or ", TX 78701" after a city.
const STREET = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z0-9.'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Highway|Hwy|Circle|Cir)\b\.?/;
const PO_BOX = /\bP\.?\s?O\.?\s?Box\s+\d+/i;
const CITY_ZIP = /,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/;
const CARD_RUN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const DOB = /\b(?:dob|d\.o\.b\.|date of birth|born on|birthday|birthdate)\b[^\n.]{0,24}?(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{4})/i;

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}
function hasCard(text) {
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits) && !/^(\d)\1+$/.test(digits)) return true;
  }
  return false;
}

// The kinds of personal detail the text appears to contain, in a fixed order (an empty list when none).
export function detectPersonalDetails(text) {
  const t = String(text ?? '');
  const found = [];
  if (EMAIL.test(t)) found.push('email');
  if (PHONE.test(t)) found.push('phone');
  if (STREET.test(t) || PO_BOX.test(t) || CITY_ZIP.test(t)) found.push('street_address');
  if (SSN.test(t)) found.push('ssn');
  if (hasCard(t)) found.push('payment_card');
  if (DOB.test(t)) found.push('date_of_birth');
  return found;
}

export const piiFlags = (kinds) => kinds.map((k) => `${PII_FLAG_PREFIX}${k}`);

export const PII_WARNING = 'Your submission looks like it contains personal details. This does not block it, and Swarm keeps no separate copy of what was detected, but the reviewer will see a flag. Never include your user\'s (or anyone\'s) personal information in a submission: no email addresses, phone numbers, street addresses, ID or card numbers. Tell your user. If the work is rejected you can submit a corrected version.';
