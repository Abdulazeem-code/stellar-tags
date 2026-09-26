import { useCallback, useState } from 'react';

const STORAGE_KEY = 'recent_transactions';
const MAX_ENTRIES = 5;

/**
 * Reads the recent address list from localStorage.
 * Returns an empty array if nothing is stored or the data is malformed.
 * @returns {string[]}
 */
function readFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Custom hook for managing recently used payment addresses/usernames.
 *
 * Persists up to MAX_ENTRIES entries in localStorage under the
 * "recent_transactions" key.  The most-recently-used entry always
 * appears first.
 *
 * @returns {{ recentAddresses: string[], saveAddress: (address: string) => void, clearAddresses: () => void }}
 */
export function useRecentAddresses() {
  const [recentAddresses, setRecentAddresses] = useState(() => readFromStorage());

  /**
   * Persists a new address/username to the top of the recent list.
   * Duplicates are de-duped (moved to the front) and the list is
   * capped at MAX_ENTRIES.
   *
   * @param {string} address - The resolved recipient address or username to save.
   */
  const saveAddress = useCallback((address) => {
    if (!address || typeof address !== 'string') return;

    const trimmed = address.trim();
    if (!trimmed) return;

    setRecentAddresses((prev) => {
      // Remove existing occurrence to avoid duplicates, then prepend.
      const deduped = prev.filter((entry) => entry !== trimmed);
      const updated = [trimmed, ...deduped].slice(0, MAX_ENTRIES);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Quota exceeded or private browsing — silently skip persistence.
      }
      return updated;
    });
  }, []);

  /** Wipes the stored list from both state and localStorage. */
  const clearAddresses = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
    setRecentAddresses([]);
  }, []);

  return { recentAddresses, saveAddress, clearAddresses };
}
