/**
 * فاز ۲ نقشهٔ پاریتی — نمای کلیِ مالی (داشبورد).
 *
 * `overview()` سه دستهٔ نقد/طلب/بدهی را از دفتر جمع می‌زند و هشدارها را می‌سازد.
 * معادل ریالی از ستون `*Base` می‌آید، نه ضرب در نرخ — پس بازتولیدپذیر است.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, resetBusinessData,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { post, reverse } from '../../src/modules/ledger/poster';
import { overview } from '../../src/modules/ledger/reports/overview';

let fy: { id: string }
let ar: any, payable: any, sales: any, cash: any, cogs: any, equity: any
let customer: any, producer: any

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 })

beforeAll(async () => {
  await resetGl()
  await seedGlChart()
  ar = await accountByCode('1104')
  payable = await accountByCode('2101')
  sales = await accountByCode('4101')
  cash = await accountByCode('110101')
  cogs = await accountByCode('5101')
  equity = await accountByCode('3101')
}, 180_000)

afterAll(async () => { await gl.$disconnect() })

beforeEach(async () => {
  await resetGl()
  await resetBusinessData()
  await gl.glExchangeRate.deleteMany({})
  await gl.customer.deleteMany({})
  await gl.producer.deleteMany({})
  fy = await makeFiscalYear()
  const c = await gl.customer.create({ data: { name: 'مشتری الف', shortCode: 'OV1' } })
  const p = await gl.producer.create({ data: { name: 'سازندهٔ ب' } })
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name))
  producer = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name))
})

/** شارژ نقد ریالی */
const chargeCash = (rial: bigint) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'سرمایهٔ نقدی',
    lines: [
      { accountId: cash.id, currencyCode: 'IRR', debit: rial },
      { accountId: equity.id, currencyCode: 'IRR', credit: rial },
    ],
  }))

