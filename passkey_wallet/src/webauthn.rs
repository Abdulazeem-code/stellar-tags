//! WebAuthn assertion helpers that work on plain byte slices.
//!
//! These are the pieces of assertion verification that do not need the host:
//! reading `type` and `challenge` out of `clientDataJSON`, base64url encoding
//! the expected challenge, and the low-S check on the ECDSA signature. The
//! contract combines them with the host's sha256 and secp256r1 functions in
//! `lib.rs`.

/// Upper bound on `clientDataJSON`. Browsers produce ~130-250 bytes; anything
/// much larger is rejected before parsing.
pub const MAX_CLIENT_DATA_LEN: usize = 1024;

/// Authenticator data is rpIdHash (32) || flags (1) || signCount (4) || ...
pub const MIN_AUTHENTICATOR_DATA_LEN: u32 = 37;
pub const FLAGS_INDEX: u32 = 32;
pub const FLAG_USER_PRESENT: u8 = 0x01;
pub const FLAG_USER_VERIFIED: u8 = 0x04;

/// base64url (no padding) of a 32-byte value is always 43 characters.
pub const CHALLENGE_LEN: usize = 43;

/// Half of the secp256r1 group order, big-endian. A signature whose `s` is
/// greater than this is the "high-S" twin of a valid signature.
pub const SECP256R1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
];

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encodes 32 bytes as base64url without padding.
pub fn base64url_32(input: &[u8; 32]) -> [u8; CHALLENGE_LEN] {
    let mut out = [0u8; CHALLENGE_LEN];
    let mut o = 0;
    let mut i = 0;
    while i + 3 <= 32 {
        let n =
            (u32::from(input[i]) << 16) | (u32::from(input[i + 1]) << 8) | u32::from(input[i + 2]);
        out[o] = BASE64URL[(n >> 18) as usize & 63];
        out[o + 1] = BASE64URL[(n >> 12) as usize & 63];
        out[o + 2] = BASE64URL[(n >> 6) as usize & 63];
        out[o + 3] = BASE64URL[n as usize & 63];
        i += 3;
        o += 4;
    }
    // 32 = 10 * 3 + 2: two bytes left, three characters, no padding.
    let n = (u32::from(input[30]) << 16) | (u32::from(input[31]) << 8);
    out[o] = BASE64URL[(n >> 18) as usize & 63];
    out[o + 1] = BASE64URL[(n >> 12) as usize & 63];
    out[o + 2] = BASE64URL[(n >> 6) as usize & 63];
    out
}

/// True when the big-endian `s` half of an r || s signature is above n/2.
pub fn is_high_s(signature: &[u8; 64]) -> bool {
    let s = &signature[32..];
    for (byte, half) in s.iter().zip(SECP256R1_HALF_ORDER.iter()) {
        if byte != half {
            return byte > half;
        }
    }
    false
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ClientDataError {
    /// Not a JSON object, truncated, or otherwise malformed.
    Malformed,
    /// The same top-level key appears more than once.
    DuplicateKey,
}

/// The two fields the contract checks, as byte ranges into the input.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ClientData {
    pub type_: Option<(usize, usize)>,
    pub challenge: Option<(usize, usize)>,
}

/// Reads the top-level string values of `type` and `challenge` from
/// `clientDataJSON`.
///
/// This is a small strict scanner, not a full JSON parser: it walks the
/// top-level object, skips nested objects and arrays (for example the legacy
/// `tokenBinding` member), and returns the raw byte range of each wanted
/// string value. Values are compared byte for byte, so an escaped value never
/// matches. Duplicate keys are rejected so a second `challenge` cannot shadow
/// the first, and trailing bytes after the object are rejected.
pub fn parse_client_data(json: &[u8]) -> Result<ClientData, ClientDataError> {
    let mut out = ClientData::default();
    let mut p = Parser { buf: json, pos: 0 };

    p.skip_ws();
    p.expect(b'{')?;
    p.skip_ws();
    if p.peek() == Some(b'}') {
        p.pos += 1;
    } else {
        loop {
            p.skip_ws();
            let key = p.string()?;
            p.skip_ws();
            p.expect(b':')?;
            p.skip_ws();
            let key_bytes = &json[key.0..key.1];
            let slot = match key_bytes {
                b"type" => Some(&mut out.type_),
                b"challenge" => Some(&mut out.challenge),
                _ => None,
            };
            match slot {
                Some(slot) => {
                    if slot.is_some() {
                        return Err(ClientDataError::DuplicateKey);
                    }
                    if p.peek() == Some(b'"') {
                        *slot = Some(p.string()?);
                    } else {
                        // Present but not a string: leave it unset so the
                        // caller reports a wrong type / challenge. Mark the
                        // slot so a later duplicate is still caught.
                        p.skip_value()?;
                        *slot = Some((0, 0));
                    }
                }
                None => p.skip_value()?,
            }
            p.skip_ws();
            match p.next() {
                Some(b',') => {}
                Some(b'}') => break,
                _ => return Err(ClientDataError::Malformed),
            }
        }
    }
    p.skip_ws();
    if p.pos != json.len() {
        return Err(ClientDataError::Malformed);
    }
    Ok(out)
}

