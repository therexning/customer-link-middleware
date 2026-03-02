/**
 * RPOS Customer Service Web API v8 middleware (READ-only MVP)
 * POS -> this middleware -> Shopify
 *
 * Env vars:
 *   SHOPIFY_SHOP=roqqiodev.myshopify.com
 *   SHOPIFY_TOKEN=shpat_... (from Secret Manager on Cloud Run)
 *   SHOPIFY_API_VERSION=2026-01
 */

const http = require("http");
const { URL } = require("url");

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json;charset=UTF-8" });
  res.end(JSON.stringify(obj));
}

function sendMessage(res, statusCode, message) {
  // v8 uses MessageResponse { message: string } for errors often
  sendJson(res, statusCode, { message });
}

function isoNow() {
  return new Date().toISOString();
}

function isoFarFuture() {
  return "2039-01-01T00:00:00.000Z";
}

function requireStoreId(req) {
  // Header name in YAML is storeId; Node lowercases headers.
  const storeId = req.headers["storeid"];
  return storeId ? String(storeId) : "";
}

// v8 says entityId must only contain letters/digits/minus
function sanitizeEntityId(raw) {
  return String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeForShopifySearch(q) {
  return String(q || "").replace(/"/g, '\\"').trim();
}

async function shopifyGraphql(query, variables) {
  if (!SHOP || !TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_TOKEN");
  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify API error: ${msg}`);
  }
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function shopifyGetCustomerByIdNumeric(idNumeric) {
  if (!SHOP || !TOKEN) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_TOKEN");

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/customers/${idNumeric}.json`, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Accept": "application/json",
    },
  });

  const json = await resp.json();
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify REST error: ${msg}`);
  }
  return json.customer || null;
}

/**
 * Map Shopify customer -> RPOS v8 SimpleCustomer
 * v8 required fields we always fill:
 *  - type
 *  - vatExempt
 *  - subscribeNewsletter
 *  - acceptTermsAndConditions
 *  - dataProcessingAgreed
 *  - loyaltyState
 *  - validFrom
 *  - validTo
 *
 * Plus typical fields: firstName, lastName, addresses, communicationMechanisms
 */
function mapShopifyToV8SimpleCustomer(shopifyCustomer) {
  // GraphQL node and REST customer differ a bit; normalize:
  const idGid = shopifyCustomer?.id || "";
  const idNumeric =
    shopifyCustomer?.id && typeof shopifyCustomer.id === "string" && shopifyCustomer.id.startsWith("gid://")
      ? shopifyCustomer.id.split("/").pop()
      : shopifyCustomer?.id; // REST numeric id

  const entityId = sanitizeEntityId(String(idNumeric || ""));

  const firstName = shopifyCustomer?.firstName ?? shopifyCustomer?.first_name ?? "";
  const lastName = shopifyCustomer?.lastName ?? shopifyCustomer?.last_name ?? "";
  const email = shopifyCustomer?.email ?? "";
  const phone = shopifyCustomer?.phone ?? "";

  // Communication mechanisms (best effort)
  const communicationMechanisms = [];
  const now = isoNow();
  const far = isoFarFuture();

  if (phone) {
    communicationMechanisms.push({
      type: "PHONE",
      data: String(phone),
      advertising: false,
      priority: 0,
      validFrom: now,
      validTo: far,
    });
  }
  if (email) {
    communicationMechanisms.push({
      type: "EMAIL",
      data: String(email),
      advertising: false,
      priority: phone ? 1 : 0,
      validFrom: now,
      validTo: far,
    });
  }

  // Address (only include if we can satisfy required fields inside PartyPostalAddress)
  // v8 PartyPostalAddress requires: type, countryCode, city, zip, street, buildingNumber
  let addr =
    shopifyCustomer?.defaultAddress ||
    shopifyCustomer?.default_address ||
    (Array.isArray(shopifyCustomer?.addresses) ? shopifyCustomer.addresses[0] : null);

  const addresses = [];
  if (addr) {
    const street = addr.address1 || addr.address_1 || "";
    const buildingNumber = addr.address2 || addr.address_2 || "0";
    const city = addr.city || "";
    const zip = addr.zip || "";
    const countryCode = addr.countryCodeV2 || addr.country_code || addr.countryCode || "";

    if (street && city && zip && countryCode) {
      addresses.push({
        type: "DELIVERY",
        street,
        buildingNumber,
        zip,
        city,
        countryCode,
        validFrom: now,
        validTo: far,
      });
    }
  }

  return {
    entityId: entityId || undefined, // optional in schema, but useful
    type: "PERSON",

    firstName,
    lastName,

    // Required flags/enums/dates (demo defaults)
    vatExempt: false,
    subscribeNewsletter: false,
    acceptTermsAndConditions: false,
    dataProcessingAgreed: "UNDEFINED",
    loyaltyState: "NO_PARTNER",
    validFrom: now,
    validTo: far,

    // Optional best-effort
    communicationMechanisms,
    addresses,
  };
}

// ------- RPOS v8 endpoints -------

async function handleV8Search(req, res, urlObj) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const qParam = urlObj.searchParams.get("q");
  if (!qParam) return sendMessage(res, 400, "Missing required query parameter: q");

  const limit = Math.max(1, Math.min(Number(urlObj.searchParams.get("limit") || 20), 100));
  const q = escapeForShopifySearch(qParam);

  // Shopify customer search syntax (best-effort)
  // More robust Shopify customer search query
const raw = q; // already escaped for quotes
const isEmail = raw.includes("@");

// normalize phone: keep digits only (and leading + optional), Shopify often matches digits better
const digitsOnly = raw.replace(/[^\d]/g, "");
const phoneCandidates = [];
if (digitsOnly) {
  phoneCandidates.push(`phone:"${digitsOnly}"`);
  phoneCandidates.push(`phone:"+${digitsOnly}"`);
}
if (raw.startsWith("+") && digitsOnly) {
  phoneCandidates.push(`phone:"${raw}"`);
}

// Build query parts (use quoted values to avoid special-char issues)
const parts = [];
if (isEmail) parts.push(`email:"${raw}"`);
parts.push(...phoneCandidates);

// Name / general text fallback (Shopify usually supports general text search)
parts.push(`name:"${raw}"`);
parts.push(`"${raw}"`);

// Join with OR to maximize chances of a hit
const shopifyQuery = parts.join(" OR ");

  const gql = `
    query SearchCustomers($query: String!, $first: Int!) {
      customers(first: $first, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
            defaultAddress {
              address1
              address2
              city
              zip
              countryCodeV2
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(gql, { query: shopifyQuery, first: limit });
  const edges = data?.customers?.edges || [];
  const customers = edges.map((e) => mapShopifyToV8SimpleCustomer(e.node));

  return sendJson(res, 200, { customers });
}

async function handleV8SearchByProperty(req, res, urlObj) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const limit = Math.max(1, Math.min(Number(urlObj.searchParams.get("limit") || 20), 100));

  const firstName = escapeForShopifySearch(urlObj.searchParams.get("firstName") || "");
  const lastName = escapeForShopifySearch(urlObj.searchParams.get("lastName") || "");
  const email = escapeForShopifySearch(urlObj.searchParams.get("email") || "");
  const phone = escapeForShopifySearch(urlObj.searchParams.get("phone") || "");
  const city = escapeForShopifySearch(urlObj.searchParams.get("city") || "");
  const zip = escapeForShopifySearch(urlObj.searchParams.get("zip") || "");
  const street = escapeForShopifySearch(urlObj.searchParams.get("street") || "");

  // Build a conservative Shopify query using what it supports well.
  // Address fields are not guaranteed searchable; we include name/email/phone primarily.
  const parts = [];
  if (email) parts.push(`email:${email}`);
  if (phone) parts.push(`phone:${phone}`);
  if (firstName || lastName) parts.push(`name:${[firstName, lastName].filter(Boolean).join(" ")}`);
  if (city) parts.push(`city:${city}`);   // may or may not work depending on Shopify search indexing
  if (zip) parts.push(`zip:${zip}`);      // same
  if (street) parts.push(`address1:${street}`); // same

  if (parts.length === 0) {
    // No usable filters -> return empty (instead of returning everyone)
    return sendJson(res, 200, { customers: [] });
  }

  const shopifyQuery = parts.join(" OR ");

  const gql = `
    query SearchCustomersByProperty($query: String!, $first: Int!) {
      customers(first: $first, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
            defaultAddress {
              address1
              address2
              city
              zip
              countryCodeV2
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(gql, { query: shopifyQuery, first: limit });
  const edges = data?.customers?.edges || [];
  const customers = edges.map((e) => mapShopifyToV8SimpleCustomer(e.node));

  return sendJson(res, 200, { customers });
}

async function handleV8GetCustomer(req, res, entityIdRaw) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const entityId = sanitizeEntityId(entityIdRaw);
  if (!entityId) return sendMessage(res, 400, "Invalid entityId");

  // Our entityId is the Shopify numeric ID (demo strategy).
  const customer = await shopifyGetCustomerByIdNumeric(entityId);
  if (!customer) return sendMessage(res, 404, "customer not found");

  const simple = mapShopifyToV8SimpleCustomer(customer);
  return sendJson(res, 200, simple);
}

async function handleV8GetCustomersByCardId(req, res /*, cardId */) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  // Shopify doesn't have customer card id out of the box.
  // For MVP, return empty result.
  return sendJson(res, 200, { customers: [] });
}

// ------- debug endpoint (optional) -------
async function handleLegacyCustomersDemo(res) {
  const gql = `
    query {
      customers(first: 5) {
        edges {
          node { id firstName lastName email phone }
        }
      }
    }
  `;
  const data = await shopifyGraphql(gql, {});
  return sendJson(res, 200, data);
}

// ------- server -------
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, "http://localhost");

    // Health
    if (req.method === "GET" && urlObj.pathname === "/") {
      return sendJson(res, 200, { message: "Middleware running" });
    }

    // Optional: legacy debug endpoint (keep if useful)
    if (req.method === "GET" && urlObj.pathname === "/customers") {
      return await handleLegacyCustomersDemo(res);
    }

    // v8: Full-text search
    if (req.method === "GET" && urlObj.pathname === "/api/v8/customers/search") {
      return await handleV8Search(req, res, urlObj);
    }

    // v8: Search by property
    if (req.method === "GET" && urlObj.pathname === "/api/v8/customers/search-by-property") {
      return await handleV8SearchByProperty(req, res, urlObj);
    }

    // v8: Get by entityId
    const getCustomerMatch = urlObj.pathname.match(/^\/api\/v8\/customers\/([^/]+)$/);
    if (req.method === "GET" && getCustomerMatch) {
      return await handleV8GetCustomer(req, res, getCustomerMatch[1]);
    }

    // v8: Get by card id
    const getByCardMatch = urlObj.pathname.match(/^\/api\/v8\/customers\/cards\/([^/]+)$/);
    if (req.method === "GET" && getByCardMatch) {
      return await handleV8GetCustomersByCardId(req, res, getByCardMatch[1]);
    }

    return sendMessage(res, 404, "Not found");
  } catch (err) {
    return sendMessage(res, 500, err?.message || String(err));
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});