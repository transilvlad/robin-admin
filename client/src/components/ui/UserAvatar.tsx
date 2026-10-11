/**
 * User avatar component with Gravatar support.
 */

import { getGravatarUrl } from '../../utils/gravatar';

interface UserAvatarProps {
  email: string;
  size?: number;
  className?: string;
}

export function UserAvatar({ email, size = 32, className = '' }: UserAvatarProps) {
  const gravatarUrl = getGravatarUrl(email, {
    size: size * 2, // 2x for retina
    defaultImage: 'monsterid',
    rating: 'g',
  });

  return (
    <img
      src={gravatarUrl}
      alt={email}
      width={size}
      height={size}
      className={`rounded-full ${className}`}
      loading="lazy"
    />
  );
}
