# WebAuthn/Passkeys Authentication

## Overview

This implementation provides **passwordless authentication** using the WebAuthn/FIDO2 standard. Users can authenticate using:

- **Platform authenticators**: Touch ID, Face ID, Windows Hello
- **Security keys**: YubiKey, Titan Key, etc.
- **Passkeys**: Synced credentials across devices (iCloud Keychain, Google Password Manager)

## Features

✅ **Registration**: Register new passkeys/authenticators
✅ **Authentication**: Login without passwords
✅ **Credential Management**: List, revoke, and rename passkeys
✅ **Device Types**: Support for platform and cross-platform authenticators
✅ **Replay Protection**: Counter-based protection against replay attacks
✅ **User Verification**: Built-in biometric or PIN verification
✅ **Multiple Credentials**: Users can register multiple authenticators

## Architecture

### Components

1. **WebAuthn Service** (`src/services/webauthnService.js`)
   - Challenge generation and verification
   - Credential storage and management
   - Implements Relying Party (RP) logic

2. **WebAuthn Routes** (`src/routes/v1/webauthnRoutes.js`)
   - RESTful API endpoints
   - Registration and authentication flows
   - Credential management

3. **Cleanup Cron** (`src/webauthn-cleanup-cron.js`)
   - Removes expired challenges
   - Runs hourly

### Database Schema

#### webauthn_credentials
Stores registered authenticators:
- `id` - Unique credential record ID
- `user_id` - User identifier (email, username, etc.)
- `credential_id` - Base64URL-encoded credential ID from authenticator
- `public_key` - Base64-encoded public key for signature verification
- `counter` - Signature counter for replay protection
- `device_type` - 'platform' or 'cross-platform'
- `transports` - Available transports (usb, nfc, ble, internal)
- `friendly_name` - User-provided name (e.g., "My MacBook Touch ID")
- `created_at`, `last_used_at`, `revoked_at` - Timestamps

#### webauthn_challenges
Temporary challenges for ceremonies:
- `id` - Challenge record ID
- `challenge` - Base64URL-encoded random challenge
- `user_id` - Associated user (optional for registration)
- `type` - 'registration' or 'authentication'
- `expires_at` - Challenge expiration (5 minutes)
- `used` - Whether challenge was used
- `ip_address`, `user_agent` - Request metadata

## Environment Configuration

Add to `.env`:

```env
# WebAuthn Configuration
WEBAUTHN_RP_NAME="Stellar Tags"
WEBAUTHN_RP_ID="localhost"
WEBAUTHN_ORIGIN="http://localhost:5001"

# For production:
# WEBAUTHN_RP_ID="stellartags.com"
# WEBAUTHN_ORIGIN="https://stellartags.com"
```

**Important Notes:**
- `RP_ID` must match your domain (e.g., `example.com`)
- `ORIGIN` must include protocol and port if not standard
- For local development, use `localhost` (not `127.0.0.1`)

## API Endpoints

### Registration Flow

#### 1. Request Registration Options

```http
POST /api/v1/webauthn/register/options
Content-Type: application/json

{
  "userId": "user@example.com",
  "userName": "user@example.com",
  "userDisplayName": "John Doe",
  "authenticatorAttachment": "platform"  // Optional: "platform" or "cross-platform"
}
```

**Response:**
```json
{
  "success": true,
  "options": {
    "challenge": "8fzWZ...",
    "rp": { "name": "Stellar Tags", "id": "localhost" },
    "user": {
      "id": "user@example.com",
      "name": "user@example.com",
      "displayName": "John Doe"
    },
    "pubKeyCredParams": [...],
    "timeout": 60000,
    "attestation": "none",
    "excludeCredentials": [...],
    "authenticatorSelection": {...}
  }
}
```

#### 2. Verify Registration

