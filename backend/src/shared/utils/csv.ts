import { Response } from 'express';

/**
 * ساخت CSV با BOM — بدون BOM، اکسل فارسی را به‌هم می‌ریزد.
 * قبلاً کپیِ محلی در `accounting.routes.ts` بود؛ هستهٔ جدید هم لازمش داشت.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

export function sendCsv(res: Response, filename: string, content: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(content);
}
