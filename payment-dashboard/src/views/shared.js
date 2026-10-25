import { useEffect, useRef, useState } from 'react';

export const CONTRACT_ID = 'CDNQ7OMHIFOLZHOKWQLOGDW7CF3DRMKXJC6OULNGNBWF4O4NO2NEIGER';
export const TREASURY_ADDRESS = 'GAAFWEZKDYPXLTQGKQ3F23TXWYQUDAYTDW7P7VUQSVJFW2GWC4Y6LWST';
export const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
export const API_BASE =
  import.meta.env.VITE_API_BASE || 'https://stellar-tags.onrender.com';
export const DEFAULT_FEDERATION_DOMAIN =
  import.meta.env.VITE_FEDERATION_DOMAIN || 'localhost';
export const HORIZON_BASE = 'https://horizon-testnet.stellar.org';
export const ANALYTICS_WINDOW_MS = 60 * 60 * 1000;
export const ANALYTICS_PAGE_LIMIT = 200;
export const ANALYTICS_MAX_PAGES = 5;
export const ANALYTICS_REFRESH_MS = 60 * 1000;

let stellarSdkPromise;
export const loadStellarSdk = () => {
  if (!stellarSdkPromise) {
    stellarSdkPromise = import('@stellar/stellar-sdk');
  }
  return stellarSdkPromise;
};

export const normalizeNameTag = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  // A bare name goes to the API as is: the backend appends its own default
  // domain, which is what it stored at registration.
  return trimmed.toLowerCase();
};

/**
 * The full name*domain form of a username. The API stores and returns
 * usernames with the domain already attached, so only bare names get one.
 */
export const fullTag = (username) => {
  if (!username) return '';
  return username.includes('*') ? username : `${username}*${DEFAULT_FEDERATION_DOMAIN}`;
};

export const resolveRecipient = async (inputValue) => {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    return { error: 'Please enter a username or wallet address.' };
  }

  const { StrKey } = await loadStellarSdk();
  if (StrKey.isValidEd25519PublicKey(trimmed)) {
    return { address: trimmed };
  }

  const normalizedTag = normalizeNameTag(trimmed);
  return { tag: normalizedTag };
};

/**
 * Pulls a displayable message out of an API error body.
 *
 * The API answers `{ success: false, error: { code, message, details } }`. The
 * flat `error`/`detail`/`message` fallbacks cover responses that do not come
 * from the platform's error handler, such as a proxy or CDN error page.
 */
export const apiErrorMessage = (data, fallback) => {
  if (data && typeof data === 'object') {
    const { error } = data;
    if (error && typeof error === 'object' && error.message) {
      return error.message;
    }
    if (typeof error === 'string' && error) {
      return error;
    }
    if (typeof data.detail === 'string' && data.detail) {
      return data.detail;
    }
    if (typeof data.message === 'string' && data.message) {
      return data.message;
    }
  }
  return fallback;
};

/** Field-level validation issues, when the error carries them. */
export const apiErrorDetails = (data) => {
  const details = data && data.error && data.error.details;
  return Array.isArray(details) ? details : [];
};

/** A readable message for a failed request; fetch rejects with a bare TypeError offline. */
export const errorMessage = (error, fallback) => {
  if (error instanceof TypeError) {
    return 'Could not reach the network. Check your connection and try again.';
  }
  return error?.message || fallback;
};

export const formatUsername = (value) => {
  if (!value) {
    return '';
  }

  return value.split('*')[0];
};

export const formatShortAddress = (value) => {
  if (!value) {
    return '';
  }

  if (value.length < 10) {
    return value;
  }

  return `${value.substring(0, 4)}...${value.substring(52)}`;
};

export const useWalletMenu = () => {
  const menuRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return { menuRef, isOpen, setIsOpen };
};
