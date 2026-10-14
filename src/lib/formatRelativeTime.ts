/** "Opened 5m ago" style labels for dashboard recency. */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "Never opened";
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) return "Never opened";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "Opened just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Opened ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Opened ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Opened ${days}d ago`;
  return `Opened ${new Date(time).toLocaleDateString()}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
