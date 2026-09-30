/**
 * کدینگ چندسطحی با طول **قابل تنظیم** — الزام بند ۳-۱:
 * «تعداد سطوح و طول کد هر سطح هاردکد نشود.»
 *
 * پس تست‌ها با چند پیکربندی متفاوت اجرا می‌شوند تا ثابت شود هیچ عددی ثابت نیست.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  cumulativeLengths, levelOfCode, parentCodeOf, validateCode, createAccount, CodeError,
} from '../../src/modules/ledger/codes';
import { gl, resetGl, seedGlChart, accountByCode, expectRejects } from '../helpers/gl';

const IRANIAN = [
  { level: 1, name: 'گروه', digits: 1 },
  { level: 2, name: 'کل', digits: 1 },
  { level: 3, name: 'معین', digits: 2 },
  { level: 4, name: 'تفصیلی', digits: 2 },
];

/** پیکربندی کاملاً متفاوت — اگر جایی هاردکد باشد، اینجا می‌شکند */
const ALTERNATE = [
  { level: 1, name: 'گروه', digits: 2 },
  { level: 2, name: 'کل', digits: 3 },
  { level: 3, name: 'معین', digits: 3 },
];

describe('محاسبهٔ سطح از روی کد', () => {
  it('طول تجمعی سطوح', () => {
    expect(cumulativeLengths(IRANIAN)).toEqual([1, 2, 4, 6]);
    expect(cumulativeLengths(ALTERNATE)).toEqual([2, 5, 8]);
  });

  it('سطح هر کد', () => {
    expect(levelOfCode('1', IRANIAN)).toBe(1);
    expect(levelOfCode('11', IRANIAN)).toBe(2);
    expect(levelOfCode('1101', IRANIAN)).toBe(3);
    expect(levelOfCode('110101', IRANIAN)).toBe(4);
    expect(levelOfCode('11010', IRANIAN)).toBeNull();   // طول نامعتبر
  });

  it('همان منطق با پیکربندی دیگر — هیچ عددی هاردکد نیست', () => {
    expect(levelOfCode('11', ALTERNATE)).toBe(1);
    expect(levelOfCode('11222', ALTERNATE)).toBe(2);
    expect(levelOfCode('11222333', ALTERNATE)).toBe(3);
    expect(levelOfCode('1', ALTERNATE)).toBeNull();
  });

  it('کد والد از پیشوند مشتق می‌شود', () => {
    expect(parentCodeOf('110101', IRANIAN)).toBe('1101');
    expect(parentCodeOf('1101', IRANIAN)).toBe('11');
    expect(parentCodeOf('11', IRANIAN)).toBe('1');
    expect(parentCodeOf('1', IRANIAN)).toBeNull();
    expect(parentCodeOf('11222333', ALTERNATE)).toBe('11222');
  });
});

describe('اعتبارسنجی کد', () => {
  it('کد معتبر، سطح و والدش را می‌دهد', () => {
    expect(validateCode('110101', IRANIAN)).toEqual({ level: 4, parentCode: '1101' });
  });

  it('کد غیررقمی رد می‌شود', () => {
    expect(() => validateCode('11A1', IRANIAN)).toThrow(CodeError);
  });

  it('طول نامعتبر با پیام روشن رد می‌شود', () => {
    expect(() => validateCode('11010', IRANIAN)).toThrow(/طول‌های مجاز/);
  });
});

describe('ساخت حساب روی چارت واقعی', () => {
  beforeAll(async () => {
    await resetGl();
    await seedGlChart();
  }, 180_000);

  afterAll(async () => { await gl.$disconnect(); });

  beforeEach(async () => {
    await gl.glAccount.deleteMany({ where: { isSystem: false } });
  });

  it('حساب بانکی جدید زیر «موجودی نقد و بانک» ساخته می‌شود', async () => {
    const acc = await gl.$transaction((tx) => createAccount(tx, {
      code: '110102', name: 'بانک سپه — جاری ۱۲۳', currencyMode: 'SINGLE', currencyCode: 'IRR',
    }));
    expect(acc.level).toBe(4);
    expect(acc.isPostable).toBe(true);
    expect(acc.rootType).toBe('ASSET');
    expect(acc.normalSide).toBe('DEBIT');
    expect(acc.isSystem).toBe(false);

    const parent = await accountByCode('1101');
    expect(acc.parentId).toBe(parent.id);
  });

  it('طبقه‌بندی از والد به ارث می‌رسد — حدس زده نمی‌شود', async () => {
    const acc = await gl.$transaction((tx) => createAccount(tx, {
      code: '210111', name: 'پرداختنی خاص',
    }));
    const parent = await accountByCode('2101');
    expect(acc.rootType).toBe(parent.rootType);
    expect(acc.normalSide).toBe('CREDIT');
    expect(acc.requiresSubsidiary).toBe(parent.requiresSubsidiary);
  });

  it('والدِ بدون گردش، خودکار به سرگروه تبدیل می‌شود', async () => {
    const before = await accountByCode('1104');
    expect(before.isPostable).toBe(true);

    await gl.$transaction((tx) => createAccount(tx, { code: '110401', name: 'مشتریان داخلی' }));

    const after = await accountByCode('1104');
    expect(after.isPostable).toBe(false); // دیگر سند نمی‌گیرد
  });

  it('کد با والد ناموجود رد می‌شود', async () => {
    await expectRejects(
      () => gl.$transaction((tx) => createAccount(tx, { code: '990101', name: 'بی‌والد' })),
      /والد با کد/,
    );
  });

  it('ساخت سرفصل ریشه از این مسیر مجاز نیست', async () => {
    await expectRejects(
      () => gl.$transaction((tx) => createAccount(tx, { code: '9', name: 'سرفصل خودسر' })),
      /ریشه/,
    );
  });

  it('کد تکراری رد می‌شود', async () => {
    await gl.$transaction((tx) => createAccount(tx, { code: '110103', name: 'اول' }));
    await expectRejects(
      () => gl.$transaction((tx) => createAccount(tx, { code: '110103', name: 'دوم' })),
      /Unique|unique/,
    );
  });
});