describe('نمای کلی', () => {
  it('نقد ریالی در دستهٔ cash و معادل پایه‌اش درست است', async () => {
    await chargeCash(500_000_000n)
    const o = await overview(gl)
    expect(o.cash.byCurrency.IRR.base).toBe('500000000')
    expect(o.cash.totalBase).toBe('500000000')
    expect(o.netBase).toBe('500000000')
  })

  it('طلب ارزی مشتری در receivable با علامت مثبت', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
      lines: [
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
        { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
      ],
    }))
    const o = await overview(gl)
    expect(o.receivable.byCurrency.USD.amount).toBe('10000')       // ۱۰۰ دلار
    expect(o.receivable.byCurrency.USD.base).toBe('90000000')      // ۱۰۰ × ۹۰۰٬۰۰۰ ریال
    expect(o.receivable.totalBase).toBe('90000000')
  })

  it('بدهی به سازنده در payable با علامت مثبت (نه منفیِ خام)', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید',
      lines: [
        { accountId: cogs.id, currencyCode: 'IRR', debit: 200_000_000n },
        { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'IRR', credit: 200_000_000n },
      ],
    }))
    const o = await overview(gl)
    expect(o.payable.byCurrency.IRR.base).toBe('200000000')        // مثبت
    expect(o.payable.totalBase).toBe('200000000')
  })

  it('net = نقد + طلب − بدهی', async () => {
    await chargeCash(500_000_000n)
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش ریالی',
      lines: [
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 300_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 300_000_000n },
      ],
    }))
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید ریالی',
      lines: [
        { accountId: cogs.id, currencyCode: 'IRR', debit: 100_000_000n },
        { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'IRR', credit: 100_000_000n },
      ],
    }))
    const o = await overview(gl)
    expect(o.netBase).toBe('700000000')   // ۵۰۰ + ۳۰۰ − ۱۰۰
  })

  it('حساب نقدیِ منفی هشدار می‌دهد', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'اضافه‌برداشت',
      lines: [
        { accountId: cogs.id, currencyCode: 'IRR', debit: 50_000_000n },
        { accountId: cash.id, currencyCode: 'IRR', credit: 50_000_000n },
      ],
    }))
    const o = await overview(gl)
    expect(o.alerts.negativeCashAccounts).toHaveLength(1)
    expect(o.alerts.negativeCashAccounts[0].code).toBe('110101')
  })

  it('مشتری با پیش‌پرداخت در «از ما طلبکار» می‌آید', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'پیش‌دریافت',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 40_000_000n },
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', credit: 40_000_000n },
      ],
    }))
    const o = await overview(gl)
    expect(o.alerts.partiesWeOwe).toHaveLength(1)
    expect(o.alerts.partiesWeOwe[0].amount).toBe('40000000')
  })

  it('نرخ کهنه پرچم می‌خورد؛ نرخ امروز نه', async () => {
    let o = await overview(gl)
    expect(o.alerts.ratesStale).toBe(true)          // هیچ نرخی نیست
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', rate: '900000', date: new Date(), source: 'MANUAL' } })
    o = await overview(gl)
    expect(o.alerts.ratesStale).toBe(false)
  })

  it('ممیزی ب۱۳: نرخِ تاریخ‌آینده هشدار کهنگی را خاموش نمی‌کند و پرچمِ جدا می‌زند', async () => {
    // فقط یک نرخ، با تاریخِ ۱۰ روز بعد — نباید نرخِ مؤثرِ امروز حساب شود
    const future = new Date(Date.now() + 10 * 86_400_000)
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', rate: '900000', date: future, source: 'MANUAL' } })
    const o = await overview(gl)
    expect(o.alerts.ratesStale).toBe(true)          // نرخِ مؤثری نیست
    expect(o.alerts.rateAgeDays).toBe(null)         // منفی نمی‌شود
    expect(o.alerts.hasFutureRate).toBe(true)       // پرچمِ نرخِ آینده
  })

  it('ممیزی ب۱۳: با نرخِ امروز، نرخِ آیندهٔ اضافه سنِ نرخ را منفی نمی‌کند', async () => {
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', rate: '900000', date: new Date(), source: 'MANUAL' } })
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', rate: '950000', date: new Date(Date.now() + 5 * 86_400_000), source: 'MANUAL' } })
    const o = await overview(gl)
    expect(o.alerts.ratesStale).toBe(false)
    expect(o.alerts.rateAgeDays).toBe(0)
    expect(o.alerts.hasFutureRate).toBe(true)
  })

  it('آخرین اسناد به ترتیب نزولی برمی‌گردند', async () => {
    await chargeCash(1_000_000n)
    await chargeCash(2_000_000n)
    const o = await overview(gl)
    expect(o.recentEntries.length).toBe(2)
    expect(o.recentEntries[0].serial).toBeGreaterThan(o.recentEntries[1].serial)
  })

  /**
   * افتتاحیه و اختتامیه با تاریخِ ابتدا/انتهای سال ثبت می‌شوند و همیشه بالای
   * مرتب‌سازی می‌نشینند. اگر فیلتر نشوند، «آخرین اسناد» روی هر دفترِ بسته‌شده
   * فقط سندهای سیستمی نشان می‌دهد و کارِ واقعیِ کاربر دیده نمی‌شود.
   */
  it('افتتاحیه و اختتامیه در آخرین اسناد نمی‌آیند', async () => {
    await chargeCash(1_000_000n)
    for (const entryType of ['OPENING', 'CLOSING'] as const) {
      await tx((t) => post(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, description: `سند ${entryType}`,
        entryType,
        lines: [
          { accountId: cash.id, currencyCode: 'IRR', debit: 7_000_000n },
          { accountId: equity.id, currencyCode: 'IRR', credit: 7_000_000n },
        ],
      }))
    }
    const o = await overview(gl)
    expect(o.recentEntries.length).toBe(1)
    expect(o.recentEntries[0].description).toBe('سرمایهٔ نقدی')
  })

  /**
   * برگشتِ یک سند سیستمی هم سیستمی است (بستنِ دوباره)، ولی برگشتِ یک سند
   * عادی کارِ کاربر است و باید دیده شود — وگرنه «سندی که باطل کردم کجاست؟»
   */
  it('برگشتِ اختتامیه پنهان می‌ماند ولی برگشتِ سند عادی دیده می‌شود', async () => {
    const normal = await chargeCash(1_000_000n)
    const closing = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'سند اختتامیه',
      entryType: 'CLOSING',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 7_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 7_000_000n },
      ],
    }))
    await tx((t) => reverse(t, closing.id, { reason: 'بازکردن دوبارهٔ سال' }))
    await tx((t) => reverse(t, normal.id, { reason: 'اشتباه بود' }))

    const o = await overview(gl)
    const descs = o.recentEntries.map((e: any) => e.description)
    expect(descs.some((d: string) => d.includes('اختتامیه'))).toBe(false)
    expect(descs.some((d: string) => d.includes('سرمایهٔ نقدی'))).toBe(true)
    // سندِ عادی + برگشتش
    expect(o.recentEntries.length).toBe(2)
  })
})
