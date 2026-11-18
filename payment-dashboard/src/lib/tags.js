import { API_BASE, fullTag } from '../views/shared';

// Mirrors the backend rules in POST /register.
export const TAG_PATTERN = /^[a-zA-Z0-9]+$/;
export const TAG_MIN = 3;
export const TAG_MAX = 20;
export const RESERVED_TAGS = [
  'admin',
  'root',
  'stellar',
  'system',
  'superuser',
  'administrator',
  'support',
];

/** Returns an error message for a tag that breaks the rules, or ''. */
export const validateTag = (value) => {
  const name = value.trim();
  if (!name) return '';
  if (!TAG_PATTERN.test(name)) return 'Letters and numbers only.';
  if (name.length < TAG_MIN) return `At least ${TAG_MIN} characters.`;
  if (name.length > TAG_MAX) return `At most ${TAG_MAX} characters.`;
  if (RESERVED_TAGS.includes(name.toLowerCase())) return 'That name is reserved.';
  return '';
};

/**
 * Checks whether a tag is free through the federation endpoint. Resolves to
 * { state, text } where state is idle, invalid, available, taken or unknown.
 */
export const checkTag = async (value, { signal } = {}) => {
  const name = value.trim();
  if (!name) return { state: 'idle', text: 'Type a name to check' };

  const problem = validateTag(name);
  if (problem) return { state: 'invalid', text: problem };

  const bare = name.toLowerCase();
  const full = fullTag(bare);
  try {
    // Query the bare name so the backend resolves it against the domain it
    // stored at registration, whatever VITE_FEDERATION_DOMAIN says.
    const response = await fetch(
      `${API_BASE}/federation?q=${encodeURIComponent(bare)}&type=name`,
      { signal },
    );
    if (response.ok) return { state: 'taken', text: `${full} is taken` };
    if (response.status === 404) return { state: 'available', text: `${full} is available` };
    return { state: 'unknown', text: 'Could not check right now' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { state: 'unknown', text: 'Could not reach the tag service' };
  }
};
