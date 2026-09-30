/**
 * فاز ۶ نقشهٔ پاریتی — کلید «هستهٔ جدید = مرجع» (`LEDGER_PRIMARY=new`).
 *
 * برخلاف سایهٔ 'dual' (تراکنش جدا، خطا بلعیده)، `pw*` **داخل تراکنشِ صداکننده**
 * اجرا می‌شود و خطایش کار کسب‌وکار را برمی‌گرداند. این تست سه چیز را می‌سنجد:
 *   • حالت از دو فلگ درست مشتق می‌شود
 *   • در حالت 'new' سند به هستهٔ جدید می‌رود؛ در 'legacy'/'dual' هیچ (pw بی‌اثر)
 *   • خطای `pw*` از تراکنش بیرون می‌زند و همه‌چیز برمی‌گردد
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { db, resetLedger } from '../helpers/fixtures';
import { post } from '../../src/modules/ledger/poster';
import { createAccount } from '../../src/modules/ledger/codes';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import {
  ledgerMode, writeLegacy, dualWriteEnabled,
  pwSettlement, pwEnsureSubsidiary, pwInvoice,
} from '../../src/modules/ledger/dual-write';

let fy: { id: string };
let ar: any, sales: any, cashLeaf: any;
let customer: any, custSub: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

beforeAll(async () => {
  await resetGl(); await resetLedger();
  await seedGlChart();
  ar = await accountByCode('1104');
  sales = await accountByCode('4101');
  // برگِ نقدیِ شرکت با نامی مشخص — pwSettlement با همین نام پیدایش می‌کند.
  // چارت از resetGl جان سالم به‌در می‌برد، پس یک‌بار اینجا ساخته می‌شود.
  await gl.glAccount.deleteMany({ where: { code: '110109' } });
  cashLeaf = await tx((t) => createAccount(t, { code: '110109', name: 'صندوق تست مرجع' }));
}, 180_000);

afterAll(async () => {
  await gl.glAccount.deleteMany({ where: { code: '110109' } });
  await gl.$disconnect(); await db.$disconnect();
});

beforeEach(async () => {
  delete process.env.LEDGER_PRIMARY;
  delete process.env.LEDGER_DUAL_WRITE;
  await resetGl(); await resetBusinessData();
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();

  // نرخ روز برای سمتِ نقدِ تسویه (postSettlement از GlExchangeRate می‌خواند)
  await gl.glExchangeRate.deleteMany({});
  await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', rate: '900000', date: DEFAULT_DATE, source: 'MANUAL' } });

  const c = await db.customer.create({ data: { name: 'مشتری مرجع', shortCode: 'PW1' } });
  customer = c;
  custSub = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));

  // طلب باز ۱۰۰ دلاری از مشتری (نرخ ۹۰۰٬۰۰۰)
  await tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
    lines: [
      { accountId: ar.id, subsidiaryId: custSub.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ],
  }));
});

/** ماندهٔ یک حساب به ارز اصلی، از دفتر */
async function balOf(code: string, currency: string): Promise<bigint> {
  const a = await accountByCode(code);
  const rows = await gl.$queryRaw<{ b: bigint | null }[]>`
    SELECT (SUM(l.debit) - SUM(l.credit))::bigint AS b
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${a.id} AND l."currencyCode" = ${currency} AND e.status <> 'DRAFT'
  `;
  return BigInt(rows[0]?.b ?? 0n);
}

