import { LoaderCircle } from 'lucide-react';

interface SpinnerProps {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

export function Spinner({ label = 'Loading', size = 'md', className = '' }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={`inline-flex items-center justify-center ${className}`}>
      <LoaderCircle
        aria-hidden="true"
        className={`${sizeClasses[size]} animate-spin motion-reduce:animate-none`}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
