![CI](../../actions/workflows/ci.yml/badge.svg)
# Customer Link Middleware

RPOS v8 -> Cloud Run -> Shopify (Dev Dashboard App, Client Credentials)

---

## Overview

This project implements a middleware service that connects:

```text
POS -> RISB -> Cloud Run (this service) -> Shopify Admin API
```

It allows RPOS (Customer Service Web API v8) to read customer data from Shopify using:

- `GET /api/v8/customers/search`
- `GET /api/v8/customers/{entityId}`
- `GET /api/v2/customer-history/{customerId}`
- `POST /api/v3/sales`

Authentication with Shopify is handled via:

- **Dev Dashboard App**
- **Client ID + Client Secret**
- **OAuth2 Client Credentials Grant** (dynamic access token retrieval)

---

# Architecture

## Runtime Flow

1. POS calls RISB
2. RISB calls this Cloud Run service
3. Middleware retrieves Shopify access token (client credentials grant)
4. Middleware calls Shopify Admin API
5. Shopify returns customer data
6. Middleware maps to RPOS v8 schema
7. Response returned to POS

For sales and history:

1. POS posts finished receipts to `/api/v3/sales`
2. Middleware creates Shopify orders using the existing app auth
3. POS reads customer history from `/api/v2/customer-history/{customerId}`
4. Middleware flattens Shopify order lines back into the POS history schema

---

# Prerequisites

- Google Cloud CLI (`gcloud`) installed
- A Google Cloud Project
- A Shopify Dev Dashboard App installed on your target store
- Node.js project with `server.js`

---

# Step 1 - Enable Required Google Cloud Services (One-Time Setup)

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudresourcemanager.googleapis.com
```

---

# Step 2 - Fix IAM Permissions (Avoid Common Deployment Errors)

Cloud Run source deployments use:

- Cloud Build service account
- Compute default service account

Get your project number:

```bash
gcloud projects describe <PROJECT_ID> --format="value(projectNumber)"
```

Grant Artifact Registry permissions:

```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

---

# Step 3 - Shopify Dev Dashboard Setup

1. Go to Shopify Dev Dashboard
2. Create a new app
3. Configure Admin API scopes (minimum required):
- `read_orders`
- `read_customers`
- `write_customers`
- `write_orders`
4. Install the app to your target store
5. Copy:
- Client ID
- Client Secret
6. Confirm your store domain (example):

```text
roqqiodev.myshopify.com
```

---

# Step 4 - Store Shopify Credentials in Secret Manager

## Windows (No Trailing Newline)

```bash
echo|set /p=<CLIENT_ID> > client_id.txt
gcloud secrets create shopify_client_id --data-file=client_id.txt
del client_id.txt

echo|set /p=<CLIENT_SECRET> > client_secret.txt
gcloud secrets create shopify_client_secret --data-file=client_secret.txt
del client_secret.txt
```

---

# Step 5 - Allow Cloud Run to Access Secrets

```bash
gcloud secrets add-iam-policy-binding shopify_client_id \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding shopify_client_secret \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

# Step 6 - Deploy to Cloud Run

From your project directory:

```bash
gcloud run deploy customer-link \
  --region australia-southeast1 \
  --platform managed \
  --source . \
  --allow-unauthenticated \
  --set-env-vars SHOPIFY_SHOP=<YOUR_SHOP>.myshopify.com,SHOPIFY_API_VERSION=2026-01,CUSTOMER_WRITE_MODE=enabled \
  --set-secrets SHOPIFY_CLIENT_ID=shopify_client_id:latest,SHOPIFY_CLIENT_SECRET=shopify_client_secret:latest
```

Deployment will output a public HTTPS URL:

```text
https://customer-link-xxxx.australia-southeast1.run.app
```

---

# RISB / POS Configuration

The final endpoint should resolve to:

```text
https://<cloud-run-url>/api/v8/...
```

If RISB logs show:

```text
/api/api/v8/...
```

It means `baseUri` and `version` are duplicating `api`.

Correct example:

```xml
<endpoint>
    <baseUri>https://customer-link-xxxx.australia-southeast1.run.app</baseUri>
    <version>v8</version>
