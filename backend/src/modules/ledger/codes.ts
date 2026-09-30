/**
 * اعتبارسنجی کد حساب بر پایهٔ سطوح **قابل تنظیم**.
 *
 * الزام بند ۳-۱: «تعداد سطوح و طول کد هر سطح هاردکد نشود.»
 * پس هیچ عدد سطحی اینجا ثابت نیست — همه از جدول `GlCodeLevel` خوانده می‌شود.
 */
import { Prisma } from '@prisma/client';

export interface CodeLevel {
  level: number;
  name: string;
  digits: number;
}

/** طول کل کد تا پایان هر سطح — مثلاً [1, 2, 4, 6] */
export function cumulativeLengths(levels: CodeLevel[]): number[] {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  const out: number[] = [];
  let total = 0;
  for (const l of sorted) {
    total += l.digits;
    out.push(total);
  }
  return out;
}

/** سطح یک کد از روی طولش — اگر با هیچ سطحی نخواند، `null` */
export function levelOfCode(code: string, levels: CodeLevel[]): number | null {
  const idx = cumulativeLengths(levels).indexOf(code.length);
  return idx === -1 ? null : idx + 1;
}

/** کد والدِ یک کد — برای سطح ۱، `null` */
export function parentCodeOf(code: string, levels: CodeLevel[]): string | null {
  const lens = cumulativeLengths(levels);
  const idx = lens.indexOf(code.length);
  if (idx <= 0) return null;
  return code.slice(0, lens[idx - 1]);
}

export class CodeError extends Error {}

/**
 * یک کد پیشنهادی را می‌سنجد. خطاها صریح‌اند تا کاربر بداند دقیقاً چه چیزی غلط است.
 */
export function validateCode(code: string, levels: CodeLevel[]): { level: number; parentCode: string | null } {
  if (!/^\d+$/.test(code)) throw new CodeError(`کد حساب فقط رقم می‌پذیرد: «${code}»`);

  const level = levelOfCode(code, levels);
  if (level === null) {
    const allowed = cumulativeLengths(levels).join('، ');
    throw new CodeError(`طول کد «${code}» (${code.length} رقم) با هیچ سطحی نمی‌خواند. طول‌های مجاز: ${allowed}`);
  }
  return { level, parentCode: parentCodeOf(code, levels) };
}

export async function loadLevels(tx: Prisma.TransactionClient): Promise<CodeLevel[]> {
  const rows = await tx.glCodeLevel.findMany({ orderBy: { level: 'asc' } });
  if (!rows.length) throw new CodeError('سطوح کدینگ تعریف نشده‌اند (جدول GlCodeLevel خالی است)');
  return rows;
}

/**
 * ساخت حساب جدید با اعتبارسنجی کامل: طول کد، وجود والد، و اینکه والد
 * دیگر برگ نیست (چون سند فقط روی برگ می‌نشیند).
 */
export async function createAccount(
  tx: Prisma.TransactionClient,
  input: {
    code: string;
    name: string;
    currencyMode?: 'SINGLE' | 'MULTI';
    currencyCode?: string | null;
    requiresSubsidiary?: boolean;
    subsidiaryKinds?: any[];
    requiresCostCenter?: boolean;
    sortIndex?: number;
  },
) {
  const levels = await loadLevels(tx);
  const { level, parentCode } = validateCode(input.code, levels);

  if (!parentCode) throw new CodeError('ساخت سرفصل ریشهٔ جدید از این مسیر مجاز نیست');

  const parent = await tx.glAccount.findUnique({ where: { code: parentCode } });
  if (!parent) throw new CodeError(`حساب والد با کد «${parentCode}» وجود ندارد`);

  // والد از این پس گره تجمیعی است، نه برگ
  if (parent.isPostable) {
    const hasLines = await tx.glLine.count({ where: { accountId: parent.id } });
    if (hasLines > 0) {
      throw new CodeError(
        `حساب «${parent.code} ${parent.name}» گردش دارد و نمی‌تواند به سرگروه تبدیل شود. ` +
        'ابتدا گردشش را به یک حساب برگ منتقل کنید.',
      );
    }
    await tx.glAccount.update({ where: { id: parent.id }, data: { isPostable: false } });
  }

  return tx.glAccount.create({
    data: {
      code: input.code,
      name: input.name,
      level,
      parentId: parent.id,
      rootType: parent.rootType,
      normalSide: parent.normalSide,
      statement: parent.statement,
      isPostable: true,
      currencyMode: (input.currencyMode as any) ?? 'MULTI',
      currencyCode: input.currencyCode ?? null,
      requiresSubsidiary: input.requiresSubsidiary ?? parent.requiresSubsidiary,
      subsidiaryKinds: (input.subsidiaryKinds as any) ?? parent.subsidiaryKinds,
      requiresCostCenter: input.requiresCostCenter ?? parent.requiresCostCenter,
      sortIndex: input.sortIndex ?? parent.sortIndex,
      isSystem: false,
    },
  });
}
