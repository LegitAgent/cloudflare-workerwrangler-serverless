# timezone-proxy

small Cloudflare Worker I made to sit in front of TimeZoneDB.

I mainly use this so my client app or extension can ask for timezone data without exposing the API key directly in the frontend. It also gives me a place to lock requests down a bit with CORS, basic rate limiting, and timeout handling.

## What it does

- proxies timezone lookups from TimeZoneDB
- only allows requests from the origin I set
- rate limits requests per IP and path
- returns JSON responses from a simple worker endpoint

## Routes

`GET /timezone?latitude=...&longitude=...`

Looks up the timezone for a pair of coordinates.

`GET /listtimezones`

Returns the timezone list from TimeZoneDB with a smaller set of fields.

## Local Setup

1. Install dependencies with `npm install`
2. Add your API key with `wrangler secret put TIMEZONEDB_KEY`
3. Set `ALLOWED_ORIGIN` in `wrangler.jsonc`
4. Run it with `npm run dev`

## Testing
- For testing, simply run the command `npm test`.

## Notes

- This is GET-only right now
- If the upstream API takes too long, the worker times out the request
- If you hit the rate limit, it returns `429`
