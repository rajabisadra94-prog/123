/**
 * موتور محاسبهٔ حقوق — **تابع خالص**.
 *
 * الزام معماری بند ۳-۶: «موتور محاسبه کاملاً جدا از لایهٔ ثبت سند. موتور فقط
 * لیست حقوق تولید می‌کند؛ آداپتور جداگانه آن را به سند تبدیل می‌کند. اگر قاطی
 * شوند، هر تغییر قانون به دفترداری دست می‌زند.»
 *
 * پس این فایل:
 *   • هیچ import از `poster` یا Prisma ندارد
 *   • هیچ چیزی نمی‌نویسد
 *   • ورودی‌اش نرخ‌های **حل‌شده** است، نه دیتابیس
 *
 * نتیجه: با همان ورودی، همیشه همان خروجی — مهم نیست کِی اجرا شود.
 */
import { Minor, divRound } from '../money';
import { ResolvedRates, RATE_KEYS, OPTIONAL_RATE_KEYS } from './rates';

export interface EmployeeInput {
  employeeId: string;
  /** حقوق پایهٔ ماهانهٔ قراردادی */
  baseSalary: Minor;
  childrenCount: number;
  /** سابقه به سال کامل — مبنای پایهٔ سنوات */
  seniorityYears: number;
  workedDays: number;
  overtimeHours: number;
  nightHours: number;
  holidayHours: number;
  /** کسورات غیرقانونی که از بیرون می‌آیند */
  loanDeduction?: Minor;
  advanceDeduction?: Minor;
  otherDeduction?: Minor;
}

export interface PayrollItemResult {
  employeeId: string;
  baseSalary: Minor;
  seniorityPay: Minor;
  housingAllowance: Minor;
  foodAllowance: Minor;
  childAllowance: Minor;
  overtimePay: Minor;
  nightPay: Minor;
  holidayPay: Minor;
  grossPay: Minor;

  insuranceBase: Minor;
  taxableBase: Minor;

  insuranceEmployee: Minor;
  incomeTax: Minor;
  loanDeduction: Minor;
  advanceDeduction: Minor;
  otherDeduction: Minor;
  netPay: Minor;

  insuranceEmployer: Minor;
  unemploymentDue: Minor;

  accrualBonus: Minor;
  accrualSeverance: Minor;
  accrualLeave: Minor;
}

/**
 * کدام جزء مشمول بیمه و کدام مشمول مالیات است.
 *
 * اینها **قاعدهٔ قانونی** اند نه نرخ، پس اینجا و صریح می‌مانند تا قابل بازبینی
 * باشند. اگر قانون عوض شد، تغییرش یک خط است و همین‌جا دیده می‌شود.
 * حق اولاد طبق قانون کار از هر دو معاف است.
 */
const COMPONENTS = {
  baseSalary: { insurable: true, taxable: true },
  seniorityPay: { insurable: true, taxable: true },
  housingAllowance: { insurable: true, taxable: true },
  foodAllowance: { insurable: true, taxable: true },
  childAllowance: { insurable: false, taxable: false },
  overtimePay: { insurable: true, taxable: true },
  nightPay: { insurable: true, taxable: true },
  holidayPay: { insurable: true, taxable: true },
} as const;

/** ضرب مبلغ صحیح در یک ضریب کسری، با گرد کردن نیم‌به‌بالا */
const scale = (amount: Minor, factor: number): Minor => {
  // ضریب به کسر صحیح تبدیل می‌شود تا شناور وارد مبلغ نشود
  const SCALE = 1_000_000n;
  return divRound(amount * BigInt(Math.round(factor * Number(SCALE))), SCALE);
};

/**
 * مالیات پلکانی روی مبنای مشمول.
 *
 * هر پله فقط روی **بخشی از درآمد که داخل همان پله است** اعمال می‌شود، نه روی کل.
 */
export function progressiveTax(base: Minor, brackets: ResolvedRates['brackets']): Minor {
  if (base <= 0n) return 0n;
  let tax = 0n;
  for (const b of brackets) {
    if (base <= b.from) break;
    const upper = b.to === null ? base : (base < b.to ? base : b.to);
    const slice = upper - b.from;
    if (slice > 0n) tax += scale(slice, b.rate);
  }
  return tax;
}

