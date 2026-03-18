/**
 * RPOS Customer Service Web API v8 + Voucher Service Web API v3 middleware
 *
 * Supports:
 *  - GET  /api/v8/customers/search?q=...
 *  - GET  /api/v8/customers/{entityId}
 *  - PUT  /api/v8/customers/{entityId}   (MVP: firstName/lastName/email/phone only)
 *  - POST /api/v8/customers              (MVP: firstName/lastName/email/phone only)
 *  - GET  /api/v2/customer-history/{customerId}
 *
 *  - GET  /api/v3/vouchers/{domain}/{voucherId}
 *  - GET  /api/v3/vouchers/{voucherId}
 *  - POST /api/v3/vouchers/{domain}
 *  - POST /api/v3/vouchers/{domain}/{voucherId}/redeem
 *  - POST /api/v3/sales
 *  - POST /{store}/api/v3/sales
 *
 * Not implemented (returns 501):
 *  - POST   /api/v3/vouchers/{domain}/{voucherId}            (CreateVoucherWithId)
 *  - POST   /api/v3/vouchers/{domain}/{voucherId}/charge
 *  - DELETE /api/v3/vouchers/{domain}/{voucherId}/{transactionId}
 *  - GET    /api/v3/customer-vouchers/{customerId}
 *  - GET    /api/v3/customer-vouchers/{domain}/{customerId}
 *
 * Auth to Shopify:
 *  - Dev Dashboard App via OAuth2 Client Credentials Grant
 *
 * Env vars (Cloud Run):
 *  - SHOPIFY_SHOP=roqqiodev.myshopify.com
 *  - SHOPIFY_CLIENT_ID
 *  - SHOPIFY_CLIENT_SECRET
 *  - SHOPIFY_API_VERSION=2026-01
 *  - CUSTOMER_WRITE_MODE=enabled|block_update|block_create|block_all
 *
 * Notes:
 *  - Customer API requires header: storeId
 *  - Voucher API contract also mentions workstationId, clientId, merchantId.
 *    This middleware currently validates storeId and accepts the others if present.
 */

const http = require("http");
const { URL } = require("url");
const { XMLParser } = require("fast-xml-parser");

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const LOG_SHOPIFY_ORDER_PAYLOAD = process.env.LOG_SHOPIFY_ORDER_PAYLOAD === "true";
const CUSTOMER_WRITE_MODE = String(process.env.CUSTOMER_WRITE_MODE || "enabled").trim().toLowerCase();

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// ----------------- helpers -----------------
function sendJson(res, statusCode, obj, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json;charset=UTF-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function sendMessage(res, statusCode, message) {
  sendJson(res, statusCode, { message });
}

function sendEmpty(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, extraHeaders);
  res.end();
}

function isoNow() {
  return new Date().toISOString();
}

function isoFarFuture() {
  return "2039-01-01T00:00:00.000Z";
}

function toDateOnly(input, fallback = "2100-01-01") {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

function requireStoreId(req) {
  const storeId = req.headers["storeid"]; // node lowercases headers
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

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return "__INVALID_JSON__";
  }
}

async function readTextBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function requireVoucherHeaders(req, res) {
  const storeId = requireStoreId(req);
  if (!storeId) {
    sendMessage(res, 400, "Missing required header: storeId");
    return false;
  }
  return true;
}

function canCreateCustomer() {
  return CUSTOMER_WRITE_MODE !== "block_create" && CUSTOMER_WRITE_MODE !== "block_all";
}

function canUpdateCustomer() {
  return CUSTOMER_WRITE_MODE !== "block_update" && CUSTOMER_WRITE_MODE !== "block_all";
}

function logCustomerWriteBlock(action, details = {}) {
  console.log("customer write blocked", JSON.stringify({
    action,
    mode: CUSTOMER_WRITE_MODE,
    ...details,
  }));
}

// ----------------- Shopify access token (client credentials grant) -----------------
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error_description || json?.error || JSON.stringify(json) || `HTTP ${resp.status}`;
    throw new Error(`Shopify token error: ${msg}`);
  }
  if (!json.access_token) throw new Error("Shopify token error: missing access_token in response");

  const expiresInSec = Number(json.expires_in || 0);
  const refreshEarlyMs = 5 * 60 * 1000;
  const ttlMs = Math.max(0, expiresInSec * 1000 - refreshEarlyMs);

  cachedAccessToken = json.access_token;
  cachedAccessTokenExpiresAtMs = Date.now() + ttlMs;
  return cachedAccessToken;
}

async function getShopifyAccessToken() {
  if (!haveClientCreds()) {
    throw new Error("Missing Shopify credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.");
  }
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAtMs) return cachedAccessToken;
  return await fetchAccessTokenViaClientCredentials();
}

