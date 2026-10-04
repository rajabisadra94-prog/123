/**
 * ردِ پای عملیاتِ دفترداری (ممیزی ج۱۶).
 *
 * جدا از تراکنشِ کسب‌وکار نوشته می‌شود — **بعد از** موفقیتِ عملیات، در مسیرِ HTTP.
 * دلیل: اگر داخلِ تراکنش باشد، rollback ردِ پا را هم می‌برد؛ ما فقط چیزی را که
 * واقعاً ثبت شده ثبت می‌کنیم. نوشتنِ ردِ پا هرگز نباید خودِ عملیات را بشکند، پس
 * خطایش بلعیده و فقط لاگ می‌شود.
 */
import { PrismaClient } from '@prisma/client';

export type GlAuditAction =
  | 'POST' | 'REVERSE'
  | 'DRAFT_CREATE' | 'DRAFT_UPDATE' | 'DRAFT_DISCARD' | 'DRAFT_POST'
  | 'YEAR_CLOSE' | 'YEAR_REOPEN'
  | 'PROVISION_PAY' | 'RATE_SET'
  | 'PERIOD_LOCK' | 'PERIOD_UNLOCK'
  | 'BUDGET_SET' | 'BUDGET_DELETE'
  | 'TAX_IDENTITY_SET'
  | 'ALLOCATE' | 'UNALLOCATE'
  | 'PROVISION_POST' | 'PROVISION_RATES'
  | 'ASSET_SET' | 'ASSET_DISPOSE' | 'DEPRECIATION_POST'
  | 'NOTE_SET' | 'NOTE_DELETE'
  // مدرک، پیوست و افتتاحیه — انطباق با ALIP
  | 'DOCUMENT_CREATE' | 'DOCUMENT_DRAFT' | 'DOCUMENT_SUBMITTED' | 'DOCUMENT_APPROVED'
  | 'DOCUMENT_POSTED' | 'DOCUMENT_CANCELLED' | 'DOCUMENT_RETURN'
  | 'ATTACHMENT_ADD' | 'ATTACHMENT_REMOVE'
  | 'OPENING_BALANCE';

export interface GlAuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: GlAuditAction;
  entryId?: string | null;
  entrySerial?: number | null;
  summary: string;
  meta?: unknown;
  /**
   * موجودیتِ هدف وقتی سند حسابداری نیست — مدرک، پیوست، حساب… (بند ۲۹ ALIP)
   */
  entity?: string | null;
  entityId?: string | null;
  /**
   * مقدار پیش و پس از تغییر.
   *
   * ⚠️ بند ۲۹ صریحاً «Old Value / New Value» می‌خواهد و تا امروز ذخیره
   * نمی‌شد — یعنی ردِ پا می‌گفت «چه کسی چه کاری کرد» ولی نمی‌گفت «از چه
   * به چه». برای سند حسابداری بی‌معنی است (ثبت‌شده ویرایش نمی‌شود)، ولی
   * برای مدرک و پیکربندی دقیقاً همان چیزی است که در ممیزی لازم می‌شود.
   */
  oldValue?: unknown;
  newValue?: unknown;
}

/** ثبتِ یک رویداد — بی‌صدا شکست می‌خورد تا عملیاتِ اصلی را به خطر نیندازد */
export async function recordGlAudit(prisma: PrismaClient, input: GlAuditInput): Promise<void> {
  try {
    await prisma.glAuditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        entryId: input.entryId ?? null,
        entrySerial: input.entrySerial ?? null,
        summary: input.summary,
        meta: input.meta === undefined ? undefined : (JSON.parse(safeJson(input.meta)) as any),
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        oldValue: input.oldValue === undefined ? undefined : (JSON.parse(safeJson(input.oldValue)) as any),
        newValue: input.newValue === undefined ? undefined : (JSON.parse(safeJson(input.newValue)) as any),
      },
    });
  } catch (e) {
    console.error('[gl-audit] ثبت ردِ پا ناموفق بود:', (e as Error).message);
  }
}

/** BigInt-safe — مبالغِ کوچک‌ترین‌واحد در meta رشته می‌شوند */
function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
}

export interface GlAuditQuery {
  action?: string;
  entryId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  take?: number;
  skip?: number;
}

export async function readGlAudit(prisma: PrismaClient, q: GlAuditQuery = {}) {
  const take = Math.min(q.take ?? 100, 500);
  const where = {
    ...(q.action ? { action: q.action } : {}),
    ...(q.entryId ? { entryId: q.entryId } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.from || q.to
      ? { at: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.glAuditLog.findMany({ where, orderBy: { at: 'desc' }, take, skip: q.skip ?? 0 }),
    prisma.glAuditLog.count({ where }),
  ]);
  return { rows, total, take, skip: q.skip ?? 0 };
}

/**
 * تفکیک وظایف: نهایی‌کنندهٔ پیش‌نویس نباید سازنده‌اش باشد (ممیزی ج۱۶).
 * با پرچمِ `LEDGER_MAKER_CHECKER=true` روشن می‌شود؛ پیش‌فرض خاموش.
 */
export const makerCheckerEnabled = (): boolean =>
  String(process.env.LEDGER_MAKER_CHECKER ?? '').toLowerCase() === 'true';

export class MakerCheckerError extends Error {}

/**
 * اگر تفکیک وظایف روشن است و `actorId` همان `creatorId` است، خطا می‌دهد.
 * `creatorId` تهی (سند بدون سازندهٔ ثبت‌شده) از کنترل عبور می‌کند.
 */
export function assertChecker(creatorId: string | null | undefined, actorId: string): void {
  if (!makerCheckerEnabled()) return;
  if (creatorId && creatorId === actorId) {
    throw new MakerCheckerError(
      'تفکیک وظایف: سازندهٔ پیش‌نویس نمی‌تواند خودش آن را نهایی کند — کاربر دیگری باید تأیید کند',
    );
  }
}
