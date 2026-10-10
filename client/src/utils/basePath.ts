export function normalizeBasePath(basePath = '/'): string {
  const normalized = basePath.trim();
  if (!normalized.startsWith('/')) {
    throw new Error('Base path must start with "/"');
  }
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function prefixAppPath(path: string, basePath: string): string {
  if (!path.startsWith('/')) {
    return path;
  }
  return `${normalizeBasePath(basePath).replace(/\/$/, '')}${path}`;
}