struct Parser<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.buf.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.pos += 1;
        Some(c)
    }

    fn expect(&mut self, c: u8) -> Result<(), ClientDataError> {
        if self.next() == Some(c) {
            Ok(())
        } else {
            Err(ClientDataError::Malformed)
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// Consumes a string and returns the range of its raw contents (between
    /// the quotes, escapes left as-is).
    fn string(&mut self) -> Result<(usize, usize), ClientDataError> {
        self.expect(b'"')?;
        let start = self.pos;
        loop {
            match self.next() {
                None => return Err(ClientDataError::Malformed),
                Some(b'"') => return Ok((start, self.pos - 1)),
                Some(b'\\') => {
                    if self.next().is_none() {
                        return Err(ClientDataError::Malformed);
                    }
                }
                Some(c) if c < 0x20 => return Err(ClientDataError::Malformed),
                Some(_) => {}
            }
        }
    }

    /// Skips one JSON value: string, nested object/array, or a bare literal
    /// (number, true, false, null).
    fn skip_value(&mut self) -> Result<(), ClientDataError> {
        match self.peek() {
            Some(b'"') => self.string().map(|_| ()),
            Some(b'{' | b'[') => {
                let mut depth = 0usize;
                loop {
                    match self.peek() {
                        None => return Err(ClientDataError::Malformed),
                        Some(b'"') => {
                            self.string()?;
                            continue;
                        }
                        Some(b'{' | b'[') => depth += 1,
                        Some(b'}' | b']') => {
                            depth -= 1;
                            if depth == 0 {
                                self.pos += 1;
                                return Ok(());
                            }
                        }
                        Some(_) => {}
                    }
                    self.pos += 1;
                }
            }
            Some(_) => {
                let start = self.pos;
                while let Some(c) = self.peek() {
                    if matches!(c, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                        break;
                    }
                    self.pos += 1;
                }
                if self.pos == start {
                    Err(ClientDataError::Malformed)
                } else {
                    Ok(())
                }
            }
            None => Err(ClientDataError::Malformed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(json: &[u8], range: Option<(usize, usize)>) -> &[u8] {
        let (a, b) = range.unwrap();
        &json[a..b]
    }

    #[test]
    fn base64url_matches_known_values() {
        assert_eq!(
            &base64url_32(&[0u8; 32]),
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert_eq!(
            &base64url_32(&[0xffu8; 32]),
            b"__________________________________________8"
        );
        let mut seq = [0u8; 32];
        for (b, value) in seq.iter_mut().zip(0u8..) {
            *b = value;
        }
        assert_eq!(
            &base64url_32(&seq),
            b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        );
    }

    #[test]
    fn high_s_boundary() {
        let mut sig = [0u8; 64];
        sig[32..].copy_from_slice(&SECP256R1_HALF_ORDER);
        assert!(!is_high_s(&sig), "s == n/2 is low");
        sig[63] += 1;
        assert!(is_high_s(&sig), "s == n/2 + 1 is high");
        sig[32] = 0x80;
        assert!(is_high_s(&sig));
        let low = [0u8; 64];
        assert!(!is_high_s(&low));
    }

    #[test]
    fn parses_browser_client_data() {
        let json = br#"{"type":"webauthn.get","challenge":"abc","origin":"https://x","crossOrigin":false}"#;
        let cd = parse_client_data(json).unwrap();
        assert_eq!(field(json, cd.type_), b"webauthn.get");
        assert_eq!(field(json, cd.challenge), b"abc");
    }

    #[test]
    fn handles_whitespace_nesting_and_order() {
        let json = br#" { "tokenBinding" : {"status":"present","id":"x}"} , "challenge" : "c1", "n": -1.5e3, "a":[1,{"b":"]"}], "type":"t" } "#;
        let cd = parse_client_data(json).unwrap();
        assert_eq!(field(json, cd.type_), b"t");
        assert_eq!(field(json, cd.challenge), b"c1");
    }

    #[test]
    fn keys_inside_strings_or_nested_objects_are_ignored() {
        let json = br#"{"note":"\"challenge\":\"evil\"","x":{"challenge":"evil"},"challenge":"good","type":"webauthn.get"}"#;
        let cd = parse_client_data(json).unwrap();
        assert_eq!(field(json, cd.challenge), b"good");
    }

    #[test]
    fn rejects_duplicates_and_malformed_input() {
        assert_eq!(
            parse_client_data(br#"{"challenge":"a","challenge":"b"}"#),
            Err(ClientDataError::DuplicateKey)
        );
        assert_eq!(
            parse_client_data(br#"{"type":"a","type":1}"#),
            Err(ClientDataError::DuplicateKey)
        );
        for bad in [
            &b""[..],
            b"[]",
            b"{",
            br#"{"type":"webauthn.get""#,
            br#"{"type" "x"}"#,
            br#"{"type":"x",}"#,
            br#"{"type":"x"} trailing"#,
            br#"{"type":"unterminated}"#,
            b"{\"type\":\"a\nb\"}",
        ] {
            assert_eq!(
                parse_client_data(bad),
                Err(ClientDataError::Malformed),
                "{:?}",
                core::str::from_utf8(bad)
            );
        }
    }

    #[test]
    fn non_string_values_are_marked_but_empty() {
        let json = br#"{"type":1,"challenge":null}"#;
        let cd = parse_client_data(json).unwrap();
        assert_eq!(cd.type_, Some((0, 0)));
        assert_eq!(cd.challenge, Some((0, 0)));
    }
}
