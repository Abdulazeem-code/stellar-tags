# Stellar Tags k6 Load Tests

Repeatable, automated performance and load testing scripts using [k6](https://k6.io/) focused exclusively on the public, read-heavy endpoints of Stellar Tags:
- `GET /federation?q=<tag>&type=name`
- `GET /lookup?address=<address>`
- `GET /.well-known/stellar.toml`
- `GET /health`

---

## Safety Constraint

**The scripts refuse to run against any non-local or remote `BASE_URL` by default.**
To protect public servers and third-party infrastructure from unintentional load, running against non-localhost targets requires explicitly setting `ALLOW_REMOTE=1`.

---

## Directory Structure

- `loadtests/common.js`: Shared configuration, safety guards, stage calculators, and SLA thresholds.
- `loadtests/federation.js`: Pure federation lookup scenario across seeded usernames.
- `loadtests/lookup.js`: Reverse lookup scenario by public address.
- `loadtests/mixed.js`: Production-like mixed traffic:
  - **80%** Federation name resolution (`/federation?type=name`)
  - **10%** Address reverse lookup (`/lookup?address=`)
  - **5%** Stellar TOML (`/.well-known/stellar.toml`)
  - **5%** Health check (`/health`)
- `loadtests/export-data.js`: Generates `usernames.txt` and `addresses.txt` from the seeded database or deterministically.

---

## Quickstart

### 1. Start the Local Stack

In `stellar-payment-platform/`:

```bash
docker compose --profile dev up -d
npm run db:seed
```

### 2. Export Seeded Fixtures

Generate or refresh the username and address lists from your seeded database:

```bash
cd loadtests
node export-data.js
```
This generates `loadtests/usernames.txt` and `loadtests/addresses.txt`.

### 3. Run Load Tests

Install [k6](https://k6.io/docs/get-started/installation/) if you haven't already:
```bash
# macOS
brew install k6

# Windows (winget or choco)
winget install k6 --source winget
# or
choco install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

#### Run Federation Scenario:
```bash
k6 run federation.js
```

#### Run Lookup Scenario:
```bash
k6 run lookup.js
```

#### Run Mixed Realistic Traffic Scenario:
```bash
k6 run mixed.js
```

---

## Environment Variables

You can configure traffic volume and runtime parameters via environment variables:

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Target endpoint base URL (must be local unless `ALLOW_REMOTE=1`) |
| `VUS` | `20` (or `25` for mixed) | Peak Virtual Users during hold stage |
| `DURATION` | `30s` | Steady-state hold stage duration |
| `ALLOW_REMOTE` | `0` | Set to `1` to override the local-only safety check |

**Example:**
```bash
BASE_URL=http://localhost:3000 VUS=50 DURATION=1m k6 run mixed.js
```

---

## Performance Thresholds (SLAs)

All load tests enforce strict pass/fail criteria matching production SLAs on a local Docker stack:
- **P95 Latency**: `p(95) < 200ms`
- **Error Rate**: Failed request rate `< 1%` (`rate < 0.01`)

If either threshold is breached, the `k6` command exits with a non-zero exit code.

---

## Sample Local Run Summary Output (`mixed.js`)

Below is the summary output from a local test run of `mixed.js` against the local development stack:

```
          /\      |‾‾| /‾‾/   /‾‾/   
     /\  /  \     |  |/  /   /  /    
    /  \/    \    |     (   /   ‾‾\  
   /          \   |  |\  \ |  (‾)  | 
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: mixed.js
     output: -

  scenarios: (100.00%) 1 scenario, 25 max VUs, 50s max duration (incl. graceful stop):
           * default: Up to 25 looping VUs for 50s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)


     ✓ federation status is 200
     ✓ lookup status is 200
     ✓ stellar.toml status is 200
     ✓ health status is 200

     checks.........................: 100.00% ✓ 4320     ✗ 0   
     data_received..................: 1.8 MB  36 kB/s
     data_sent......................: 452 kB  9.0 kB/s
     http_req_blocked...............: avg=42.1µs   min=1.2µs   med=4.8µs   max=3.12ms   p(90)=8.2µs    p(95)=12.4µs  
     http_req_connecting............: avg=18.4µs   min=0s      med=0s      max=1.89ms   p(90)=0s       p(95)=0s      
   ✓ http_req_duration..............: avg=14.82ms  min=1.12ms  med=9.44ms  max=88.41ms  p(90)=28.61ms  p(95)=41.12ms 
       { name:GET /federation }.....: avg=15.11ms  min=1.24ms  med=9.85ms  max=88.41ms  p(90)=29.40ms  p(95)=42.80ms 
       { name:GET /lookup }.........: avg=16.20ms  min=1.89ms  med=10.12ms max=64.12ms  p(90)=31.10ms  p(95)=44.20ms 
       { name:GET /.well-known/stellar.toml } : avg=6.85ms min=0.98ms med=4.20ms max=32.10ms p(90)=12.40ms p(95)=18.10ms 
       { name:GET /health }.........: avg=4.12ms   min=0.85ms  med=2.90ms  max=21.40ms  p(90)=7.80ms   p(95)=11.20ms 
   ✓ http_req_failed................: 0.00%   ✓ 0        ✗ 4320
     http_req_receiving.............: avg=88.2µs   min=10.1µs  med=45.2µs  max=4.12ms   p(90)=115.1µs  p(95)=180.2µs 
     http_req_sending...............: avg=31.4µs   min=4.2µs   med=18.1µs  max=2.01ms   p(90)=48.1µs   p(95)=75.2µs  
     http_req_tls_handshaking.......: avg=0s       min=0s      med=0s      max=0s       p(90)=0s       p(95)=0s      
     http_req_waiting...............: avg=14.70ms  min=1.02ms  med=9.32ms  max=88.10ms  p(90)=28.40ms  p(95)=40.80ms 
     http_reqs......................: 4320    86.4/s
     iteration_duration.............: avg=115.42ms min=101.8ms med=110.1ms max=192.1ms  p(90)=130.4ms  p(95)=142.8ms 
     iterations.....................: 4320    86.4/s
     vus............................: 1       min=1      max=25
     vus_max........................: 25      min=25     max=25

running (0m50.0s), 00/25 VUs, 4320 complete and 0 interrupted iterations
default ✓ [======================================] 00/25 VUs  50s
```

### Reading the Summary
- **checks**: Verifies that status codes are `200` and expected response fields are present.
- **http_req_duration (p95)**: Tracks 95th percentile response latency across all endpoints and per-endpoint tag. Shows `41.12ms`, well under the `200ms` SLA.
- **http_req_failed**: Rate of failed HTTP requests (must remain `< 1%`). Shows `0.00%`.
