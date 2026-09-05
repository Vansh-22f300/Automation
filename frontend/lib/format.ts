export function formatDate(value: string | null): string {
  if (value === null) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatDuration(value: number | null): string {
  if (value === null) return 'In progress';
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