// ----------------- Shopify API callers -----------------
async function shopifyGraphql(query, variables) {
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify API error: ${msg}`);
  }
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data;
}

async function shopifyGetCustomerByIdNumeric(idNumeric) {
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/customers/${idNumeric}.json`, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
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

async function shopifyUpdateCustomer(idNumeric, updates) {
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/customers/${idNumeric}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
    },
    body: JSON.stringify({
      customer: {
        id: Number(idNumeric),
        ...updates,
      },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify update error: ${msg}`);
  }
  return json.customer || null;
}

async function shopifyCreateCustomer(input) {
  const token = await getShopifyAccessToken();

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/customers.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
    },
    body: JSON.stringify({
      customer: input,
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Shopify create error: ${msg}`);
  }

  return json.customer || null;
}

async function shopifyFindCustomerByExactEmail(email) {
  const trimmed = String(email || "").trim();
  if (!trimmed) return null;

  const data = await shopifyGraphql(
    `
      query FindCustomerByExactEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email
            }
          }
        }
      }
    `,
    { query: `email:"${escapeForShopifySearch(trimmed)}"` }
  );

  const node = data?.customers?.edges?.[0]?.node || null;
  if (!node?.email) return null;
  return String(node.email).trim().toLowerCase() === trimmed.toLowerCase() ? node : null;
}

async function shopifyCreateOrder(order, options) {
  if (LOG_SHOPIFY_ORDER_PAYLOAD) {
    console.log("shopify orderCreate payload", JSON.stringify({ order, options }));
  }

  const data = await shopifyGraphql(
    `
      mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          userErrors {
            field
            message
          }
          order {
            id
            name
            createdAt
          }
        }
      }
    `,
    { order, options }
  );

  return data?.orderCreate || null;
}

async function shopifyFindVariantByCode(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) return null;

  const data = await shopifyGraphql(
    `
      query FindVariantByCode($query: String!) {
        productVariants(first: 10, query: $query) {
          nodes {
            id
            sku
            barcode
            title
            product {
              id
              title
            }
          }
        }
      }
    `,
    { query: trimmed }
  );

  const nodes = data?.productVariants?.nodes || [];
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const exact = nodes.find((node) => {
    const sku = String(node?.sku || "").trim();
    const barcode = String(node?.barcode || "").trim();
    return sku === trimmed || barcode === trimmed;
  });

  return exact || null;
}

