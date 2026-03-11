/**
 * Shopify Gift Card module
 *
 * Provides:
 *   GET  /api/giftcards/:code
 *   POST /api/giftcards
 *   POST /api/giftcards/redeem
 *
 * Reuses the shared Shopify GraphQL caller from server.js
 */

function isoNow() {
  return new Date().toISOString();
}

function parseMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isExpired(expiresOn) {
  if (!expiresOn) return false;
  const t = Date.parse(expiresOn);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

function mapGiftCardStatus(enabled, expiresOn, balanceAmount) {
  if (isExpired(expiresOn)) return "LOCKED";
  if (!enabled) return "LOCKED";
  if (balanceAmount <= 0) return "REDEEMED";
  return "ACTIVATED";
}

function mapGiftCardNodeToVoucherResult(card, requestedCode) {
  const balanceAmount = parseMoney(card?.balance?.amount);
  const expiresOn = card?.expiresOn || "";
  const enabled = Boolean(card?.enabled);

  return {
    voucherNo: requestedCode,
    voucherId: card?.id || "",
    type: "PAYMENT",
    balanceAmount,
    validToDate: expiresOn || undefined,
    status: mapGiftCardStatus(enabled, expiresOn, balanceAmount),
  };
}

function buildGiftCardQueryByCode(code) {
  return {
    query: `
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
    variables: {
      q: code,
    },
  };
}

function buildGiftCardCreateMutation(amount, note, expiresOn) {
  return {
    query: `
      mutation CreateGiftCard($input: GiftCardCreateInput!) {
        giftCardCreate(input: $input) {
          giftCard {
            id
            lastCharacters
            note
            expiresOn
            initialValue {
              amount
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
    variables: {
      input: {
        initialValue: amount.toFixed(2),
        note: note || "Created by Customer Link middleware",
        ...(expiresOn ? { expiresOn } : {}),
      },
    },
  };
}

function buildGiftCardDebitMutation(giftCardId, amount, currencyCode, note) {
  return {
    query: `
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
    variables: {
      id: giftCardId,
      debitInput: {
        debitAmount: {
          amount: amount.toFixed(2),
          currencyCode,
        },
        note: note || "",
      },
    },
  };
}

function buildFutureDateIsoYears(years) {
  if (!years || years <= 0) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function createGiftcardHandlers({ shopifyGraphql, sendJson, sendMessage, readJsonBody, requireStoreId, config }) {
  const expiryYears = Number(config?.giftcardExpiryYears || 0);
  const defaultCurrency = config?.defaultGiftcardCurrency || "AUD";

  async function handleGetGiftcard(req, res, codeRaw) {
    const storeId = requireStoreId(req);
    if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

    const code = String(codeRaw || "").trim();
    if (!code) return sendMessage(res, 400, "Missing gift card code");

    const gql = buildGiftCardQueryByCode(code);
    const data = await shopifyGraphql(gql.query, gql.variables);

    const nodes = data?.giftCards?.nodes || [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return sendMessage(res, 404, `Gift card ${code} not found`);
    }

    const voucher = mapGiftCardNodeToVoucherResult(nodes[0], code);
    return sendJson(res, 200, voucher);
  }

  async function handleCreateGiftcard(req, res) {
    const storeId = requireStoreId(req);
    if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

    const parsed = await readJsonBody(req);
    if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
    if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

    const amount = Number(parsed.amount);
    const currency = (parsed.currency || defaultCurrency || "AUD").toUpperCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return sendMessage(res, 400, "amount must be a positive number");
    }

    // Shopify giftCardCreate only needs amount; currency is normally shop currency.
    // We keep currency in request contract for POS friendliness, but Shopify may ignore it.
    const expiresOn = buildFutureDateIsoYears(expiryYears);

    const gql = buildGiftCardCreateMutation(amount, parsed.note, expiresOn);
    const data = await shopifyGraphql(gql.query, gql.variables);

    const payload = data?.giftCardCreate;
    const userErrors = payload?.userErrors || [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const first = userErrors[0];
      return sendMessage(res, 409, `giftCardCreate error: ${first?.message || "unknown error"}`);
    }

    return sendJson(res, 201, {
      message: "creation of voucher successful",
      voucherNo: payload?.giftCardCode || "",
      transactionId: `gc-create-${Date.now()}`,
      currency,
    });
  }

  async function handleRedeemGiftcard(req, res) {
    const storeId = requireStoreId(req);
    if (!storeId) return sendMessage(res, 400, "Missing required header: storeId");

    const parsed = await readJsonBody(req);
    if (parsed === "__INVALID_JSON__") return sendMessage(res, 400, "Invalid JSON body");
    if (!parsed || typeof parsed !== "object") return sendMessage(res, 400, "Missing JSON body");

    const code = String(parsed.voucherNo || parsed.code || "").trim();
    const amount = Number(parsed.amount);
    const currency = (parsed.currency || defaultCurrency || "AUD").toUpperCase();
    const note = String(parsed.note || "");

    if (!code) return sendMessage(res, 400, "voucherNo/code is required");
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendMessage(res, 400, "amount must be a positive number");
    }

    // Step 1: find gift card by code
    const search = buildGiftCardQueryByCode(code);
    const searchData = await shopifyGraphql(search.query, search.variables);

    const nodes = searchData?.giftCards?.nodes || [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return sendMessage(res, 404, `Gift card ${code} not found`);
    }

    const card = nodes[0];
    const giftCardId = card?.id;
    if (!giftCardId) return sendMessage(res, 500, "Gift card id missing from Shopify response");

    // Step 2: debit
    const mutation = buildGiftCardDebitMutation(giftCardId, amount, currency, note);
    const debitData = await shopifyGraphql(mutation.query, mutation.variables);

    const payload = debitData?.giftCardDebit;
    const userErrors = payload?.userErrors || [];
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const first = userErrors[0];
      const codePart = first?.code ? `${first.code} ` : "";
      return sendMessage(res, 409, `${codePart}${first?.message || "giftCardDebit error"}`);
    }

    const txn = payload?.giftCardDebitTransaction;
    return sendJson(res, 200, {
      message: "voucher redeem successful",
      transactionId: txn?.id || `gc-redeem-${Date.now()}`,
      processedAt: txn?.processedAt || isoNow(),
      debitedAmount: txn?.amount?.amount || amount.toFixed(2),
      currency: txn?.amount?.currencyCode || currency,
      remainingBalance: txn?.giftCard?.balance?.amount || null,
    });
  }

  return {
    handleGetGiftcard,
    handleCreateGiftcard,
    handleRedeemGiftcard,
  };
}

module.exports = {
  createGiftcardHandlers,
};