</endpoint>
```

---

# Supported Endpoints

## Search Customers

```text
GET /api/v8/customers/search?q=...
Header: storeId: 101
```

Returns:

```json
{
  "customers": [SimpleCustomer]
}
```

---

## Get Customer by ID

```text
GET /api/v8/customers/{entityId}
Header: storeId: 101
```

---

## Customer Write Configuration

Use `CUSTOMER_WRITE_MODE` to control customer create/update behaviour without code changes.

Supported values:

- `enabled`: customer create and update allowed
- `block_update`: customer update blocked, create allowed
- `block_create`: customer create blocked, update allowed
- `block_all`: both customer create and update blocked

When blocked:

- middleware returns HTTP `403`
- middleware logs `customer write blocked` with the active mode

Customer create duplicate check:

- when `POST /api/v8/customers` includes an email address, middleware performs an exact Shopify email lookup first
- if that email already exists in Shopify, middleware returns HTTP `409`

Example:

```bash
gcloud run services update customer-link \
  --region australia-southeast1 \
  --update-env-vars CUSTOMER_WRITE_MODE=block_update
```

---

## Get Customer History

```text
GET /api/v2/customer-history/{customerId}?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /{store}/api/v2/customer-history/{customerId}?from=YYYY-MM-DD&to=YYYY-MM-DD
Header: storeId: 101
```

MVP behaviour:

- reads Shopify orders for the numeric customer id in the requested date range
- flattens order line items into `entries[]`
- includes all matching Shopify orders, not only POS-originated orders
- uses POS receipt metadata from order custom attributes when available
- falls back to the order name as `receiptCode` and `1-{storeId}` as `branchEntityId`
- prefers the original POS `skuEntityId` when stored on the order line
- otherwise uses Shopify line item `sku` before falling back to Shopify variant ids

Notes:

- query currently reads up to 100 matching orders, with up to 100 line items per order
- older Shopify orders may require `read_all_orders` depending on the app install and store rules

---

## Post Finished Sale

```text
POST /api/v3/sales
POST /{store}/api/v3/sales
Content-Type: application/xml
```

MVP behaviour:

- accepts the 4POS v3 `Sale` XML payload
- ignores receipts that are not `FINISHED`
- only forwards receipts that include `externalCustomerNumber`
- maps `SkuLine` entries into Shopify order line items and attempts Shopify variant matching
- creates the Shopify order as paid and fulfilled
- treats POS sale prices as tax-inclusive
- maps the sale payment total into a single successful Shopify transaction
- stores the original POS `skuEntityId` on each Shopify order line for history round-tripping
- returns HTTP `200` with an empty body on success

Current assumptions:

- sale quantities must be whole numbers
- customer linkage uses the incoming numeric `externalCustomerNumber`
- variant matching tries `scan-code`, `supplierSkuNumber`, `Sku.entityId`, then `skuEntityId`
- inventory behaviour is `BYPASS`

Debugging:

- set `LOG_SHOPIFY_ORDER_PAYLOAD=true` to log the exact `orderCreate` body sent to Shopify

---

# Verification Checklist

1. `GET /` returns status ok
2. `GET /api/v8/customers/search?q=Rex` returns customer list
3. `GET /api/v8/customers/{entityId}` returns single customer
4. POS search via RISB works
5. POS finished sale posts to `/api/v3/sales` and creates a Shopify order
6. `GET /api/v2/customer-history/{customerId}` returns flattened order history entries

---

# Updating Credentials (New Store / New App)

Update secrets:

```bash
echo|set /p=<NEW_CLIENT_ID> > client_id.txt
gcloud secrets versions add shopify_client_id --data-file=client_id.txt
del client_id.txt

echo|set /p=<NEW_CLIENT_SECRET> > client_secret.txt
gcloud secrets versions add shopify_client_secret --data-file=client_secret.txt
del client_secret.txt
```

Then trigger new revision:

```bash
gcloud run services update customer-link \
  --region australia-southeast1 \
  --update-env-vars SHOPIFY_SHOP=<NEW_SHOP>.myshopify.com
```

---

# Security Notes

Current deployment uses:

```text
--allow-unauthenticated
```

For production environments consider:

- Removing public access
- Restricting via IAM
- Adding API key validation
- Limiting by network

---

# Verification (Smoke Test)

Run:

cmd.exe:

```bash
set BASE_URL=https://<your-cloud-run-url>
set STORE_ID=101
set TEST_Q=+61499999999
node scripts\smoke-test.js
```

---

# Environments

- demo
- production (design only)

---

# Summary

This middleware provides a reusable integration pattern:

- RPOS v8 compatible
- Shopify Dev Dashboard app compatible
- Cloud Run scalable deployment
- Dynamic token retrieval (no hardcoded `shpat_` tokens)

This document can be reused for future projects with minimal modification.
