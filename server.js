/**
 * RPOS Customer Service Web API v8 middleware (READ-only MVP)
 * Auth: Shopify Dev Dashboard app via OAuth2 client credentials grant
 *
 * Env vars:
 *   SHOPIFY_SHOP=roqqiodev.myshopify.com
 *   SHOPIFY_CLIENT_ID=...
 *   SHOPIFY_CLIENT_SECRET=...
 *   SHOPIFY_API_VERSION=2026-01
 *
 * (Optional fallback, not needed if using client creds)
 *   SHOPIFY_TOKEN=shpat_...
 */

const http = require("http");
const { URL } = require("url");

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

// Dev Dashboard credentials (preferred)
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Legacy token fallback (optional)
const LEGACY_TOKEN = process.env.SHOPIFY_TOKEN;

// ----------------- utils -----------------
function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json;charset=UTF-8" });
  res.end(JSON.stringify(obj));
}

function sendMessage(res, statusCode, message) {
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

// ----------------- Shopify access token (client credentials grant) -----------------
// Shopify docs: POST https://{shop}.myshopify.com/admin/oauth/access_token
// Body (x-www-form-urlencoded): grant_type=client_credentials, client_id, client_secret
// Response includes access_token + expires_in (usually 86399 seconds). :contentReference[oaicite:1]{index=1}

let cachedAccessToken = null;
let cachedAccessTokenExpiresAtMs = 0;

function haveClientCreds() {
  return Boolean(SHOP && CLIENT_ID && CLIENT_SECRET);
}

async function fetchAccessTokenViaClientCredentials() {
  const tokenUrl = `https://${SHOP}/admin/oauth/access_token`;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error_description || json?.error || JSON.stringify(json) || `HTTP ${resp.status}`;
    throw new Error(`Shopify token error: ${msg}`);
  }

  if (!json.access_token) {
    throw new Error(`Shopify token error: missing access_token in response`);
  }

  const expiresInSec = Number(json.expires_in || 0);
  // Refresh a bit early (5 minutes)
  const refreshEarlyMs = 5 * 60 * 1000;
  const ttlMs = Math.max(0, expiresInSec * 1000 - refreshEarlyMs);

  cachedAccessToken = json.access_token;
  cachedAccessTokenExpiresAtMs = Date.now() + ttlMs;

  return cachedAccessToken;
}

async function getShopifyAccessToken() {
  // Prefer client credentials if configured
  if (haveClientCreds()) {
    if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAtMs) {
      return cachedAccessToken;
    }
    return await fetchAccessTokenViaClientCredentials();
  }

  // Fallback: legacy shpat_ token (if you still have it)
  if (SHOP && LEGACY_TOKEN) return LEGACY_TOKEN;

  throw new Error("Missing Shopify auth. Set SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET (preferred) or SHOPIFY_TOKEN (legacy).");
}

// ----------------- Shopify API callers -----------------
async function shopifyGraphql(query, variables) {
  if (!SHOP) throw new Error("Missing SHOPIFY_SHOP");
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
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
  if (!SHOP) throw new Error("Missing SHOPIFY_SHOP");
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/customers/${idNumeric}.json`, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Accept": "application/json",
    },
  });

  const json = await resp.json().catch(() => ({}));
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify REST error: ${msg}`);
  }
  return json.customer || null;
}

