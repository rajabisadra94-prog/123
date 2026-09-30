/**
 * پرداختِ ذخیره‌های حقوق — عیدی، سنوات، مرخصیِ استفاده‌نشده، تسویه‌حساب (ممیزی ج۱۰).
 *
 * موتور حقوق هر ماه ذخیره می‌گیرد (بدهکار هزینهٔ ۶۱۰x، بستانکار ذخیرهٔ ۲۱۰x).
 * اینجا آن ذخیره **پرداخت** می‌شود:
 *
 *   بدهکار  ذخیرهٔ ۲۱۰x            ← بدهی از بین می‌رود
 *   بدهکار/بستانکار  هزینهٔ ۶۱۰x   ← فقط مابه‌التفاوتِ ذخیره و پرداختِ واقعی
 *   بستانکار حساب نقدی/بانکی       ← وجهِ پرداخت‌شده
 *
 * حساب‌های ذخیره تفصیلی ندارند (جمعِ کلِ شرکت‌اند)، پس نامِ کارمند فقط در شرح
 * می‌آید. برای تسویه‌حسابِ فردی، `trueUp` کلِ ماندهٔ ذخیره را می‌بندد.
 */
import { Prisma } from '@prisma/client';
import { post, DraftLine } from '../poster';
import { parseAmount, rateFrom, Minor } from '../money';
import { positionBalance } from '../fx';
import { PAYROLL_CODES, PayrollError } from './run';

export type ProvisionKind = 'BONUS' | 'SEVERANCE' | 'LEAVE';

const PROVISION: Record<ProvisionKind, { provision: string; expense: string; label: string }> = {
  BONUS: { provision: PAYROLL_CODES.bonusProvision, expense: PAYROLL_CODES.bonusExpense, label: 'عیدی' },
  SEVERANCE: { provision: PAYROLL_CODES.severanceProvision, expense: PAYROLL_CODES.severanceExpense, label: 'سنوات' },
  LEAVE: { provision: PAYROLL_CODES.leaveProvision, expense: PAYROLL_CODES.leaveExpense, label: 'مرخصی' },
};

export interface PayProvisionInput {
  fiscalYearId: string;
  date: Date;
  kind: ProvisionKind;
  /** مبلغِ نقدیِ پرداخت‌شده — واحد نمایش (ریال) */
  amount: string;
  /** حساب نقدی/بانکیِ شرکت */
  cashAccountCode: string;
  /** نامِ کارمند/دورهٔ پرداخت — فقط در شرح می‌نشیند */
  forWhom?: string;
  /**
   * کلِ ماندهٔ ذخیره را ببند (تسویه‌حسابِ فردی / پایان سال). مابه‌التفاوتِ
   * ذخیره و پرداختِ واقعی به حساب هزینهٔ همان قلم می‌رود. بدون این، فقط تا سقفِ
   * پرداخت از ذخیره برداشته می‌شود و مازادِ پرداخت هزینهٔ همین دوره است.
   */
  trueUp?: boolean;
  /**
   * مرکز هزینهٔ خطِ مابه‌التفاوت (حساب‌های ۶۱۰x مرکز اجباری دارند). اگر ندهید،
   * «اداری و مالی» (کد ۳) به کار می‌رود؛ اگر آن هم نباشد و خطِ هزینه لازم شود،
   * سند با خطای روشن رد می‌شود.
   */
  costCenterId?: string;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
}

async function postableLeaf(tx: Prisma.TransactionClient, code: string) {
  const a = await tx.glAccount.findUnique({ where: { code } });
  if (!a) throw new PayrollError(`حساب ${code} در چارت نیست`);
  if (!a.isActive) throw new PayrollError(`حساب ${code} غیرفعال است`);
  if (!a.isPostable) throw new PayrollError(`حساب ${code} سرگروه است و سند نمی‌پذیرد`);
  return a;
}

