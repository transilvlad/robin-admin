/**
 * Gravatar URL utility.
 */

import md5 from 'blueimp-md5';

export interface GravatarOptions {
  size?: number;
  defaultImage?: 'identicon' | 'monsterid' | 'wavatar' | 'retro' | 'robohash' | 'blank' | 'mp';
  rating?: 'g' | 'pg' | 'r' | 'x';
}

/**
 * Generate a Gravatar URL for an email address.
 */
export function getGravatarUrl(email: string, options: GravatarOptions = {}): string {
  const { size = 80, defaultImage = 'monsterid', rating = 'g' } = options;
  
  const hash = md5(email.toLowerCase().trim());
  const params = new URLSearchParams({
    s: String(size),
    d: defaultImage,
    r: rating,
  });
  
  return `https://www.gravatar.com/avatar/${hash}?${params}`;
}
