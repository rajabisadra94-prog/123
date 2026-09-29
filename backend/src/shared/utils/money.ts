// لایه سازگاری روی سرویس نرخ ارز جدید (rates.ts)
// همه مصرف‌کننده‌های قبلی (داشبورد، فاکتور، تنظیمات) بدون تغییر کار می‌کنند.
import { getRates, LiveRates } from './rates';

export type Currency = 'IRR' | 'USD' | 'CNY';

export interface MoneyAmount {
  amount: number;
  currency: Currency;
  rateToIRR: number;
  rateAt: Date;
}

export type ExchangeRates = LiveRates;

export async function getLiveRates(force = false): Promise<LiveRates> {
  return getRates(force);
}

export async function toIRR(amount: number, currency: Currency): Promise<number> {
  if (currency === 'IRR') return amount;
  const r = await getRates();
  return currency === 'USD' ? amount * r.USD_TO_IRR : amount * r.CNY_TO_IRR;
}

export async function buildMoneyObject(amount: number, currency: Currency): Promise<MoneyAmount> {
  const r = await getRates();
  const rateToIRR = currency === 'IRR' ? 1 : currency === 'USD' ? r.USD_TO_IRR : r.CNY_TO_IRR;
  return { amount, currency, rateToIRR, rateAt: new Date() };
}

/** گرد کردن به بالا: تومان→هزارگان، دلار/یوآن→یکان */
export function roundUp(amount: number, currency: Currency): number {
  if (currency === 'IRR') return Math.ceil(amount / 1000) * 1000;
  return Math.ceil(amount);
}

/** نمایش هر مبلغ با معادل دو ارز دیگر */
export async function formatWithEquivalents(amount: number, currency: Currency) {
  const r = await getRates();
  const irr = currency === 'IRR' ? amount : currency === 'USD' ? amount * r.USD_TO_IRR : amount * r.CNY_TO_IRR;
  return {
    primary: { amount, currency },
    equivalents: {
      IRR: Math.round(irr),
      USD: Math.round((irr / r.USD_TO_IRR) * 100) / 100,
      CNY: Math.round((irr / r.CNY_TO_IRR) * 100) / 100,
    },
  };
}
