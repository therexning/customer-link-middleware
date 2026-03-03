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
- `read_customers`
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
  --set-env-vars SHOPIFY_SHOP=<YOUR_SHOP>.myshopify.com,SHOPIFY_API_VERSION=2026-01 \
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

# Verification Checklist

1. `GET /` returns status ok
2. `GET /api/v8/customers/search?q=Rex` returns customer list
3. `GET /api/v8/customers/{entityId}` returns single customer
4. POS search via RISB works

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