```http
POST /api/v1/webauthn/register/verify
Content-Type: application/json

{
  "userId": "user@example.com",
  "registrationResponse": {
    // Response from navigator.credentials.create()
  },
  "friendlyName": "My MacBook Touch ID",
  "deviceType": "platform"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Passkey registered successfully",
  "data": {
    "verified": true,
    "credentialId": "abc123...",
    "deviceType": "platform",
    "friendlyName": "My MacBook Touch ID"
  }
}
```

### Authentication Flow

#### 1. Request Authentication Options

```http
POST /api/v1/webauthn/authenticate/options
Content-Type: application/json

{
  "userId": "user@example.com"  // Optional for discoverable credentials
}
```

**Response:**
```json
{
  "success": true,
  "options": {
    "challenge": "9azYX...",
    "timeout": 60000,
    "rpId": "localhost",
    "allowCredentials": [...],
    "userVerification": "preferred"
  }
}
```

#### 2. Verify Authentication

```http
POST /api/v1/webauthn/authenticate/verify
Content-Type: application/json

{
  "authenticationResponse": {
    // Response from navigator.credentials.get()
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "userId": "user@example.com",
    "credentialId": "abc123...",
    "deviceType": "platform"
  },
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Credential Management

#### List Credentials

```http
GET /api/v1/webauthn/credentials?userId=user@example.com
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "credentialId": "abc123...",
      "deviceType": "platform",
      "friendlyName": "My MacBook Touch ID",
      "createdAt": "2026-09-27T10:00:00.000Z",
      "lastUsedAt": "2026-09-27T12:30:00.000Z",
      "transports": ["internal"],
      "credentialBackedUp": false
    }
  ],
  "count": 1
}
```

#### Revoke Credential

```http
DELETE /api/v1/webauthn/credentials/{credentialId}
Content-Type: application/json

{
  "userId": "user@example.com"
}
```

#### Update Credential Name

```http
PATCH /api/v1/webauthn/credentials/{credentialId}/name
Content-Type: application/json

{
  "userId": "user@example.com",
  "friendlyName": "Work Laptop - Touch ID"
}
```

## Client-Side Integration

### Registration Example

```javascript
// 1. Get registration options from server
const optionsResponse = await fetch('/api/v1/webauthn/register/options', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user@example.com',
    userName: 'user@example.com',
    userDisplayName: 'John Doe'
  })
});

const { options } = await optionsResponse.json();

// 2. Create credential using WebAuthn API
const credential = await navigator.credentials.create({
  publicKey: {
    ...options,
    challenge: Uint8Array.from(atob(options.challenge), c => c.charCodeAt(0)),
    user: {
      ...options.user,
      id: Uint8Array.from(options.user.id, c => c.charCodeAt(0))
    }
  }
});

// 3. Send credential to server for verification
const verifyResponse = await fetch('/api/v1/webauthn/register/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user@example.com',
    registrationResponse: credential,
    friendlyName: 'My Device'
  })
});

const result = await verifyResponse.json();
console.log('Registration successful:', result);
```

### Authentication Example

```javascript
// 1. Get authentication options
const optionsResponse = await fetch('/api/v1/webauthn/authenticate/options', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user@example.com'
  })
});

const { options } = await optionsResponse.json();

// 2. Get credential from authenticator
const credential = await navigator.credentials.get({
  publicKey: {
    ...options,
    challenge: Uint8Array.from(atob(options.challenge), c => c.charCodeAt(0))
  }
});

// 3. Verify authentication
const verifyResponse = await fetch('/api/v1/webauthn/authenticate/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    authenticationResponse: credential
  })
});