async function shopifyGetOrdersForCustomerHistory(customerIdNumeric, fromIso, toIso, limit = 100) {
  const data = await shopifyGraphql(
    `
      query CustomerHistoryOrders($first: Int!, $query: String!) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              name
              createdAt
              customer {
                id
              }
              displayFinancialStatus
              displayFulfillmentStatus
              currentSubtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customAttributes {
                key
                value
              }
              lineItems(first: 100) {
                nodes {
                  quantity
                  name
                  sku
                  customAttributes {
                    key
                    value
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  originalTotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  variant {
                    legacyResourceId
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      first: limit,
      query: `customer_id:${customerIdNumeric} AND created_at:>='${fromIso}' AND created_at:<='${toIso}'`,
    }
  );

  return data?.orders?.edges || [];
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

  const createdAt =
    shopifyCustomer?.createdAt ||
    shopifyCustomer?.created_at ||
    isoNow();

  const now = createdAt;
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

// ----------------- v8 customer handlers -----------------
async function handleV8Search(req, res, urlObj) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const qParam = urlObj.searchParams.get("q");
  if (!qParam) return sendMessage(res, 400, "Missing required query parameter: q");

  const limit = Math.max(1, Math.min(Number(urlObj.searchParams.get("limit") || 20), 100));
  const q = escapeForShopifySearch(qParam);

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
            createdAt
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

  return sendJson(res, 200, mapShopifyToV8SimpleCustomer(customer));
}

async function handleV8UpdateCustomer(req, res, entityIdRaw) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  if (!canUpdateCustomer()) {
    logCustomerWriteBlock("update", { storeId, entityId: String(entityIdRaw || "").trim() });
    return sendMessage(res, 409, "Customer updates are currently disabled by middleware configuration");
  }

  const entityId = sanitizeEntityId(entityIdRaw);
  if (!entityId) return sendMessage(res, 400, "Invalid entityId");

  const parsed = await readJsonBody(req);
  if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
  if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

  const updates = {};

  if (typeof parsed.firstName === "string" && parsed.firstName.trim() !== "") {
    updates.first_name = parsed.firstName.trim();
  }
  if (typeof parsed.lastName === "string" && parsed.lastName.trim() !== "") {
    updates.last_name = parsed.lastName.trim();
  }
  if (typeof parsed.email === "string" && parsed.email.trim() !== "") {
    updates.email = parsed.email.trim();
  }
  if (typeof parsed.phone === "string" && parsed.phone.trim() !== "") {
    updates.phone = parsed.phone.trim();
  }

  if (Array.isArray(parsed.communicationMechanisms)) {
    const emailComm = parsed.communicationMechanisms.find((c) => c?.type === "EMAIL" && c?.data);
    const phoneComm = parsed.communicationMechanisms.find((c) => c?.type === "PHONE" && c?.data);

    if (emailComm?.data && typeof emailComm.data === "string") updates.email = emailComm.data.trim();
    if (phoneComm?.data && typeof phoneComm.data === "string") updates.phone = phoneComm.data.trim();
  }

  if (Object.keys(updates).length === 0) {
    return sendMessage(res, 400, "No supported fields provided. Supported: firstName, lastName, email, phone");
  }

  await shopifyUpdateCustomer(entityId, updates);

  const updated = await shopifyGetCustomerByIdNumeric(entityId);
  if (!updated) return sendMessage(res, 404, "customer not found after update");

  return sendJson(res, 200, mapShopifyToV8SimpleCustomer(updated));
}

async function handleV8CreateCustomer(req, res) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  if (!canCreateCustomer()) {
    logCustomerWriteBlock("create", { storeId });
    return sendMessage(res, 409, "Customer creation is currently disabled by middleware configuration");
  }

  const parsed = await readJsonBody(req);
  if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
  if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

  const createInput = {};

  if (typeof parsed.firstName === "string" && parsed.firstName.trim() !== "") {
    createInput.first_name = parsed.firstName.trim();
  }
  if (typeof parsed.lastName === "string" && parsed.lastName.trim() !== "") {
    createInput.last_name = parsed.lastName.trim();
  }
  if (typeof parsed.email === "string" && parsed.email.trim() !== "") {
    createInput.email = parsed.email.trim();
  }
  if (typeof parsed.phone === "string" && parsed.phone.trim() !== "") {
    createInput.phone = parsed.phone.trim();
  }

  if (Array.isArray(parsed.communicationMechanisms)) {
    const emailComm = parsed.communicationMechanisms.find((c) => c?.type === "EMAIL" && c?.data);
    const phoneComm = parsed.communicationMechanisms.find((c) => c?.type === "PHONE" && c?.data);

    if (emailComm?.data && typeof emailComm.data === "string") createInput.email = emailComm.data.trim();
    if (phoneComm?.data && typeof phoneComm.data === "string") createInput.phone = phoneComm.data.trim();
  }

  if (!createInput.first_name && !createInput.last_name && !createInput.email && !createInput.phone) {
    return sendMessage(res, 400, "No supported fields provided. Supported: firstName, lastName, email, phone");
  }

  if (createInput.email) {
    const existingCustomer = await shopifyFindCustomerByExactEmail(createInput.email);
    if (existingCustomer) {
      return sendMessage(res, 409, `customer with email ${createInput.email} already exists`);
    }
  }

  const created = await shopifyCreateCustomer(createInput);
  if (!created) return sendMessage(res, 500, "Customer creation returned empty result");

  const createdId = created?.id;
  const canonical = createdId ? await shopifyGetCustomerByIdNumeric(createdId) : created;

  return sendJson(res, 201, mapShopifyToV8SimpleCustomer(canonical));
}

// ----------------- Shopify gift card helpers for voucher v3 -----------------
function isExpired(expiresOn) {
  if (!expiresOn) return false;
  const t = Date.parse(expiresOn);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

function parseMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapVoucherStatus(enabled, expiresOn, balanceAmount) {
  if (isExpired(expiresOn)) return "LOCKED";
  if (!enabled) return "LOCKED";
  if (balanceAmount <= 0) return "REDEEMED";
  return "ACTIVATED";
}

function mapGiftCardNodeToVoucher(card, domain, requestedVoucherId, defaultCurrency = "AUD") {
  const balanceAmount = parseMoney(card?.balance?.amount);
  const currency = card?.balance?.currencyCode || card?.initialValue?.currencyCode || defaultCurrency;
  const expiresOn = card?.expiresOn || null;
  const enabled = Boolean(card?.enabled ?? true);

  return {
    voucherId: requestedVoucherId,
    domain,
    type: "PAYMENT",
    status: mapVoucherStatus(enabled, expiresOn, balanceAmount),
    currency,
    balanceAmount,
    validToDate: toDateOnly(expiresOn),
  };
}

async function shopifyGetGiftCardByCode(voucherId) {
  const data = await shopifyGraphql(
    `
      query GiftCardByCode($q: String!) {
        giftCards(first: 1, query: $q) {
          nodes {
            id
            enabled
            expiresOn
            balance {
              amount
              currencyCode
            }
          }
        }
      }
    `,
    { q: voucherId }
  );

  const nodes = data?.giftCards?.nodes || [];
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  return nodes[0];
}

async function shopifyCreateGiftCard(amount, note, expiresOn) {
  const data = await shopifyGraphql(
    `
      mutation CreateGiftCard($input: GiftCardCreateInput!) {
        giftCardCreate(input: $input) {
          giftCard {
            id
            lastCharacters
            note
            expiresOn
            initialValue {
              amount
              currencyCode
            }
          }
          giftCardCode
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        initialValue: amount.toFixed(2),
        note: note || "Created by Customer Link middleware",
        ...(expiresOn ? { expiresOn } : {}),
      },
    }
  );

  return data?.giftCardCreate || null;
}

