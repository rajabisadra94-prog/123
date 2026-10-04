import { useMemo, useState } from 'react'
import { fmt } from '../../lib/ledgerFormat'

/**
 * نمودار روند ماهانه — SVG دست‌ساز (ممیزی سوم — ب۱۵).
 *
 * **چرا کتابخانه اضافه نشد:** باندل فرانت همین حالا ۱٫۲ مگابایت است و
 * هشدار حجم می‌دهد؛ recharts تقریباً نیم‌مگابایت دیگر اضافه می‌کرد، برای
 * نموداری با دوازده نقطه. سامانه از قبل SVG خام می‌نویسد (`ui/Icon.tsx`)،
 * پس این هم همان‌جا می‌نشیند و با `var(--…)` خودبه‌خود با تم عوض می‌شود.
 *
 * **چرا میله‌ها و خط با هم:** درآمد و هزینه مقدارِ یک بازه‌اند (میله)، ولی
 * ماندهٔ نقد یک وضعیت در یک لحظه است (خط). کشیدن هر سه به یک شکل، خواننده
 * را وامی‌دارد فکر کند نقد هم «درآمدِ ماه» است.
 *
 * ماه‌های نیامده اصلاً کشیده نمی‌شوند — صفرِ آینده با صفرِ واقعی فرق دارد.
 */

export interface TrendPoint {
  month: number
  label: string
  income: string
  expense: string
  profit: string
  cash: string
  future: boolean
}

const W = 760, H = 240
const PAD = { top: 16, right: 8, bottom: 28, left: 8 }