const result = await verifyResponse.json();
console.log('Authentication successful:', result);
// Use result.token for authenticated API requests
```

## Security Features

### Replay Protection
- Each authentication increments a counter stored with the credential
- Server rejects authentication if counter doesn't increase
- Prevents replay of captured authentication responses

### User Verification
- Requires biometric (fingerprint, face) or PIN verification
- Ensures the person using the device is authorized
- Configured via `userVerification: "preferred"`

### Challenge-Response
- Random challenge prevents pre-computed attacks
- Challenge expires after 5 minutes
- Used once and then discarded

### Public Key Cryptography
- Private key never leaves the authenticator
- Server only stores public key
- Resistant to phishing (origin-bound)

## Best Practices

### For Developers

1. **Always use HTTPS in production** - WebAuthn requires secure context
2. **Set correct RP_ID** - Must match your domain
3. **Handle errors gracefully** - Not all devices support WebAuthn
4. **Provide fallback** - Keep email/password option for older devices
5. **Store friendly names** - Help users identify their passkeys
6. **Allow multiple credentials** - Users want backup authenticators

### For Users

1. **Register multiple passkeys** - Have a backup
2. **Use platform authenticators** - More secure than cross-platform
3. **Name your passkeys** - "Work MacBook", "Personal iPhone", etc.
4. **Keep devices updated** - Newer OS versions improve security

## Troubleshooting

### "Challenge not found or expired"
- Challenge expires after 5 minutes
- Request new registration/authentication options
- Check server time is synchronized

### "Origin mismatch"
- Ensure `WEBAUTHN_ORIGIN` matches your frontend URL exactly
- Include protocol (http/https) and port if non-standard
- For localhost, use `http://localhost:PORT` not `http://127.0.0.1:PORT`

### "Credential not found"
- User may have deleted the passkey from their device
- Check if credential was revoked
- Verify user is using same device/account

### "User verification failed"
- User cancelled biometric prompt
- Biometric not enrolled on device
- PIN/password not set up

## Testing

### Manual Testing

1. **Register a passkey**:
   ```bash
   curl -X POST http://localhost:5001/api/v1/webauthn/register/options \
     -H "Content-Type: application/json" \
     -d '{"userId":"test@example.com","userName":"test@example.com"}'
   ```

2. **Use browser console** to complete registration:
   ```javascript
   // Copy challenge from API response and use navigator.credentials.create()
   ```

3. **List credentials**:
   ```bash
   curl "http://localhost:5001/api/v1/webauthn/credentials?userId=test@example.com"
   ```

### Browser Support

- ✅ Chrome 67+ (Desktop & Android)
- ✅ Firefox 60+
- ✅ Safari 13+ (macOS, iOS)
- ✅ Edge 18+
- ❌ IE 11 (not supported)

Check current support: [caniuse.com/webauthn](https://caniuse.com/webauthn)

## Migration from Password-Based Auth

### Gradual Rollout

1. **Phase 1**: Add WebAuthn alongside existing auth
2. **Phase 2**: Encourage users to register passkeys
3. **Phase 3**: Make WebAuthn primary (keep password as fallback)
4. **Phase 4**: Eventually deprecate password auth

### User Migration Flow

```
1. User logs in with password
2. Show prompt: "Secure your account with a passkey"
3. User completes WebAuthn registration
4. Next login: Offer passkey authentication first
5. Show password option as fallback
```

## Monitoring

Key metrics to track:
- WebAuthn adoption rate
- Registration success/failure rate
- Authentication success/failure rate
- Most common error types
- Device/browser distribution
- Average authentication time

## Resources

- [WebAuthn Guide](https://webauthn.guide/)
- [FIDO Alliance](https://fidoalliance.org/)
- [W3C WebAuthn Spec](https://www.w3.org/TR/webauthn/)
- [SimpleWebAuthn Docs](https://simplewebauthn.dev/)
- [Passkeys.dev](https://passkeys.dev/)

## Future Enhancements

- [ ] Conditional UI (autofill passkeys)
- [ ] Account recovery flow
- [ ] Multi-device credential sync
- [ ] Attestation verification for enterprise
- [ ] WebAuthn as 2FA (alongside password)
- [ ] Admin dashboard for credential management