// ═══════════════════════════════════════════════════════════════
describe('مشتقِ حالت از فلگ‌ها', () => {
  it('هیچ فلگ ⇒ legacy', () => {
    expect(ledgerMode()).toBe('legacy');
    expect(writeLegacy()).toBe(true);
    expect(dualWriteEnabled()).toBe(false);
  });
  it('DUAL_WRITE=true ⇒ dual', () => {
    process.env.LEDGER_DUAL_WRITE = 'true';
    expect(ledgerMode()).toBe('dual');
    expect(writeLegacy()).toBe(true);
    expect(dualWriteEnabled()).toBe(true);
  });
  it('PRIMARY=new ⇒ new — قدیمی نوشته نمی‌شود، سایه هم خاموش', () => {
    process.env.LEDGER_PRIMARY = 'new';
    process.env.LEDGER_DUAL_WRITE = 'true';   // حتی اگر روشن باشد
    expect(ledgerMode()).toBe('new');
    expect(writeLegacy()).toBe(false);
    expect(dualWriteEnabled()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('pwSettlement — تسویهٔ مرجع', () => {
  const settle = () => tx((t) => pwSettlement(t, {
    direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: customer.id,
    currency: 'USD', amount: '100', companyAccountName: 'صندوق تست مرجع',
    date: DEFAULT_DATE, userId: 'u1',
  }));

  it('در حالت new طلب بسته و نقد بدهکار می‌شود', async () => {
    process.env.LEDGER_PRIMARY = 'new';
    await settle();
    expect(await balOf('1104', 'USD')).toBe(0n);          // طلب صفر شد
    expect(await balOf('110109', 'USD')).toBe(10_000n);   // ۱۰۰ دلار به صندوق
  });

  it('در حالت legacy هیچ کاری نمی‌کند (pw بی‌اثر)', async () => {
    await settle();
    expect(await balOf('1104', 'USD')).toBe(10_000n);     // دست‌نخورده
    expect(await balOf('110109', 'USD')).toBe(0n);
  });

  it('در حالت dual هم بی‌اثر است (سایه جدا کار می‌کند)', async () => {
    process.env.LEDGER_DUAL_WRITE = 'true';
    await settle();
    expect(await balOf('1104', 'USD')).toBe(10_000n);
  });

  it('نامِ حساب نقدیِ نادرست ⇒ خطا از تراکنش بیرون می‌زند', async () => {
    process.env.LEDGER_PRIMARY = 'new';
    await expectRejects(
      () => tx((t) => pwSettlement(t, {
        direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: customer.id,
        currency: 'USD', amount: '100', companyAccountName: 'حسابِ ناموجود',
        date: DEFAULT_DATE, userId: 'u1',
      })),
      /پیدا نشد/,
    );
    // چیزی ثبت نشده — تراکنش کامل برگشت
    expect(await balOf('1104', 'USD')).toBe(10_000n);
  });

  it('خطای pwSettlement کلِ تراکنشِ کسب‌وکار را برمی‌گرداند', async () => {
    process.env.LEDGER_PRIMARY = 'new';
    await expectRejects(
      () => tx(async (t) => {
        // یک نوشتنِ کسب‌وکاریِ نمونه پیش از تسویه
        await t.customer.update({ where: { id: customer.id }, data: { name: 'نامِ جدید' } });
        await pwSettlement(t, {
          direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: customer.id,
          currency: 'USD', amount: '100', companyAccountName: 'حسابِ ناموجود',
          date: DEFAULT_DATE, userId: 'u1',
        });
      }),
      /پیدا نشد/,
    );
    const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.name).toBe('مشتری مرجع');   // آپدیت هم برگشت
  });
});

// ═══════════════════════════════════════════════════════════════
describe('pwEnsureSubsidiary و گاردِ آمادگی', () => {
  it('ساخت تفصیلی به سال مالی بند نیست', async () => {
    process.env.LEDGER_PRIMARY = 'new';
    await resetGl();   // پاک‌سازی کامل: سند، سال مالی، تفصیلی (چارت می‌ماند)
    const s = await db.supplier.create({ data: { name: 'تأمین مرجع' } });
    await tx((t) => pwEnsureSubsidiary(t, 'SUPPLIER', s.id, s.name));
    const sub = await gl.glSubsidiary.findFirst({ where: { refId: s.id } });
    expect(sub?.kind).toBe('SUPPLIER');
  });

  it('pwInvoice بدونِ سال مالی در حالت new ⇒ خطای روشن', async () => {
    process.env.LEDGER_PRIMARY = 'new';
    await resetGl();   // چارت هست، سال مالی نیست ⇒ گارد باید بگیرد
    await expectRejects(
      () => tx((t) => pwInvoice(t, 'any-invoice-id', 'u1')),
      /چارت یا سال مالی ندارد/,
    );
  });
});