// ----------------- Mapping: Shopify -> RPOS v8 SimpleCustomer -----------------
function mapShopifyToV8SimpleCustomer(shopifyCustomer) {
  const idNumeric =
    shopifyCustomer?.id && typeof shopifyCustomer.id === "string" && shopifyCustomer.id.startsWith("gid://")
      ? shopifyCustomer.id.split("/").pop()
      : shopifyCustomer?.id;

  const entityId = sanitizeEntityId(String(idNumeric || ""));

  const firstName = shopifyCustomer?.firstName ?? shopifyCustomer?.first_name ?? "";
  const lastName = shopifyCustomer?.lastName ?? shopifyCustomer?.last_name ?? "";
  const email = shopifyCustomer?.email ?? "";
  const phone = shopifyCustomer?.phone ?? "";

  const now = isoNow();
  const far = isoFarFuture();

  const communicationMechanisms = [];
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

  // Only return an address if we can populate required fields reliably
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
    entityId: entityId || undefined,
    type: "PERSON",
    firstName,
    lastName,

    // required fields (demo defaults)
    vatExempt: false,
    subscribeNewsletter: false,
    acceptTermsAndConditions: false,
    dataProcessingAgreed: "UNDEFINED",
    loyaltyState: "NO_PARTNER",
    validFrom: now,
    validTo: far,

    communicationMechanisms,
    addresses,
  };
}

// ----------------- v8 handlers -----------------
async function handleV8Search(req, res, urlObj) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const qParam = urlObj.searchParams.get("q");
  if (!qParam) return sendMessage(res, 400, "Missing required query parameter: q");

  const limit = Math.max(1, Math.min(Number(urlObj.searchParams.get("limit") || 20), 100));
  const q = escapeForShopifySearch(qParam);

  // Robust query (handles +phone / digits / email / name / fallback)
  const raw = q;
  const isEmail = raw.includes("@");
  const digitsOnly = raw.replace(/[^\d]/g, "");

  const parts = [];
  if (isEmail) parts.push(`email:"${raw}"`);

  if (digitsOnly) {
    parts.push(`phone:"${digitsOnly}"`);
    parts.push(`phone:"+${digitsOnly}"`);
  }
  if (raw.startsWith("+") && digitsOnly) parts.push(`phone:"${raw}"`);

  parts.push(`name:"${raw}"`);
  parts.push(`"${raw}"`);

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

  const parts = [];
  if (email) parts.push(`email:"${email}"`);

  const phoneDigits = phone.replace(/[^\d]/g, "");
  if (phoneDigits) {
    parts.push(`phone:"${phoneDigits}"`);
    parts.push(`phone:"+${phoneDigits}"`);
  }

  if (firstName || lastName) parts.push(`name:"${[firstName, lastName].filter(Boolean).join(" ")}"`);

  if (parts.length === 0) return sendJson(res, 200, { customers: [] });

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

  const customer = await shopifyGetCustomerByIdNumeric(entityId);
  if (!customer) return sendMessage(res, 404, "customer not found");

  const simple = mapShopifyToV8SimpleCustomer(customer);
  return sendJson(res, 200, simple);
}

async function handleV8GetCustomersByCardId(req, res) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  // Shopify has no native "card id" for customers (unless you implement metafields).
  return sendJson(res, 200, { customers: [] });
}

// Optional debug endpoint (leave for your own testing; remove before production)
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

// ----------------- server -----------------
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, "http://localhost");

    if (req.method === "GET" && urlObj.pathname === "/") {
      return sendJson(res, 200, { status: "ok", rposApi: "v8", shopifyApi: API_VERSION });
    }

    if (req.method === "GET" && urlObj.pathname === "/customers") {
      return await handleLegacyCustomersDemo(res);
    }

    if (req.method === "GET" && urlObj.pathname === "/api/v8/customers/search") {
      return await handleV8Search(req, res, urlObj);
    }

    if (req.method === "GET" && urlObj.pathname === "/api/v8/customers/search-by-property") {
      return await handleV8SearchByProperty(req, res, urlObj);
    }

    const getCustomerMatch = urlObj.pathname.match(/^\/api\/v8\/customers\/([^/]+)$/);
    if (req.method === "GET" && getCustomerMatch) {
      return await handleV8GetCustomer(req, res, getCustomerMatch[1]);
    }

    const getByCardMatch = urlObj.pathname.match(/^\/api\/v8\/customers\/cards\/([^/]+)$/);
    if (req.method === "GET" && getByCardMatch) {
      return await handleV8GetCustomersByCardId(req, res);
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