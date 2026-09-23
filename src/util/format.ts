export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "in 1h 29m (2026-09-23 14:03 local)" for a future epoch-ms timestamp. */
export function formatWhen(epochMs: number, now = Date.now()): string {
  const delta = epochMs - now;
  const local = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
  if (delta >= 0) return `in ${formatDuration(delta)} (${stamp} local)`;
  return `${formatDuration(-delta)} ago (${stamp} local)`;
}
