/**
 * RPOS Customer Service Web API v8 + Voucher Service Web API v3 middleware
 *
 * Supports:
 *  - GET  /api/v8/customers/search?q=...
 *  - GET  /api/v8/customers/{entityId}
 *  - PUT  /api/v8/customers/{entityId}   (MVP: firstName/lastName/email/phone only)
 *  - POST /api/v8/customers              (MVP: firstName/lastName/email/phone only)
 *
 *  - GET  /api/v3/vouchers/{domain}/{voucherId}
 *  - GET  /api/v3/vouchers/{voucherId}
 *  - POST /api/v3/vouchers/{domain}
 *  - POST /api/v3/vouchers/{domain}/{voucherId}/redeem
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
 *
 * Notes:
 *  - Customer API requires header: storeId
 *  - Voucher API contract also mentions workstationId, clientId, merchantId.
 *    This middleware currently validates storeId and accepts the others if present.
 */

const http = require("http");
const { URL } = require("url");

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

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

function requireVoucherHeaders(req, res) {
  const storeId = requireStoreId(req);
  if (!storeId) {
    sendMessage(res, 400, "Missing required header: storeId");
    return false;
  }
  return true;
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