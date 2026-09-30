/**
 * مسیرهای HTTP مدرک، پیوست و مانده افتتاحیه.
 *
 * جدا از `ledger.routes.ts` نگه داشته شده چون آن فایل ۲۳۰۰ خط است و
 * افزودن ۲۰۰ خط دیگر خواندنش را سخت‌تر می‌کند. روی همان `router` سوار
 * می‌شود، پس از بیرون تفاوتی ندارد.
 */
import { Router, Request, Response } from 'express';
import { Prisma, GlDocumentKind, GlDocumentStatus } from '@prisma/client';
import prisma from '../../shared/utils/prisma';
import { AppError } from '../../shared/middleware/errorHandler';
import { requireRole } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import {
  createDocument, transitionDocument, createReturn, postOpeningBalance,
  ALLOWED_TRANSITIONS, KIND_FA, STATUS_FA,
} from './document';
import { recordGlAudit, GlAuditInput, GlAuditAction } from './audit-log';

export function registerDocumentRoutes(
  router: Router,
  helpers: {
    send: (res: Response, data: unknown) => void;
    runOp: <T>(fn: () => Promise<T>) => Promise<T>;
    asDate: (v: unknown, fallback?: Date) => Date | undefined;
    requireDate: (v: unknown, field?: string) => Date;
    activeFiscalYear: (at?: Date) => Promise<{ id: string }>;
  },
) {
  const { send, runOp, asDate, requireDate, activeFiscalYear } = helpers;

  type AuditExtra = Omit<GlAuditInput, 'action' | 'summary' | 'actorId' | 'actorName'>;
  const audit = (req: Request, action: GlAuditAction, summary: string, extra: AuditExtra = {}) =>
    recordGlAudit(prisma, {
      actorId: req.user?.id ?? null,
      actorName: req.user?.name ?? req.user?.username ?? null,
      action, summary, ...extra,
    });

  // ─────────────────────────────────────────────────────────────
  // مدرک
  // ─────────────────────────────────────────────────────────────

  router.get('/documents', async (req: Request, res: Response) => {
    const take = Math.min(Number(req.query.take) || 50, 200);
    const skip = Number(req.query.skip) || 0;
    const where: Record<string, unknown> = {};
    if (req.query.kind) where.kind = String(req.query.kind);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.subsidiaryId) where.subsidiaryId = String(req.query.subsidiaryId);
    if (req.query.projectId) where.projectId = String(req.query.projectId);
    if (req.query.q) {
      where.OR = [
        { number: { contains: String(req.query.q), mode: 'insensitive' } },
        { description: { contains: String(req.query.q), mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      prisma.glDocument.findMany({
        where, take, skip, orderBy: [{ date: 'desc' }, { number: 'desc' }],
        include: {
          subsidiary: { select: { code: true, name: true } },
          project: { select: { code: true } },
          entry: { select: { serial: true } },
          _count: { select: { lines: true, attachments: true } },
        },
      }),
      prisma.glDocument.count({ where }),
    ]);
    send(res, { rows, total, take, skip, kinds: KIND_FA, statuses: STATUS_FA });
  });

  router.get('/documents/:id', async (req: Request, res: Response) => {
    const doc = await prisma.glDocument.findUnique({
      where: { id: req.params.id },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            account: { select: { code: true, name: true } },
            project: { select: { code: true } },
            costCenter: { select: { code: true, name: true } },
          },
        },
        subsidiary: { select: { id: true, code: true, name: true, kind: true } },
        project: { select: { id: true, code: true } },
        costCenter: { select: { id: true, code: true, name: true } },
        attachments: { orderBy: { uploadedAt: 'desc' } },
        transitions: { orderBy: { at: 'desc' } },
        entry: { select: { id: true, serial: true, date: true, status: true } },
        reversesDocument: { select: { id: true, number: true, kind: true } },
        returnDocument: { select: { id: true, number: true, kind: true, status: true } },
      },
    });
    if (!doc) throw new AppError(404, 'مدرک یافت نشد');
    send(res, { ...doc, allowedTransitions: ALLOWED_TRANSITIONS[doc.status as GlDocumentStatus] });
  });

  router.post('/documents', async (req: Request, res: Response) => {
    const b = req.body ?? {};
    if (!b.kind || !(b.kind in KIND_FA)) {
      throw new AppError(400, `نوع مدرک نامعتبر است — یکی از: ${Object.keys(KIND_FA).join('، ')}`);
    }
    if (!Array.isArray(b.lines) || !b.lines.length) throw new AppError(400, 'مدرک دست‌کم یک خط لازم دارد');
    const date = requireDate(b.date, 'تاریخ مدرک');

    const doc = await runOp(() => prisma.$transaction((tx: Prisma.TransactionClient) => createDocument(tx, {
      kind: b.kind as GlDocumentKind, date,
      dueDate: asDate(b.dueDate) ?? null,
      subsidiaryId: b.subsidiaryId || null,
      projectId: b.projectId || null,
      costCenterId: b.costCenterId || null,
      currencyCode: String(b.currencyCode || 'IRR'),
      rate: b.rate ? String(b.rate) : null,
      vatPercent: b.vatPercent != null ? Number(b.vatPercent) : null,
      description: b.description || null,
      notes: b.notes || null,
      lines: b.lines,
      createdById: req.user!.id,
    }), { timeout: 30_000 }));

    await audit(req, 'DOCUMENT_CREATE', `${KIND_FA[doc.kind as GlDocumentKind]} ${doc.number} ساخته شد`,
      { entity: 'GlDocument', entityId: doc.id, newValue: { number: doc.number, total: doc.total.toString() } });
    send(res, doc);
  });

  router.post('/documents/:id/transition', async (req: Request, res: Response) => {
    const to = req.body?.to as GlDocumentStatus;
    if (!to || !(to in STATUS_FA)) {
      throw new AppError(400, `وضعیت مقصد نامعتبر است — یکی از: ${Object.keys(STATUS_FA).join('، ')}`);
    }
    const before = await prisma.glDocument.findUnique({
      where: { id: req.params.id }, select: { status: true, number: true, kind: true },
    });
    if (!before) throw new AppError(404, 'مدرک یافت نشد');

    const doc = await runOp(() => prisma.$transaction((tx: Prisma.TransactionClient) => transitionDocument(tx, {
      documentId: req.params.id, to,
      byId: req.user!.id, byName: req.user!.name ?? req.user!.username ?? null,
      note: req.body?.note ? String(req.body.note) : null,
      postDate: asDate(req.body?.postDate),
    }), { timeout: 30_000 }));

    await audit(req, `DOCUMENT_${to}` as GlAuditAction,
      `${KIND_FA[before.kind as GlDocumentKind]} ${before.number}: ${STATUS_FA[before.status as GlDocumentStatus]} ← ${STATUS_FA[to]}`,
      {
        entity: 'GlDocument', entityId: doc.id,
        oldValue: { status: before.status }, newValue: { status: to },
        meta: { entryId: doc.entryId },
      });
    send(res, doc);
  });

  router.post('/documents/:id/return', async (req: Request, res: Response) => {
    const date = requireDate(req.body?.date ?? new Date().toISOString(), 'تاریخ برگشت');
    const doc = await runOp(() => prisma.$transaction((tx: Prisma.TransactionClient) => createReturn(tx, req.params.id, {
      date,
      lines: Array.isArray(req.body?.lines) && req.body.lines.length ? req.body.lines : undefined,
      description: req.body?.description || null,
      createdById: req.user!.id,
    }), { timeout: 30_000 }));
    await audit(req, 'DOCUMENT_RETURN', `${KIND_FA[doc.kind as GlDocumentKind]} ${doc.number} از روی مدرک اصلی ساخته شد`,
      { entity: 'GlDocument', entityId: doc.id, meta: { sourceDocumentId: req.params.id } });
    send(res, doc);
  });

  // ─────────────────────────────────────────────────────────────
  // پیوست — بند ۳۰
  // ─────────────────────────────────────────────────────────────

  router.post('/attachments', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) throw new AppError(400, 'فایلی فرستاده نشده است');
    const { documentId, entryId, label } = req.body ?? {};
    if (!documentId && !entryId) throw new AppError(400, 'پیوست باید به مدرک یا سند بچسبد');

    if (documentId && !(await prisma.glDocument.findUnique({ where: { id: String(documentId) }, select: { id: true } }))) {
      throw new AppError(404, 'مدرک یافت نشد');
    }
    if (entryId && !(await prisma.glEntry.findUnique({ where: { id: String(entryId) }, select: { id: true } }))) {
      throw new AppError(404, 'سند یافت نشد');
    }

    // ⚠️ اینجا تبدیل latin1 لازم **نیست** — میان‌افزار آپلود خودش نام را
    // تعمیر می‌کند (`fixFilename` در upload.ts). تبدیل دوباره، نام فارسیِ
    // درست را به کاراکترهای بی‌معنی برمی‌گرداند؛ در آزمون زنده دیده شد.
    const original = req.file.originalname;

    const att = await prisma.glAttachment.create({
      data: {
        documentId: documentId ? String(documentId) : null,
        entryId: entryId ? String(entryId) : null,
        url: `/uploads/${req.file.filename}`,
        fileName: original,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        label: label ? String(label) : null,
        uploadedById: req.user!.id,
        uploadedByName: req.user!.name ?? req.user!.username ?? null,
      },
    });
    await audit(req, 'ATTACHMENT_ADD', `پیوست «${att.fileName}» افزوده شد`,
      { entity: 'GlAttachment', entityId: att.id, newValue: { fileName: att.fileName, label: att.label } });
    send(res, att);
  });

  router.get('/attachments', async (req: Request, res: Response) => {
    const { documentId, entryId } = req.query as Record<string, string>;
    if (!documentId && !entryId) throw new AppError(400, 'شناسهٔ مدرک یا سند لازم است');
    send(res, await prisma.glAttachment.findMany({
      where: { ...(documentId ? { documentId } : {}), ...(entryId ? { entryId } : {}) },
      orderBy: { uploadedAt: 'desc' },
    }));
  });

  router.delete('/attachments/:id', async (req: Request, res: Response) => {
    const att = await prisma.glAttachment.findUnique({ where: { id: req.params.id } });
    if (!att) throw new AppError(404, 'پیوست یافت نشد');
    // پیوستِ مدرکِ ثبت‌شده خودش مدرکِ ممیزی است و برداشته نمی‌شود
    if (att.documentId) {
      const doc = await prisma.glDocument.findUnique({ where: { id: att.documentId }, select: { status: true } });
      if (doc?.status === 'POSTED') throw new AppError(400, 'پیوستِ مدرکِ ثبت‌شده حذف نمی‌شود');
    }
    await prisma.glAttachment.delete({ where: { id: att.id } });
    await audit(req, 'ATTACHMENT_REMOVE', `پیوست «${att.fileName}» حذف شد`,
      { entity: 'GlAttachment', entityId: att.id, oldValue: { fileName: att.fileName, url: att.url } });
    send(res, { ok: true });
  });

  // ─────────────────────────────────────────────────────────────
  // مانده افتتاحیه — بند ۱۸
  // ─────────────────────────────────────────────────────────────

  router.post('/opening-balance', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.lines) || b.lines.length < 2) {
      throw new AppError(400, 'مانده افتتاحیه دست‌کم دو ردیف لازم دارد');
    }
    const date = requireDate(b.date, 'تاریخ افتتاحیه');
    const fy = b.fiscalYearId ? { id: String(b.fiscalYearId) } : await activeFiscalYear(date);

    const entry = await runOp(() => prisma.$transaction((tx: Prisma.TransactionClient) => postOpeningBalance(tx, {
      fiscalYearId: fy.id, date,
      description: b.description || null,
      lines: b.lines,
      createdById: req.user!.id,
    }), { timeout: 60_000 }));

    await audit(req, 'OPENING_BALANCE', `مانده افتتاحیه ثبت شد — سند ${entry.serial}`,
      { entryId: entry.id, entrySerial: entry.serial, meta: { lineCount: entry.lines.length } });
    send(res, entry);
  });
}
