/**
 * پل واحدها بین هستهٔ قدیمی و جدید.
 *
 * هستهٔ قدیمی مبالغ ریالی را به **تومان** و به‌صورت `Decimal` نگه می‌دارد؛
 * هستهٔ جدید به **ریالِ صحیح**. این تفاوت دقیقاً همان چیزی است که در
 * `docs/LEDGER_MIGRATION.md` بخش ۲ اندازه‌گیری شد، پس اینجا یک‌جا و صریح
 * نوشته می‌شود نه پراکنده در هر فراخوان.
 */
import { Prisma } from '@prisma/client';
import { Minor, Rate, parseAmount, rateFrom } from './money';

/** تومان → ریال */
export const TOMAN_TO_RIAL = 10n;

type DecimalLike = Prisma.Decimal | number | string;

const asString = (v: DecimalLike): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v.toString();

/**
 * مبلغ هستهٔ قدیمی → کوچک‌ترین واحد هستهٔ جدید.
 *
 * برای ریال، ورودی **تومان** است و در ۱۰ ضرب می‌شود.
 * برای بقیهٔ ارزها، واحد یکی است و فقط به کوچک‌ترین واحد مقیاس می‌گیرد.
 */
export function fromLegacyAmount(value: DecimalLike, currencyCode: string, decimals: number): Minor {
  if (currencyCode === 'IRR') {
    // ۱ تومان = ۱۰ ریال، پس «مقیاس‌گرفتن با یک رقم اعشار» دقیقاً همان تبدیل به ریال است:
    //   ۴۳۲۱۰۸٫۴۳۳۵ تومان → ۴٬۳۲۱٬۰۸۴ ریال (گرد نیم‌به‌بالا)
    // این مسیر عمداً اول مقیاس می‌گیرد و بعد گرد می‌کند؛ اگر اول گرد می‌شد،
    // اعشار تومان پیش از تبدیل گم می‌شد.
    return parseAmount(asString(value), 1);
  }
  return parseAmount(asString(value), decimals);
}

/**
 * نرخ هستهٔ قدیمی (تومان به‌ازای یک واحد ارز) → نرخ جدید (ریال به‌ازای یک واحد).
 *
 * ⚠️ **ارز پایه استثناست.** برای ریال، نرخ قدیمی ۱ است (تومان به‌ازای تومان) و
 * نرخ جدید هم باید دقیقاً ۱ بماند (ریال به‌ازای ریال) — نه ۱۰. ضریب ۱۰ فقط برای
 * ارزهای دیگر است، چون واحد **پایه** از تومان به ریال عوض شده، نه واحد آن ارز.
 *
 * این اشتباه یک بار نوشته شد و تست‌ها نگرفتندش: در سندی که همهٔ ردیف‌هایش ریالی
 * است، هر دو سمت ۱۰ برابر می‌شوند و تراز باقی می‌ماند. فقط سند مختلط (ریالی +
 * ارزی) آن را لو می‌دهد.
 */
export function fromLegacyRate(rateToIRR: DecimalLike, currencyCode: string): Rate {
  if (currencyCode === 'IRR') return rateFrom(1);
  return { scaled: rateFrom(asString(rateToIRR)).scaled * TOMAN_TO_RIAL };
}