export default function TrendChart({ months }: { months: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const past = useMemo(() => months.filter((m) => !m.future), [months])

  /**
   * سقفِ میله‌ها با **صدکِ ۷۵ ضربدر دو** حساب می‌شود، نه با بیشترین مقدار.
   *
   * ⚠️ چرا: روی دادهٔ واقعی یک فروش صادراتیِ بزرگ در تیر، یازده ماه دیگر را
   * به نوارهای نامرئی تبدیل کرد. مقیاسِ خطی با یک عدد پرت، نموداری می‌سازد
   * که فقط همان عدد پرت را نشان می‌دهد — و کسی برای دیدن یک عدد نمودار
   * نمی‌کشد.
   *
   * ماهی که از سقف بزند بریده می‌شود ولی **ناپدید نمی‌شود**: نوارش تا لبه
   * می‌رود و یک نشانِ «▲» بالایش می‌آید تا خواننده بداند بریده شده. پنهان
   * کردنش بدتر از بریدنش بود.
   */
  const scale = useMemo(() => {
    if (!past.length) return null
    const bars = past.flatMap((m) => [Number(m.income), Number(m.expense)]).filter((x) => x > 0)
    const cash = past.map((m) => Number(m.cash))
    const sorted = [...bars].sort((a, b) => a - b)
    const p75 = sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : 0
    const trueMax = Math.max(1, ...bars, 0)
    // اگر پراکندگی کم باشد، همان بیشینه سقف است و چیزی بریده نمی‌شود
    const barMax = Math.max(1, Math.min(trueMax, p75 * 2 || trueMax))
    return { barMax, trueMax, cashMin: Math.min(0, ...cash), cashMax: Math.max(1, ...cash) }
  }, [past])

  if (!scale || past.length === 0) {
    return <div className="hint-sm" style={{ padding: 20, textAlign: 'center' }}>هنوز سندی در این سال مالی ثبت نشده.</div>
  }

  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const slot = innerW / past.length
  const barW = Math.min(14, slot / 3.2)

  // RTL: فروردین باید سمت راست باشد، پس محور x برعکسِ ترتیب آرایه است
  const xOf = (i: number) => PAD.left + innerW - (i + 0.5) * slot
  // مقدارِ بیش از سقف روی لبه می‌ایستد (بریده)، نه بیرون از کادر
  const clipped = (v: number) => v > scale.barMax
  const yBar = (v: number) => PAD.top + innerH - (Math.min(v, scale.barMax) / scale.barMax) * innerH
  const yCash = (v: number) =>
    PAD.top + innerH - ((v - scale.cashMin) / (scale.cashMax - scale.cashMin || 1)) * innerH

  const cashPath = past
    .map((m, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(1)} ${yCash(Number(m.cash)).toFixed(1)}`)
    .join(' ')

  const h = hover != null ? past[hover] : null

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label="نمودار روند درآمد، هزینه و ماندهٔ نقد به تفکیک ماه">
        {/* خطوط راهنما */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + innerH * f} y2={PAD.top + innerH * f}
            stroke="var(--border)" strokeWidth="1" strokeDasharray={f === 1 ? '' : '3 4'} />
        ))}

        {past.map((m, i) => {
          const x = xOf(i)
          const inc = Number(m.income), exp = Number(m.expense)
          return (
            <g key={m.month}>
              {/* ناحیهٔ حساس، پهن‌تر از میله‌ها تا نشانه‌گر راحت بگیرد */}
              <rect x={x - slot / 2} y={PAD.top} width={slot} height={innerH}
                fill={hover === i ? 'var(--surface-2)' : 'transparent'}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              <rect x={x - barW - 1} y={yBar(inc)} width={barW} height={Math.max(0, PAD.top + innerH - yBar(inc))}
                fill="var(--success)" rx="2" pointerEvents="none" />
              <rect x={x + 1} y={yBar(exp)} width={barW} height={Math.max(0, PAD.top + innerH - yBar(exp))}
                fill="var(--danger)" rx="2" pointerEvents="none" />
              {/* نشانِ بریدگی — ماهی که از سقف زده، پنهان نمی‌شود */}
              {clipped(inc) && (
                <text x={x - barW / 2 - 1} y={PAD.top - 3} textAnchor="middle" fontSize="9"
                  fill="var(--success)" pointerEvents="none">▲</text>
              )}
              {clipped(exp) && (
                <text x={x + barW / 2 + 1} y={PAD.top - 3} textAnchor="middle" fontSize="9"
                  fill="var(--danger)" pointerEvents="none">▲</text>
              )}
              <text x={x} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{m.label}</text>
            </g>
          )
        })}

        <path d={cashPath} fill="none" stroke="var(--brand)" strokeWidth="2"
          strokeLinejoin="round" pointerEvents="none" />
        {past.map((m, i) => (
          <circle key={m.month} cx={xOf(i)} cy={yCash(Number(m.cash))} r={hover === i ? 4.5 : 2.8}
            fill="var(--brand)" pointerEvents="none" />
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, marginTop: 4 }}>
        <Key color="var(--success)">درآمد ماه</Key>
        <Key color="var(--danger)">هزینهٔ ماه</Key>
        <Key color="var(--brand)" line>ماندهٔ نقد (تجمعی)</Key>
        {scale.trueMax > scale.barMax && (
          <span className="hint-sm">▲ = بیش از سقفِ نمودار؛ عدد دقیق را با نشانه‌گر ببینید</span>
        )}
      </div>

      {h && (
        <div className="panel" style={{
          position: 'absolute', top: 4, insetInlineStart: 4, padding: '8px 12px',
          fontSize: 12, pointerEvents: 'none', boxShadow: 'var(--shadow-md)', zIndex: 2,
        }}>
          <strong>{h.label}</strong>
          <div className="num">درآمد: {fmt(h.income)}</div>
          <div className="num">هزینه: {fmt(h.expense)}</div>
          <div className="num" style={{ color: Number(h.profit) < 0 ? 'var(--danger)' : 'var(--success)' }}>
            سود: {fmt(h.profit)}
          </div>
          <div className="num" style={{ color: 'var(--brand)' }}>نقد: {fmt(h.cash)}</div>
        </div>
      )}
    </div>
  )
}

function Key({ color, line, children }: { color: string; line?: boolean; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 14, height: line ? 2 : 10, borderRadius: line ? 1 : 2, background: color,
      }} />
      {children}
    </span>
  )
}
