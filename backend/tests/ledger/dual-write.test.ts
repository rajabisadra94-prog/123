/**
 * فاز ۳ نقشهٔ پاریتی — دونویسی و هارنس مقایسه.
 *
 * `dw*` نازک‌اند (فلگ + تراکنش + try/catch + آداپتورِ از قبل تست‌شده)، پس اینجا
 * فقط **گِیتِ فلگ** و **بلعیدن خطا** سنجیده می‌شود. تمرکز اصلی روی `compareCores`
 * است که منطق تازه دارد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { dwEnsureSubsidiary, dualWriteEnabled } from '../../src/modules/ledger/dual-write';
import { compareCores } from '../../src/modules/ledger/diff';
import {
  db, resetLedger, seedChart as seedOldChart,
} from '../helpers/fixtures';
import { getOrCreateControl, getOrCreateWallet, postJournal } from '../../src/modules/accounting/accounting.service';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({ USD_TO_IRR: 90_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 6.4, source: 'test', fetchedAt: new Date(), isStale: false }),
}));

let fy: { id: string }
let ar: any, sales: any

beforeAll(async () => {
  await resetGl(); await resetLedger()
  await seedGlChart(); await seedOldChart()
  ar = await accountByCode('1104')
  sales = await accountByCode('4101')
}, 180_000)

afterAll(async () => { await gl.$disconnect(); await db.$disconnect() })

beforeEach(async () => {
  delete process.env.LEDGER_DUAL_WRITE
  await resetGl(); await resetBusinessData()
  await db.journalLine.deleteMany({}); await db.journalEntry.deleteMany({})
  await db.financialAccount.deleteMany({ where: { type: { in: ['WALLET', 'CASH'] } } })
  await gl.customer.deleteMany({}); await gl.producer.deleteMany({})
  fy = await makeFiscalYear()
})

// ═══════════════════════════════════════════════════════════════
describe('گِیت فلگ', () => {
  it('فلگ خاموش ⇒ هیچ تفصیلی ساخته نمی‌شود', async () => {
    const c = await gl.customer.create({ data: { name: 'الف', shortCode: 'DW1' } })
    await dwEnsureSubsidiary('CUSTOMER', c.id, c.name)
    expect(await gl.glSubsidiary.count()).toBe(0)
  })

  it('فلگ روشن ⇒ تفصیلی ساخته می‌شود', async () => {
    process.env.LEDGER_DUAL_WRITE = 'true'
    const c = await gl.customer.create({ data: { name: 'ب', shortCode: 'DW2' } })
    await dwEnsureSubsidiary('CUSTOMER', c.id, c.name)
    const subs = await gl.glSubsidiary.findMany()
    expect(subs).toHaveLength(1)
    expect(subs[0].name).toBe('ب')
    expect(subs[0].kind).toBe('CUSTOMER')
  })

  it('نوع طرف‌حساب نامعتبر ⇒ خطا بلعیده می‌شود، چیزی نمی‌شکند', async () => {
    process.env.LEDGER_DUAL_WRITE = 'true'
    await expect(dwEnsureSubsidiary('COMPANY', 'x', 'y')).resolves.toBeUndefined()
    expect(await gl.glSubsidiary.count()).toBe(0)
  })

  it('dualWriteEnabled فلگ را زنده می‌خواند', () => {
    delete process.env.LEDGER_DUAL_WRITE
    expect(dualWriteEnabled()).toBe(false)
    process.env.LEDGER_DUAL_WRITE = 'true'
    expect(dualWriteEnabled()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
describe('هارنس مقایسه', () => {
  let custId: string

  beforeEach(async () => {
    const c = await db.customer.create({ data: { name: 'مشتری الف', shortCode: 'CMP' } })
    custId = c.id
  })

  /** فروش ریالی در هستهٔ قدیمی */
  async function oldSale(amountToman: number) {
    return db.$transaction(async (tx) => {
      const wallet = await getOrCreateWallet(tx, 'CUSTOMER', custId, 'IRR', 'مشتری الف')
      const salesCtrl = await getOrCreateControl(tx, 'SALES', 'IRR')
      await postJournal(tx, {
        description: 'فروش', eventType: 'MANUAL', date: DEFAULT_DATE,
        lines: [
          { accountId: wallet.id, debit: amountToman, currency: 'IRR', rateToIRR: 1 },
          { accountId: salesCtrl.id, credit: amountToman, currency: 'IRR', rateToIRR: 1 },
        ],
      })
    })
  }
  /** همان فروش در هستهٔ جدید (ریال = تومان×۱۰) */
  async function newSale(amountRial: bigint, subId: string) {
    return gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش',
      lines: [
        { accountId: ar.id, subsidiaryId: subId, currencyCode: 'IRR', debit: amountRial },
        { accountId: sales.id, currencyCode: 'IRR', credit: amountRial },
      ],
    }))
  }

  it('دو هستهٔ هم‌سنگ ⇒ اختلاف صفر روی مفاهیم مشترک', async () => {
    process.env.LEDGER_DUAL_WRITE = 'true'
    await dwEnsureSubsidiary('CUSTOMER', custId, 'مشتری الف')
    const sub = await gl.glSubsidiary.findFirstOrThrow()

    await oldSale(1_000_000)        // ۱ م تومان
    await newSale(10_000_000n, sub.id)   // ۱۰ م ریال

    const d = await compareCores()
    const arRow = d.rows.find((r) => r.concept === '1104' && r.currency === 'IRR')!
    const salesRow = d.rows.find((r) => r.concept === '4101' && r.currency === 'IRR')!
    expect(arRow.legacyBase).toBe('10000000')
    expect(arRow.glBase).toBe('10000000')
    expect(arRow.baseDelta).toBe('0')
    expect(arRow.ok).toBe(true)
    expect(salesRow.ok).toBe(true)
  })

  it('مبلغ ارزی: قدیمی به واحد بزرگ، جدید به کوچک‌ترین واحد ⇒ پس از مقیاس، هم‌سنگ', async () => {
    process.env.LEDGER_DUAL_WRITE = 'true'
    await dwEnsureSubsidiary('CUSTOMER', custId, 'مشتری الف')
    const sub = await gl.glSubsidiary.findFirstOrThrow()

    // هستهٔ قدیمی: ۱۰۰ دلار (واحد بزرگ)، نرخ ۹۰٬۰۰۰ تومان
    await db.$transaction(async (tx) => {
      const wallet = await getOrCreateWallet(tx, 'CUSTOMER', custId, 'USD', 'مشتری الف')
      const salesCtrl = await getOrCreateControl(tx, 'SALES', 'USD')
      await postJournal(tx, {
        description: 'فروش دلاری', eventType: 'MANUAL', date: DEFAULT_DATE,
        lines: [
          { accountId: wallet.id, debit: 100, currency: 'USD', rateToIRR: 90_000 },
          { accountId: salesCtrl.id, credit: 100, currency: 'USD', rateToIRR: 90_000 },
        ],
      })
    })
    // هستهٔ جدید: ۱۰۰۰۰ سنت (کوچک‌ترین واحد)، نرخ ریالیِ ۹۰۰٬۰۰۰
    await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
      lines: [
        { accountId: ar.id, subsidiaryId: sub.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
        { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
      ],
    }))

    const d = await compareCores()
    const arRow = d.rows.find((r) => r.concept === '1104' && r.currency === 'USD')!
    expect(arRow.legacyForeign).toBe('10000')   // ۱۰۰ دلار × ۱۰۰ = ۱۰۰۰۰ سنت
    expect(arRow.glForeign).toBe('10000')
    expect(arRow.foreignDelta).toBe('0')
    expect(arRow.baseDelta).toBe('0')
    expect(arRow.ok).toBe(true)
  })

  it('رویدادی که فقط در قدیمی هست ⇒ ناهماهنگی', async () => {
    await oldSale(2_000_000)   // فقط قدیمی
    const d = await compareCores()
    const arRow = d.rows.find((r) => r.concept === '1104' && r.currency === 'IRR')!
    expect(arRow.legacyBase).toBe('20000000')
    expect(arRow.glBase).toBe('0')
    expect(arRow.ok).toBe(false)
    expect(d.mismatchCount).toBeGreaterThan(0)
    expect(BigInt(d.legacyOnlyBase)).toBeGreaterThan(0n)
  })

  it('سند باطل‌شدهٔ قدیمی در مقایسه نمی‌آید', async () => {
    await oldSale(3_000_000)
    const entry = await db.journalEntry.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    await db.journalEntry.update({ where: { id: entry.id }, data: { status: 'REVERSED' } })
    const d = await compareCores()
    const arRow = d.rows.find((r) => r.concept === '1104' && r.currency === 'IRR')
    expect(arRow?.legacyBase ?? '0').toBe('0')
  })

  it('سند باطل‌شده + سند برگشتی‌اش هر دو کنار می‌روند، نه فقط REVERSED', async () => {
    // یک فروش، بعد باطل با یک سندِ برگشتیِ قرینه — مثل کاری که در staging رخ داد.
    await oldSale(5_000_000)
    const orig = await db.journalEntry.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    await db.journalEntry.update({ where: { id: orig.id }, data: { status: 'REVERSED' } })
    // سندِ برگشتیِ قرینه با وضعیت REVERSAL
    const wallet = await db.financialAccount.findFirstOrThrow({ where: { ownerId: custId, currency: 'IRR' } })
    const salesCtrl = await db.financialAccount.findFirstOrThrow({ where: { controlKind: 'SALES', currency: 'IRR' } })
    await db.journalEntry.create({
      data: {
        description: 'ابطال فروش', eventType: 'MANUAL', date: DEFAULT_DATE, status: 'REVERSAL',
        lines: { create: [
          { accountId: wallet.id, credit: 5_000_000, currency: 'IRR', rateToIRR: 1 },
          { accountId: salesCtrl.id, debit: 5_000_000, currency: 'IRR', rateToIRR: 1 },
        ] },
      },
    })
    const d = await compareCores()
    // نسخهٔ قبلی فقط REVERSED را کنار می‌گذاشت ⇒ سندِ برگشتی تنها می‌ماند و
    // یک ماندهٔ شبحِ ۵ م تومان می‌ساخت. حالا هر دو کنار می‌روند ⇒ صفر.
    const arRow = d.rows.find((r) => r.concept === '1104' && r.currency === 'IRR')
    expect(arRow?.legacyBase ?? '0').toBe('0')
    const salesRow = d.rows.find((r) => r.concept === '4101' && r.currency === 'IRR')
    expect(salesRow?.legacyBase ?? '0').toBe('0')
  })
})
