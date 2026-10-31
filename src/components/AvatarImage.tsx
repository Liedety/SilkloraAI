import React, { useState, useEffect } from 'react';
import { User, Users } from 'lucide-react';

interface AvatarImageProps {
  src?: string | null;
  alt?: string;
  className?: string;
  isGroup?: boolean;
  iconClassName?: string;
}

export const AvatarImage: React.FC<AvatarImageProps> = ({
  src,
  alt = 'Avatar',
  className = 'w-full h-full object-cover',
  isGroup = false,
  iconClassName = 'w-1/2 h-1/2',
}) => {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  const isValidSrc = Boolean(
    src &&
      typeof src === 'string' &&
      src.trim().length > 0 &&
      !src.startsWith('data:image/svg+xml;utf8,<svg') // filter unencoded SVG fallback
  );

  if (!isValidSrc || hasError) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-violet-900/60 to-indigo-950/80 text-violet-300 select-none">
        {isGroup ? (
          <Users className={`${iconClassName} stroke-[1.75] opacity-80`} />
        ) : (
          <User className={`${iconClassName} stroke-[1.75] opacity-80`} />
        )}
      </div>
    );
  }

  return (
    <img
      src={src!}
      alt={alt}
      className={className}
      onError={() => setHasError(true)}
      loading="lazy"
    />
  );
};
