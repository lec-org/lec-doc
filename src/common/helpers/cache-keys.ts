export const CacheKey = {
  LICENSE_VALID: (workspaceId: string) => `license:valid:${workspaceId}`,
  SIEM_LICENSED: (workspaceId: string) => `siem:licensed:${workspaceId}`,
};

// Permission caches dedupe repeated checks within and across short request bursts.
// 5s keeps staleness on revocations bounded.
export const PERMISSION_CACHE_TTL_MS = 5_000;