async function shopifyDebitGiftCard(giftCardId, amount, currencyCode, note) {
  const data = await shopifyGraphql(
    `
      mutation GiftCardDebit($id: ID!, $debitInput: GiftCardDebitInput!) {
        giftCardDebit(id: $id, debitInput: $debitInput) {
          giftCardDebitTransaction {
            id
            amount {
              amount
              currencyCode
            }
            processedAt
            giftCard {
              id
              balance {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      id: giftCardId,
      debitInput: {
        debitAmount: {
          amount: amount.toFixed(2),
          currencyCode,
        },
        note: note || "",
      },
    }
  );

  return data?.giftCardDebit || null;
}

// ----------------- voucher v3 handlers -----------------
const DEFAULT_VOUCHER_DOMAIN = "gift";
const DEFAULT_VOUCHER_CURRENCY = "AUD";
const VOUCHER_EXPIRY_YEARS = 3;

function buildFutureDateIsoYears(years) {
  if (!years || years <= 0) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

async function handleV3GetVoucher(req, res, domainRaw, voucherIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const voucherId = String(voucherIdRaw || "").trim();

  if (!voucherId) return sendMessage(res, 400, "voucherId is required");

  const card = await shopifyGetGiftCardByCode(voucherId);
  if (!card) return sendMessage(res, 404, `voucher ${voucherId} not found`);

  return sendJson(res, 200, mapGiftCardNodeToVoucher(card, domain, voucherId, DEFAULT_VOUCHER_CURRENCY));
}

async function handleV3GetVoucherAllDomains(req, res, voucherIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const voucherId = String(voucherIdRaw || "").trim();
  if (!voucherId) return sendMessage(res, 400, "voucherId is required");

  const card = await shopifyGetGiftCardByCode(voucherId);
  if (!card) return sendMessage(res, 404, `no vouchers with id ${voucherId} found`);

  const voucher = mapGiftCardNodeToVoucher(card, DEFAULT_VOUCHER_DOMAIN, voucherId, DEFAULT_VOUCHER_CURRENCY);
  return sendJson(res, 200, { vouchers: [voucher] });
}

async function handleV3CreateVoucher(req, res, domainRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();

  const parsed = await readJsonBody(req);
  if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
  if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

  const amount = Number(parsed.amount);
  const currency = (parsed.currency || DEFAULT_VOUCHER_CURRENCY).toUpperCase();

  if (!Number.isFinite(amount) || amount <= 0) {
    return sendMessage(res, 400, "amount must be a positive number");
  }

  const expiresOn = buildFutureDateIsoYears(VOUCHER_EXPIRY_YEARS);
  const payload = await shopifyCreateGiftCard(amount, "Created by Customer Link middleware", expiresOn);

  const userErrors = payload?.userErrors || [];
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    const first = userErrors[0];
    return sendMessage(res, 409, first?.message || "giftCardCreate error");
  }

  const voucherId = payload?.giftCardCode || "";
  if (!voucherId) {
    return sendMessage(res, 500, "Shopify did not return a gift card code");
  }

  return sendJson(
    res,
    201,
    {
      voucherId,
      message: "creation of voucher successful",
      transactionId: `gc-create-${Date.now()}`,
    },
    {
      Location: `/api/v3/vouchers/${encodeURIComponent(domain)}/${encodeURIComponent(voucherId)}`,
    }
  );
}

async function handleV3CreateVoucherWithId(req, res, domainRaw, voucherIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const voucherId = String(voucherIdRaw || "").trim();

  return sendJson(res, 501, {
    voucherId,
    message: `CreateVoucherWithId is not supported for domain ${domain}. Shopify generates gift card codes.`,
  });
}

async function handleV3RedeemVoucher(req, res, domainRaw, voucherIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const voucherId = String(voucherIdRaw || "").trim();

  const parsed = await readJsonBody(req);
  if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
  if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

  const amount = Number(parsed.amount);
  const currency = (parsed.currency || DEFAULT_VOUCHER_CURRENCY).toUpperCase();
  const note = String(parsed.note || "");

  if (!voucherId) return sendMessage(res, 400, "voucherId is required");
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendMessage(res, 400, "amount must be a positive number");
  }

  const card = await shopifyGetGiftCardByCode(voucherId);
  if (!card) return sendMessage(res, 404, `voucher ${voucherId} not found`);

  const giftCardId = card?.id;
  if (!giftCardId) return sendMessage(res, 500, `voucher ${voucherId} has no Shopify gift card id`);

  const payload = await shopifyDebitGiftCard(giftCardId, amount, currency, note);

  const userErrors = payload?.userErrors || [];
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    const first = userErrors[0];
    const codePart = first?.code ? `${first.code} ` : "";
    return sendMessage(res, 409, `${codePart}${first?.message || "voucher redeem failed"}`);
  }

  const txn = payload?.giftCardDebitTransaction;
  return sendJson(res, 200, {
    message: "voucher redeem successful",
    transactionId: txn?.id || `gc-redeem-${Date.now()}`,
  });
}

async function handleV3ChargeVoucher(req, res, domainRaw, voucherIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const voucherId = String(voucherIdRaw || "").trim();

  return sendJson(res, 501, {
    voucherId,
    message: `voucher charge is not implemented for domain ${domain}`,
  });
}

async function handleV3CancelVoucherTransaction(req, res, domainRaw, voucherIdRaw, transactionIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const voucherId = String(voucherIdRaw || "").trim();
  const transactionId = String(transactionIdRaw || "").trim();

  return sendJson(res, 501, {
    voucherId,
    message: `voucher transaction cancel is not implemented for domain ${domain}, transaction ${transactionId}`,
  });
}

async function handleV3GetCustomerVouchers(req, res, domainRaw, customerIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const domain = String(domainRaw || DEFAULT_VOUCHER_DOMAIN).trim();
  const customerId = String(customerIdRaw || "").trim();

  return sendJson(res, 501, {
    message: `customer-vouchers lookup is not implemented for domain ${domain}, customer ${customerId}`,
  });
}

async function handleV3GetCustomerVouchersAllDomains(req, res, customerIdRaw) {
  if (!requireVoucherHeaders(req, res)) return;

  const customerId = String(customerIdRaw || "").trim();

  return sendJson(res, 501, {
    message: `customer-vouchers lookup is not implemented for customer ${customerId}`,
  });
}

// ----------------- sales v3 helpers -----------------
const DEFAULT_ORDER_CURRENCY = "AUD";
const saleXmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,
});

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseRequiredPositiveInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (!Number.isInteger(n)) {
    throw new Error(`Unsupported non-integer quantity for MVP: ${value}`);
  }
  return n;
}

function moneyInput(amount, currencyCode) {
  return {
    shopMoney: {
      amount: Number(amount.toFixed(2)),
      currencyCode,
    },
  };
}

function extractCommunicationValue(mechanisms, type) {
  const entry = asArray(mechanisms).find((item) => String(item?.type || "").toUpperCase() === type && item?.data);
  return entry?.data ? String(entry.data).trim() : "";
}

function extractTextAttributeValue(textAttributes, key) {
  const attr = asArray(textAttributes?.TextAttribute).find((item) => String(item?.key || "").trim() === key);
  return attr?.value ? String(attr.value).trim() : "";
}

function extractCustomAttributeValue(customAttributes, key) {
  const attr = asArray(customAttributes).find((item) => String(item?.key || "").trim() === key);
  return attr?.value ? String(attr.value).trim() : "";
}

function buildSaleLineTitle(skuLine) {
  const itemShort = String(skuLine?.item?.Item?.descriptionShort || "").trim();
  const skuShort = String(skuLine?.sku?.Sku?.descriptionShort || "").trim();
  const supplierSkuNumber = String(skuLine?.sku?.Sku?.supplierSkuNumber || "").trim();

  const parts = [itemShort, skuShort].filter(Boolean);
  if (parts.length > 0) return parts.join(" - ");
  if (supplierSkuNumber) return supplierSkuNumber;
  return `POS SKU ${String(skuLine?.skuEntityId || "UNKNOWN").trim()}`;
}

function getSaleLineCodes(skuLine) {
  return [
    extractTextAttributeValue(skuLine?.textAttributes, "scan-code"),
    String(skuLine?.sku?.Sku?.supplierSkuNumber || "").trim(),
    String(skuLine?.sku?.Sku?.entityId || "").trim(),
    String(skuLine?.skuEntityId || "").trim(),
  ].filter(Boolean);
}

async function mapSaleLineToShopifyLineItem(skuLine, currency, variantCache) {
  const quantity = parseRequiredPositiveInt(skuLine?.quantity, 1);
  const unitPrice = parseNumber(skuLine?.price);
  const codes = getSaleLineCodes(skuLine);
  const originalSkuEntityId = String(skuLine?.skuEntityId || "").trim();
  let matchedVariant = null;

  for (const code of codes) {
    if (!variantCache.has(code)) {
      variantCache.set(code, await shopifyFindVariantByCode(code));
    }

    const candidate = variantCache.get(code);
    if (candidate?.id) {
      matchedVariant = candidate;
      break;
    }
  }

  const lineItem = {
    title: buildSaleLineTitle(skuLine),
    quantity,
    priceSet: moneyInput(unitPrice, currency),
    taxable: false,
    properties: [
      { name: "pos_sku_entity_id", value: originalSkuEntityId },
    ].filter((entry) => entry.value),
  };

  if (matchedVariant?.id) {
    lineItem.variantId = matchedVariant.id;
  }

  return lineItem;
}

async function buildShopifyOrderInputFromSale(parsedSale) {
  const currency =
    String(
      parsedSale?.paymentLines?.PaymentLine?.systemAmountUnit ||
        parsedSale?.saleLines?.SkuLine?.priceUnit ||
        DEFAULT_ORDER_CURRENCY
    ).trim() || DEFAULT_ORDER_CURRENCY;

  const saleLines = asArray(parsedSale?.saleLines?.SkuLine);
  if (saleLines.length === 0) {
    throw new Error("Sale contains no SkuLine entries");
  }

  const variantCache = new Map();
  const lineItems = [];
  for (const line of saleLines) {
    lineItems.push(await mapSaleLineToShopifyLineItem(line, currency, variantCache));
  }

  const paymentLines = asArray(parsedSale?.paymentLines?.PaymentLine);
  const paidAmount = paymentLines.reduce((sum, line) => sum + parseNumber(line?.systemAmount), 0);
  const fallbackTotal = saleLines.reduce((sum, line) => sum + parseNumber(line?.lineValueGross), 0);
  const transactionAmount = paidAmount > 0 ? paidAmount : fallbackTotal;

  const customerNode = parsedSale?.customer?.SimpleCustomer || {};
  const email = extractCommunicationValue(customerNode?.communicationMechanisms?.CommunicationMechanism, "EMAIL");
  const phone =
    extractCommunicationValue(customerNode?.communicationMechanisms?.CommunicationMechanism, "MOBILE") ||
    extractCommunicationValue(customerNode?.communicationMechanisms?.CommunicationMechanism, "PHONE");

  const customerEntityId = String(
    parsedSale?.customerEntityId ||
      parsedSale?.externalCustomerNumber ||
      customerNode?.entityId ||
      ""
  ).trim();

  const order = {
    currency,
    taxesIncluded: true,
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    lineItems,
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        amountSet: moneyInput(transactionAmount, currency),
      },
    ],
    note: `POS receipt ${String(parsedSale?.receiptNumber || "").trim()} from branch ${String(parsedSale?.branchEntityId || "").trim()}`,
    customAttributes: [
      { key: "pos_receipt_number", value: String(parsedSale?.receiptNumber || "").trim() },
      { key: "pos_receipt_state", value: String(parsedSale?.receiptState || "").trim() },
      { key: "pos_timestamp", value: String(parsedSale?.timestamp || "").trim() },
      { key: "pos_branch_entity_id", value: String(parsedSale?.branchEntityId || "").trim() },
      { key: "pos_till_entity_id", value: String(parsedSale?.tillEntityId || "").trim() },
      { key: "pos_customer_entity_id", value: customerEntityId },
    ].filter((entry) => entry.value),
  };

  if (email) order.email = email;
  if (phone) order.phone = phone;

  if (customerEntityId && /^\d+$/.test(customerEntityId)) {
    order.customerId = `gid://shopify/Customer/${customerEntityId}`;
  }

  return order;
}

