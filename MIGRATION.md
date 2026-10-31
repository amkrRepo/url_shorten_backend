# Migration Guide

Steps to move from one version of the API to the next, written down here.

## v1 to v2

### Why

- v1 had no authentication, anyone could create a short url
- v2 needs an api-key, so every url belongs to a user and the user can list, update and delete their own urls

### Timeline

- 2026-10-25: v2 released, v1 is deprecated
- 2027-01-31: v1 will be removed

Till then v1 keeps working, old routes like `/urls/...` are still redirected to `/api/v1/urls/...`

### What changed

- `POST /urls/shorten` now needs the `x-api-key`in the header (this is the only breaking change)
- `GET /urls/details`, `GET /urls/redirect` and `GET /urls/list` works similiar in both versions

### What is new in v2

- `PATCH /api/v2/urls/update` to change a short_code or its password
- `DELETE /api/v2/urls/delete` to delete a short_code
- `POST /api/v2/urls/shorten/batch` to shorten multiple urls at once (enterprise tier only)

### How to upgrade

1. Create a user with `POST /user/create` (email, name and api_key) to get your api-key
2. Change the path from `/api/v1/urls/shorten` to `/api/v2/urls/shorten`
3. Add the header `x-api-key: <your-api-key>` in the request
4. Test it, the request body stays the same

Before (v1)

```
POST /api/v1/urls/shorten
Content-Type: application/json

{ "original_url": "https://example.com" }
```

After (v2)

```
POST /api/v2/urls/shorten
Content-Type: application/json
x-api-key: <your-api-key>

{ "original_url": "https://example.com" }
```

### Errors you might get

- 401 "API Key is required": the `x-api-key` header is missing
- 401 "Invalid api key": the api-key is wrong
- 403 "Upgrade to enterprise": batch endpoint needs the enterprise tier
