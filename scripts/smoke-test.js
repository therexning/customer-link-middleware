/**
 * Smoke test for Customer Link middleware
 *
 * Usage (Windows PowerShell):
 *   $env:BASE_URL="https://customer-link-xxxx.australia-southeast1.run.app"
 *   $env:STORE_ID="101"
 *   $env:TEST_Q="+61499999999"
 *   node scripts/smoke-test.js
 *
 * Usage (cmd.exe):
 *   set BASE_URL=https://customer-link-xxxx.australia-southeast1.run.app
 *   set STORE_ID=101
 *   set TEST_Q=+61499999999
 *   node scripts/smoke-test.js
 *
 * What it does:
 *  1) GET /api/v8/customers/search?q=...
 *  2) Pick first customer entityId
 *  3) GET /api/v8/customers/{entityId}
 *  4) PUT /api/v8/customers/{entityId} (MVP fields)
 *  5) GET again and verify fields changed
 */

const BASE_URL = process.env.BASE_URL;
const STORE_ID = process.env.STORE_ID || "101";
const TEST_Q = process.env.TEST_Q || "Rex";

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

function headers() {
  return {
    "storeId": STORE_ID,
    "Accept": "application/json",
  };
}

async function httpJson(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      ...headers(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    const msg = json?.message || JSON.stringify(json);
    throw new Error(`${method} ${path} failed: HTTP ${resp.status} ${msg}`);
  }
  return json;
}

function pickFirstCustomerEntityId(searchResp) {
  const arr = searchResp?.customers;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.entityId || null;
}

function getEmailAndPhone(cust) {
  const comm = Array.isArray(cust?.communicationMechanisms) ? cust.communicationMechanisms : [];
  const email = comm.find((c) => c?.type === "EMAIL")?.data || "";
  const phone = comm.find((c) => c?.type === "PHONE")?.data || "";
  return { email, phone };
}

(async () => {
  requireEnv("BASE_URL", BASE_URL);

  console.log("== Customer Link smoke test ==");
  console.log("BASE_URL:", BASE_URL);
  console.log("STORE_ID:", STORE_ID);
  console.log("TEST_Q:", TEST_Q);

  // 0) Health
  const health = await httpJson("GET", "/", null);
  console.log("Health:", health);

  // 1) Search
  const search = await httpJson("GET", `/api/v8/customers/search?q=${encodeURIComponent(TEST_Q)}`, null);
  const entityId = pickFirstCustomerEntityId(search);
  if (!entityId) {
    console.error("Search returned no customers. Try a different TEST_Q (email/phone/name).");
    process.exit(2);
  }
  console.log("Found entityId:", entityId);

  // 2) Get before
  const before = await httpJson("GET", `/api/v8/customers/${encodeURIComponent(entityId)}`, null);
  const beforeComm = getEmailAndPhone(before);
  console.log("Before:", {
    firstName: before.firstName,
    lastName: before.lastName,
    email: beforeComm.email,
    phone: beforeComm.phone,
  });

  // 3) Put update (MVP fields)
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const newFirstName = `Rex_${stamp}`;
  const newLastName = `Updated_${stamp}`;

  const putBody = {
    firstName: newFirstName,
    lastName: newLastName,
    // keep email/phone unchanged unless you want to test them too
  };

  const putResp = await httpJson("PUT", `/api/v8/customers/${encodeURIComponent(entityId)}`, putBody);
  console.log("PUT response:", { firstName: putResp.firstName, lastName: putResp.lastName });

  // 4) Get after
  const after = await httpJson("GET", `/api/v8/customers/${encodeURIComponent(entityId)}`, null);
  console.log("After:", { firstName: after.firstName, lastName: after.lastName });

  // 5) Verify
  if (after.firstName !== newFirstName || after.lastName !== newLastName) {
    throw new Error("Verification failed: names did not update as expected.");
  }

  console.log("✅ Smoke test passed.");
})().catch((err) => {
  console.error("❌ Smoke test failed.");
  console.error(err.message || err);
  process.exit(1);
});