async function handleV3Sale(req, res) {
  const rawXml = await readTextBody(req);
  if (!rawXml || !rawXml.trim()) return sendMessage(res, 400, "Missing XML body");

  let parsed;
  try {
    parsed = saleXmlParser.parse(rawXml);
  } catch {
    return sendMessage(res, 400, "Invalid XML body");
  }

  const sale = parsed?.Sale;
  if (!sale || typeof sale !== "object") {
    return sendMessage(res, 400, "Invalid Sale payload");
  }

  const receiptState = String(sale?.receiptState || "").trim().toUpperCase();
  if (receiptState !== "FINISHED") {
    return sendEmpty(res, 200);
  }

  const externalCustomerNumber = String(sale?.externalCustomerNumber || "").trim();
  if (!externalCustomerNumber) {
    return sendEmpty(res, 200);
  }

  const orderInput = await buildShopifyOrderInputFromSale(sale);
  const payload = await shopifyCreateOrder(orderInput, { inventoryBehaviour: "BYPASS" });
  const userErrors = payload?.userErrors || [];

  if (Array.isArray(userErrors) && userErrors.length > 0) {
    const first = userErrors[0];
    return sendMessage(res, 409, first?.message || "orderCreate error");
  }

  if (!payload?.order?.id) {
    return sendMessage(res, 500, "Shopify did not return an order id");
  }

  return sendEmpty(res, 200);
}

