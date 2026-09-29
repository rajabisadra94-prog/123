/**
 * فاز ۴ نقشهٔ پاریتی — نگهداری چارت و قفل دوره.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, D, expectRejects, resetBusinessData,
} from '../helpers/gl';
import { createAccount } from '../../src/modules/ledger/codes';
import { post } from '../../src/modules/ledger/poster';
import { updateAccount, cleanupMigrationNames, setPeriodLock, removePeriodLock } from '../../src/modules/ledger/admin';

let fy: { id: string }
let testAcc: { id: string }   // برگِ تازه زیر ۱۱۰۱ — مطمئن که سیستمی نیست
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 })

beforeAll(async () => { await resetGl(); await seedGlChart() }, 180_000)
afterAll(async () => {
  await resetGl()
  await gl.glAccount.deleteMany({ where: { isSystem: false } })
  await gl.$disconnect()
})

beforeEach(async () => {
  await resetGl()
  await gl.glAccount.deleteMany({ where: { isSystem: false } })
  await gl.glPeriodLock.deleteMany({})
  await resetBusinessData()
  fy = await makeFiscalYear()
  testAcc = await tx((t) => createAccount(t, {
    code: '110108', name: 'بانک تست', currencyMode: 'MULTI',
  }))
})

// ═══════════════════════════════════════════════════════════════
describe('ویرایش حساب', () => {
  /**
   * حسابِ ماندهدار غیرفعال نمی‌شود.
   *
   * تریگرِ دفتر هر سندی به حسابِ غیرفعال را رد می‌کند، پس ماندهٔ باقی‌مانده
   * دیگر قابل صفر کردن نیست ولی همچنان در ترازنامه نشان داده می‌شود —
   * عددی که نه می‌شود اصلاحش کرد نه پنهانش. ماندهٔ صفر مجاز است.
   */
  it('حسابِ ماندهدار غیرفعال نمی‌شود ولی حسابِ صفرشده می‌شود', async () => {
    const equity = await accountByCode('3101')
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'شارژ',
      lines: [
        { accountId: testAcc.id, currencyCode: 'IRR', debit: 5_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 5_000n },
      ],
    }))
    await expectRejects(
      () => tx((t) => updateAccount(t, testAcc.id, { isActive: false })),
      /مانده دارد/,
    )

    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تخلیه',
      lines: [
        { accountId: equity.id, currencyCode: 'IRR', debit: 5_000n },
        { accountId: testAcc.id, currencyCode: 'IRR', credit: 5_000n },
      ],
    }))
    const off = await tx((t) => updateAccount(t, testAcc.id, { isActive: false }))
    expect(off.isActive).toBe(false)
  })

  it('نام و ترتیب و فعال‌بودن قابل ویرایش‌اند', async () => {
    const up = await tx((t) => updateAccount(t, testAcc.id, { name: 'بانک مرکزی', sortIndex: 5, isActive: false }))
    expect(up.name).toBe('بانک مرکزی')
    expect(up.sortIndex).toBe(5)
    expect(up.isActive).toBe(false)
  })

  it('کد و ماهیت از این مسیر تغییر نمی‌کنند', async () => {
    const up = await tx((t) => updateAccount(t, testAcc.id, { code: '999999', normalSide: 'CREDIT', name: 'x' } as any))
    expect(up.code).toBe('110108')
    expect(up.normalSide).toBe('DEBIT')
  })

  it('نام خالی رد می‌شود', async () => {
    await expectRejects(() => tx((t) => updateAccount(t, testAcc.id, { name: '   ' })), /خالی/)
  })

  it('حسابِ چندارزیِ دارای گردش، تک‌ارزی نمی‌شود', async () => {
    const equity = await accountByCode('3101')
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'دو ارز',
      lines: [
        { accountId: testAcc.id, currencyCode: 'USD', debit: 100n, rate: '900000' },
        { accountId: equity.id, currencyCode: 'USD', credit: 100n, rate: '900000' },
      ],
    }))
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'ریالی',
      lines: [
        { accountId: testAcc.id, currencyCode: 'IRR', debit: 1_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000_000n },
      ],
    }))
    await expectRejects(
      () => tx((t) => updateAccount(t, testAcc.id, { currencyMode: 'SINGLE', currencyCode: 'IRR' })),
      /چندارزی/,
    )
  })
})

// ═══════════════════════════════════════════════════════════════
describe('تمیزکاری نام‌های مهاجرت', () => {
  it('پسوند ارز از برگِ نقدی برداشته می‌شود', async () => {
    await tx((t) => createAccount(t, { code: '110109', name: 'صندوق دریافت‌های اولیه - IRR', currencyMode: 'SINGLE', currencyCode: 'IRR' }))
    const r = await tx((t) => cleanupMigrationNames(t))
    expect(r.cleaned).toHaveLength(1)
    expect(r.cleaned[0].to).toBe('صندوق دریافت‌های اولیه')
    const after = await accountByCode('110109')
    expect(after.name).toBe('صندوق دریافت‌های اولیه')
  })

  it('نام‌های سالم دست‌نخورده می‌مانند', async () => {
    const before = await accountByCode('110101')
    const r = await tx((t) => cleanupMigrationNames(t))
    expect(r.cleaned.find((c) => c.code === '110101')).toBeUndefined()
    expect((await accountByCode('110101')).name).toBe(before.name)
  })
})

// ═══════════════════════════════════════════════════════════════
describe('قفل دوره', () => {
  it('سند داخل دورهٔ قفل‌شده رد می‌شود، بعد از آن پذیرفته', async () => {
    const cash = await accountByCode('110101')
    const equity = await accountByCode('3101')
    await tx((t) => setPeriodLock(t, { lockToDate: D('2026-06-15'), reason: 'بستن خرداد' }))

    await expectRejects(() => tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-10'), description: 'داخل قفل',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    })), /بسته است/)

    const ok = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-20'), description: 'بعد از قفل',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))
    expect(ok.status).toBe('POSTED')
  })

  it('قفل دوم روی همان ماژول جایگزین می‌شود، نه انباشت', async () => {
    await tx((t) => setPeriodLock(t, { lockToDate: D('2026-06-15'), reason: 'اول' }))
    await tx((t) => setPeriodLock(t, { lockToDate: D('2026-07-15'), reason: 'دوم' }))
    const locks = await gl.glPeriodLock.findMany({ where: { module: 'ALL' } })
    expect(locks).toHaveLength(1)
    expect(locks[0].lockToDate.toISOString().slice(0, 10)).toBe('2026-07-15')
  })

  it('برداشتن قفل، ثبت را دوباره آزاد می‌کند', async () => {
    const cash = await accountByCode('110101')
    const equity = await accountByCode('3101')
    const lock = await tx((t) => setPeriodLock(t, { lockToDate: D('2026-06-15'), reason: 'x' }))
    await tx((t) => removePeriodLock(t, lock.id))
    const ok = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-10'), description: 'آزاد',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))
    expect(ok.status).toBe('POSTED')
  })
})