export async function payProvision(tx: Prisma.TransactionClient, input: PayProvisionInput) {
  const cfg = PROVISION[input.kind];
  if (!cfg) throw new PayrollError('نوع ذخیره نامعتبر است');

  const provAcc = await postableLeaf(tx, cfg.provision);
  const cashAcc = await postableLeaf(tx, input.cashAccountCode);
  if (cashAcc.currencyMode === 'SINGLE' && cashAcc.currencyCode !== 'IRR') {
    throw new PayrollError(`حساب «${cashAcc.name}» فقط ${cashAcc.currencyCode} می‌پذیرد — ذخیرهٔ حقوق ریالی است`);
  }

  const paid = parseAmount(input.amount, 0);
  if (paid <= 0n) throw new PayrollError('مبلغ پرداخت باید بزرگ‌تر از صفر باشد');

  const rate = rateFrom(1);
  const pos = await positionBalance(tx, { accountId: provAcc.id, currencyCode: 'IRR', subsidiaryId: null });
  const provBalance = pos.amount > 0n ? pos.amount : 0n;

  const who = input.forWhom ? ` — ${input.forWhom}` : '';
  const lines: DraftLine[] = [];
  const dr = (accountId: string, amount: Minor, memo: string, costCenterId?: string) =>
    lines.push({ accountId, currencyCode: 'IRR', debit: amount, rate, memo, costCenterId });
  const cr = (accountId: string, amount: Minor, memo: string, costCenterId?: string) =>
    lines.push({ accountId, currencyCode: 'IRR', credit: amount, rate, memo, costCenterId });

  /** مرکز هزینهٔ خطِ مابه‌التفاوت — ورودی، یا «اداری و مالی» (۳) */
  const resolveCostCenter = async (): Promise<string> => {
    if (input.costCenterId) return input.costCenterId;
    const admin = await tx.glCostCenter.findFirst({ where: { code: '3', isPostable: true } });
    if (admin) return admin.id;
    throw new PayrollError(
      'خطِ مابه‌التفاوتِ ذخیره به مرکز هزینه نیاز دارد — مرکزِ «اداری و مالی» را بسازید یا صریح بدهید',
    );
  };

  if (input.trueUp) {
    // کلِ ذخیره بسته می‌شود؛ اختلاف با پرداخت = هزینه (کسری) یا برگشتِ هزینه (مازاد)
    const expAcc = await postableLeaf(tx, cfg.expense);
    dr(provAcc.id, provBalance, `بستنِ ذخیرهٔ ${cfg.label}${who}`);
    cr(cashAcc.id, paid, `پرداخت ${cfg.label}${who}`);
    const diff = paid - provBalance;                 // + یعنی ذخیره کم بوده
    if (diff !== 0n) {
      const ccId = await resolveCostCenter();
      if (diff > 0n) dr(expAcc.id, diff, `کسریِ ذخیرهٔ ${cfg.label}`, ccId);
      else cr(expAcc.id, -diff, `برگشتِ مازادِ ذخیرهٔ ${cfg.label}`, ccId);
    }
  } else {
    // پرداختِ جزئی: تا سقفِ ماندهٔ ذخیره از آن برداشته، مازادِ پرداخت هزینهٔ همین دوره
    const fromProvision = paid < provBalance ? paid : provBalance;
    const fromExpense = paid - fromProvision;
    if (fromProvision > 0n) dr(provAcc.id, fromProvision, `پرداخت از ذخیرهٔ ${cfg.label}${who}`);
    if (fromExpense > 0n) {
      const expAcc = await postableLeaf(tx, cfg.expense);
      dr(expAcc.id, fromExpense, `${cfg.label} مازاد بر ذخیره${who}`, await resolveCostCenter());
    }
    cr(cashAcc.id, paid, `پرداخت ${cfg.label}${who}`);
  }

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: input.description ?? `پرداخت ${cfg.label}${who}`,
    entryType: 'NORMAL',
    sourceType: 'ProvisionPayment',
    createdById: input.createdById ?? null,
    attachmentUrls: input.attachmentUrls,
    lines,
  });
}

/** ماندهٔ فعلیِ سه ذخیره — برای فرمِ پرداخت */
export async function provisionBalances(tx: Prisma.TransactionClient) {
  const out: Record<ProvisionKind, string> = { BONUS: '0', SEVERANCE: '0', LEAVE: '0' };
  for (const [kind, cfg] of Object.entries(PROVISION) as [ProvisionKind, typeof PROVISION[ProvisionKind]][]) {
    const acc = await tx.glAccount.findUnique({ where: { code: cfg.provision } });
    if (!acc) continue;
    const pos = await positionBalance(tx, { accountId: acc.id, currencyCode: 'IRR', subsidiaryId: null });
    out[kind] = (pos.amount > 0n ? pos.amount : 0n).toString();
  }
  return out;
}