// ----------------- customer history v2 helpers -----------------
function toStartOfDayIso(dateOnly) {
  return `${dateOnly}T00:00:00Z`;
}

function toEndOfDayIso(dateOnly) {
  return `${dateOnly}T23:59:59Z`;
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function formatHistoryTimestamp(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildHistoryReceiptCode(order) {
  const branch = extractCustomAttributeValue(order?.customAttributes, "pos_branch_entity_id");
  const till = extractCustomAttributeValue(order?.customAttributes, "pos_till_entity_id");
  const receipt = extractCustomAttributeValue(order?.customAttributes, "pos_receipt_number");
  if (branch && till && receipt) return `${branch}-${till}-${receipt}`;
  return String(order?.name || "").trim();
}

function mapOrderLineItemToCustomerHistoryEntry(order, lineItem, customerId, storeId) {
  const branchEntityId = extractCustomAttributeValue(order?.customAttributes, "pos_branch_entity_id") || `1-${storeId}`;
  const transactionTimestamp = formatHistoryTimestamp(order?.createdAt);
  const priceAmount = parseNumber(lineItem?.originalUnitPriceSet?.shopMoney?.amount);
  const lineValueGross = parseNumber(lineItem?.originalTotalSet?.shopMoney?.amount);
  const currency = String(
    lineItem?.originalUnitPriceSet?.shopMoney?.currencyCode ||
      lineItem?.originalTotalSet?.shopMoney?.currencyCode ||
      DEFAULT_ORDER_CURRENCY
  ).trim() || DEFAULT_ORDER_CURRENCY;

  const posSkuEntityId = extractCustomAttributeValue(lineItem?.customAttributes, "pos_sku_entity_id");
  const skuEntityId = String(
    posSkuEntityId ||
      lineItem?.sku ||
      lineItem?.variant?.legacyResourceId ||
      ""
  ).trim();

  return {
    branchEntityId,
    skuEntityId,
    text: String(posSkuEntityId || lineItem?.sku || lineItem?.name || "").trim(),
    customerEntityId: String(customerId),
    transactionTimestamp,
    historyDocumentType: "POS",
    receiptCode: buildHistoryReceiptCode(order),
    lineType: "ARTICLE",
    quantity: parseRequiredPositiveInt(lineItem?.quantity, 1),
    quantityUnit: currency,
    originalPrice: null,
    originalPriceUnit: currency,
    price: priceAmount,
    priceUnit: currency,
    lineValueNet: null,
    lineValueNetUnit: currency,
    lineValueGross,
    lineValueGrossUnit: currency,
  };
}

async function handleV2CustomerHistory(req, res, customerIdRaw, urlObj) {
  const storeId = requireStoreId(req);
  if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

  const customerId = String(customerIdRaw || "").trim();
  if (!/^\d+$/.test(customerId)) return sendMessage(res, 400, "Invalid customerId");

  const from = String(urlObj.searchParams.get("from") || "").trim();
  const to = String(urlObj.searchParams.get("to") || "").trim();

  if (!isDateOnly(from)) return sendMessage(res, 400, "Invalid or missing query parameter: from");
  if (!isDateOnly(to)) return sendMessage(res, 400, "Invalid or missing query parameter: to");

  const orderEdges = await shopifyGetOrdersForCustomerHistory(customerId, toStartOfDayIso(from), toEndOfDayIso(to));
  const entries = orderEdges.flatMap((edge) => {
    const order = edge?.node;
    const lineItems = asArray(order?.lineItems?.nodes);
    return lineItems.map((lineItem) => mapOrderLineItemToCustomerHistoryEntry(order, lineItem, customerId, storeId));
  });

  return sendJson(res, 200, { entries });
}

// Optional debug endpoint
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
      return sendJson(res, 200, { status: "ok", customerApi: "v8", voucherApi: "v3", shopifyApi: API_VERSION });
    }

    if (req.method === "GET" && urlObj.pathname === "/customers") {
      return await handleLegacyCustomersDemo(res);
    }

    // ----------------- customer v8 -----------------
    if (req.method === "GET" && urlObj.pathname === "/api/v8/customers/search") {
      return await handleV8Search(req, res, urlObj);
    }

    if (req.method === "POST" && urlObj.pathname === "/api/v8/customers") {
      return await handleV8CreateCustomer(req, res);
    }

    const customerHistoryMatch = urlObj.pathname.match(/^(?:\/[^/]+)?\/api\/v2\/customer-history\/([^/]+)$/);
    if (customerHistoryMatch && req.method === "GET") {
      return await handleV2CustomerHistory(req, res, decodeURIComponent(customerHistoryMatch[1]), urlObj);
    }

    const customerMatch = urlObj.pathname.match(/^\/api\/v8\/customers\/([^/]+)$/);
    if (customerMatch) {
      if (req.method === "GET") {
        return await handleV8GetCustomer(req, res, customerMatch[1]);
      }
      if (req.method === "PUT") {
        return await handleV8UpdateCustomer(req, res, customerMatch[1]);
      }
    }

    // ----------------- voucher v3 -----------------

    const saleMatch = urlObj.pathname.match(/^(?:\/[^/]+)?\/api\/v3\/sales$/);
    if (saleMatch && req.method === "POST") {
      return await handleV3Sale(req, res);
    }

    // GET /api/v3/vouchers/{domain}/{voucherId}
    const voucherByDomainMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)\/([^/]+)$/);
    if (voucherByDomainMatch && req.method === "GET") {
      return await handleV3GetVoucher(
        req,
        res,
        decodeURIComponent(voucherByDomainMatch[1]),
        decodeURIComponent(voucherByDomainMatch[2])
      );
    }

    // POST /api/v3/vouchers/{domain}/{voucherId}    (CreateVoucherWithId - not supported)
    if (voucherByDomainMatch && req.method === "POST") {
      return await handleV3CreateVoucherWithId(
        req,
        res,
        decodeURIComponent(voucherByDomainMatch[1]),
        decodeURIComponent(voucherByDomainMatch[2])
      );
    }

    // GET /api/v3/vouchers/{voucherId}   (all domains)
    const voucherAllDomainsMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)$/);
    if (voucherAllDomainsMatch && req.method === "GET") {
      return await handleV3GetVoucherAllDomains(
        req,
        res,
        decodeURIComponent(voucherAllDomainsMatch[1])
      );
    }

    // POST /api/v3/vouchers/{domain}
    const voucherCreateMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)$/);
    if (voucherCreateMatch && req.method === "POST") {
      return await handleV3CreateVoucher(
        req,
        res,
        decodeURIComponent(voucherCreateMatch[1])
      );
    }

    // POST /api/v3/vouchers/{domain}/{voucherId}/redeem
    const voucherRedeemMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)\/([^/]+)\/redeem$/);
    if (voucherRedeemMatch && req.method === "POST") {
      return await handleV3RedeemVoucher(
        req,
        res,
        decodeURIComponent(voucherRedeemMatch[1]),
        decodeURIComponent(voucherRedeemMatch[2])
      );
    }

    // POST /api/v3/vouchers/{domain}/{voucherId}/charge
    const voucherChargeMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)\/([^/]+)\/charge$/);
    if (voucherChargeMatch && req.method === "POST") {
      return await handleV3ChargeVoucher(
        req,
        res,
        decodeURIComponent(voucherChargeMatch[1]),
        decodeURIComponent(voucherChargeMatch[2])
      );
    }

    // DELETE /api/v3/vouchers/{domain}/{voucherId}/{transactionId}
    const voucherCancelMatch = urlObj.pathname.match(/^\/api\/v3\/vouchers\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (voucherCancelMatch && req.method === "DELETE") {
      return await handleV3CancelVoucherTransaction(
        req,
        res,
        decodeURIComponent(voucherCancelMatch[1]),
        decodeURIComponent(voucherCancelMatch[2]),
        decodeURIComponent(voucherCancelMatch[3])
      );
    }

    // GET /api/v3/customer-vouchers/{domain}/{customerId}
    const customerVouchersByDomainMatch = urlObj.pathname.match(/^\/api\/v3\/customer-vouchers\/([^/]+)\/([^/]+)$/);
    if (customerVouchersByDomainMatch && req.method === "GET") {
      return await handleV3GetCustomerVouchers(
        req,
        res,
        decodeURIComponent(customerVouchersByDomainMatch[1]),
        decodeURIComponent(customerVouchersByDomainMatch[2])
      );
    }

    // GET /api/v3/customer-vouchers/{customerId}
    const customerVouchersAllDomainsMatch = urlObj.pathname.match(/^\/api\/v3\/customer-vouchers\/([^/]+)$/);
    if (customerVouchersAllDomainsMatch && req.method === "GET") {
      return await handleV3GetCustomerVouchersAllDomains(
        req,
        res,
        decodeURIComponent(customerVouchersAllDomainsMatch[1])
      );
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