export function computePayrollItem(input: EmployeeInput, rates: ResolvedRates): PayrollItemResult {
  const v = rates.values;
  const monthDays = v[RATE_KEYS.MONTH_DAYS];
  const monthHours = v[RATE_KEYS.MONTH_HOURS];
  if (!(monthDays > 0) || !(monthHours > 0)) {
    throw new Error('MONTH_DAYS و MONTH_HOURS باید بزرگ‌تر از صفر باشند');
  }

  const dayRatio = Math.min(input.workedDays, monthDays) / monthDays;

  // ── مزایای ثابت، به نسبت روزهای کارکرد ──
  const baseSalary = scale(input.baseSalary, dayRatio);
  const seniorityPay = scale(
    BigInt(Math.round(v[RATE_KEYS.SENIORITY_DAILY])) * BigInt(Math.max(0, input.seniorityYears) * monthDays),
    dayRatio,
  );
  const housingAllowance = scale(BigInt(Math.round(v[RATE_KEYS.HOUSING_MONTHLY])), dayRatio);
  const foodAllowance = scale(BigInt(Math.round(v[RATE_KEYS.FOOD_MONTHLY])), dayRatio);
  const childAllowance =
    BigInt(Math.round(v[RATE_KEYS.CHILD_PER_CHILD])) * BigInt(Math.max(0, input.childrenCount));

  // ── اضافه‌کاری و شب‌کاری و جمعه‌کاری، بر پایهٔ نرخ ساعتی حقوق پایه ──
  const hourlyRate = divRound(input.baseSalary, BigInt(Math.round(monthHours)));
  const hourPay = (hours: number, factor: number) =>
    scale(hourlyRate * BigInt(Math.round(hours * 100)), factor / 100);

  const overtimePay = hourPay(input.overtimeHours, v[RATE_KEYS.OVERTIME_FACTOR]);
  const nightPay = hourPay(input.nightHours, v[RATE_KEYS.NIGHT_FACTOR]);
  const holidayPay = hourPay(input.holidayHours, v[RATE_KEYS.HOLIDAY_FACTOR]);

  const parts = {
    baseSalary, seniorityPay, housingAllowance, foodAllowance,
    childAllowance, overtimePay, nightPay, holidayPay,
  };
  const grossPay = Object.values(parts).reduce((s, x) => s + x, 0n);

  // ── مبناهای بیمه و مالیات ──
  const sumWhere = (flag: 'insurable' | 'taxable') =>
    (Object.keys(parts) as (keyof typeof parts)[])
      .filter((k) => COMPONENTS[k][flag])
      .reduce((s, k) => s + parts[k], 0n);

  let insuranceBase = sumWhere('insurable');
  const ceiling = BigInt(Math.round(v[RATE_KEYS.INSURANCE_CEILING]));
  if (ceiling > 0n && insuranceBase > ceiling) insuranceBase = ceiling;

  const exemption = BigInt(Math.round(v[RATE_KEYS.TAX_EXEMPTION_MONTHLY]));
  const taxableGross = sumWhere('taxable');
  const taxableBase = taxableGross > exemption ? taxableGross - exemption : 0n;

  // ── کسورات و سهم کارفرما ──
  const insuranceEmployee = scale(insuranceBase, v[RATE_KEYS.INSURANCE_EMPLOYEE]);
  const insuranceEmployer = scale(insuranceBase, v[RATE_KEYS.INSURANCE_EMPLOYER]);
  const unemploymentDue = scale(insuranceBase, v[RATE_KEYS.UNEMPLOYMENT]);
  const incomeTax = progressiveTax(taxableBase, rates.brackets);

  const loanDeduction = input.loanDeduction ?? 0n;
  const advanceDeduction = input.advanceDeduction ?? 0n;
  const otherDeduction = input.otherDeduction ?? 0n;

  const netPay =
    grossPay - insuranceEmployee - incomeTax - loanDeduction - advanceDeduction - otherDeduction;

  // ── ذخیره‌های ماهانه (الزام بند ۳-۶) ──
  // اگر یک‌جا در اسفند ثبت شوند، سود و زیان ماهانه بی‌معنی می‌شود.

  // ممیزی ج۱۷: عیدی بر **مزد ثابت** است، نه ناخالص (اضافه‌کاری/شب‌کاری در آن نیست)،
  // و سقفِ قانونی دارد (۹۰ روزِ حداقل‌دستمزد در سال). base و seniorityPay از قبل
  // به‌نسبتِ روزهای کارکرد کم شده‌اند؛ سقف هم با همان نسبت کوچک می‌شود.
  const bonusIncludeAllowances = v[OPTIONAL_RATE_KEYS.BONUS_INCLUDE_ALLOWANCES] >= 1;
  const bonusBase =
    baseSalary + seniorityPay +
    (bonusIncludeAllowances ? housingAllowance + foodAllowance : 0n);
  let accrualBonus = scale(bonusBase, v[RATE_KEYS.BONUS_ACCRUAL_FACTOR]);
  const capDays = v[OPTIONAL_RATE_KEYS.BONUS_CAP_DAYS];
  const minWageDaily = BigInt(Math.round(v[RATE_KEYS.MIN_WAGE_DAILY]));
  if (capDays > 0 && minWageDaily > 0n) {
    const annualCap = minWageDaily * BigInt(Math.round(capDays));
    const monthlyCap = scale(divRound(annualCap, 12n), dayRatio);
    if (monthlyCap > 0n && accrualBonus > monthlyCap) accrualBonus = monthlyCap;
  }

  const dailyWage = divRound(input.baseSalary, BigInt(Math.round(monthDays)));
  const accrualSeverance = scale(dailyWage, v[RATE_KEYS.SEVERANCE_DAYS_PER_MONTH]);
  const accrualLeave = scale(dailyWage, v[RATE_KEYS.LEAVE_DAYS_PER_MONTH]);

  return {
    employeeId: input.employeeId,
    ...parts,
    grossPay,
    insuranceBase,
    taxableBase,
    insuranceEmployee,
    incomeTax,
    loanDeduction,
    advanceDeduction,
    otherDeduction,
    netPay,
    insuranceEmployer,
    unemploymentDue,
    accrualBonus,
    accrualSeverance,
    accrualLeave,
  };
}

/** جمع یک لیست حقوق — برای ساخت سند و بازبینی */
export function summarize(items: PayrollItemResult[]) {
  const zero = 0n;
  const add = (k: keyof PayrollItemResult) =>
    items.reduce((s, i) => s + (i[k] as Minor), zero);

  return {
    count: items.length,
    grossPay: add('grossPay'),
    insuranceEmployee: add('insuranceEmployee'),
    incomeTax: add('incomeTax'),
    loanDeduction: add('loanDeduction'),
    advanceDeduction: add('advanceDeduction'),
    otherDeduction: add('otherDeduction'),
    netPay: add('netPay'),
    insuranceEmployer: add('insuranceEmployer'),
    unemploymentDue: add('unemploymentDue'),
    accrualBonus: add('accrualBonus'),
    accrualSeverance: add('accrualSeverance'),
    accrualLeave: add('accrualLeave'),
  };
}
