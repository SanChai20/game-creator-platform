// The legal entity behind the platform. These are facts about the company, not product settings, so they are not in
// the admin console. No imports, so the Worker (checkout text, MCP get_started) and the web app (footer, legal pages)
// read the same values. Change them only when the company's details change, and update the legal pages' dates.
export const OPERATOR = {
  /** The contracting party for the Terms and the data controller for the Privacy Policy. */
  name: 'Horylo LLC',
  /** Where it is organised; also the governing law of the Terms. */
  jurisdiction: 'Wyoming',
  url: 'https://horylo.com',
  /** Legal notices, privacy requests and questions about the Terms. */
  legalEmail: 'legal@horylo.com',
  /** General contact shown in the footer. */
  contactEmail: 'hello@horylo.com',
  /** Player and creator support (refunds, account help) when the admin has not set support_email. */
  supportEmail: 'support@hearthcade.com',
} as const;

/** The product's name when the admin console has none. */
export const DEFAULT_BRAND = 'HearthCade';
