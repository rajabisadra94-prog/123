/**
 * آیکون‌های برداری سیستم — جایگزین ایموجی.
 *
 * چرا: ایموجی به فونت سیستم وابسته است، روی ویندوز/اندروید/آی‌اواس شکل و وزن
 * متفاوت دارد، رنگش را نمی‌شود با توکن کنترل کرد و اندازه‌اش با متن هم‌تراز
 * نمی‌شود — همان چیزی که ظاهر برنامه را غیرحرفه‌ای می‌کرد.
 *
 * همه با یک قاعده کشیده شده‌اند: کادر ۲۴×۲۴، فقط خط (نه توپُر)، ضخامت ۱.۷۵،
 * سرِ گرد، و رنگ `currentColor` تا از متنِ والد ارث ببرد.
 */

export type IconName =
  | 'phone' | 'phone-off' | 'chat' | 'send' | 'mobile' | 'instagram' | 'mail' | 'globe'
  | 'trash' | 'pencil' | 'upload' | 'download' | 'settings' | 'chart' | 'clock' | 'alarm'
  | 'package' | 'grid' | 'contacts' | 'paperclip' | 'clipboard' | 'star' | 'x' | 'check'
  | 'plus' | 'search' | 'chevron-right' | 'chevron-left' | 'alert' | 'trophy' | 'pin'
  | 'users' | 'circle' | 'repeat' | 'exchange' | 'ban' | 'thumbs-up' | 'thumbs-down'
  | 'minus' | 'wallet' | 'handshake' | 'banknote' | 'hourglass' | 'book' | 'list'
  | 'file' | 'video' | 'award' | 'store' | 'truck' | 'tooth' | 'flask' | 'bell'
  | 'cloud-off' | 'cloud-up' | 'share' | 'copy' | 'image' | 'history'

const P: Record<IconName, React.ReactNode> = {
  phone: <path d="M4 4h4l2 5-2.5 1.5a12 12 0 0 0 6 6L15 14l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 3 5a1 1 0 0 1 1-1Z" />,
  'phone-off': <><path d="M4 4h4l2 5-2.5 1.5a12 12 0 0 0 6 6L15 14l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 3 5a1 1 0 0 1 1-1Z" /><path d="M2 2l20 20" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" />,
  send: <><path d="M22 2 11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7Z" /></>,
  mobile: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  instagram: <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="3.5" /><path d="M17.5 6.5h.01" /></>,
  mail: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m2 7 10 6 10-6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" /></>,

  trash: <><path d="M4 6h16" /><path d="M9 6V4h6v2" /><path d="M6 6v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6" /><path d="M10 11v6M14 11v6" /></>,
  pencil: <><path d="M4 20h4L20 8l-4-4L4 16v4Z" /><path d="M14 6l4 4" /></>,
  upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></>,
  download: <><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15.4H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  chart: <><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alarm: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 1.5" /><path d="m3 5 3-2M21 5l-3-2" /></>,

  package: <><path d="M21 8v8l-9 5-9-5V8l9-5 9 5Z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  contacts: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="10" cy="11" r="2.5" /><path d="M6 17c.8-1.8 2.3-2.5 4-2.5s3.2.7 4 2.5" /><path d="M17 9h2M17 13h2" /></>,
  paperclip: <path d="M20 11l-8.5 8.5a4.5 4.5 0 0 1-6.4-6.4l9-9a3 3 0 1 1 4.3 4.3l-9 9a1.5 1.5 0 0 1-2.2-2.1l8-8" />,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9V4Z" /><path d="M9 11h6M9 15h4" /></>,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 13 4.5 4.5L19 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-left': <path d="m15 5-7 7 7 7" />,
  alert: <><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>,
  trophy: <><path d="M7 4h10v6a5 5 0 0 1-10 0V4Z" /><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" /><path d="M10 15v3M14 15v3M8 21h8" /></>,
  pin: <><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20c1-3.5 3.4-5 6-5s5 1.5 6 5" /><path d="M17 8.5a3 3 0 0 1 0 5M18 20c-.4-1.8-1-3-1.8-4" /></>,

  circle: <circle cx="12" cy="12" r="8" />,
  repeat: <><path d="M4 10a6 6 0 0 1 6-6h9" /><path d="m16 1 3 3-3 3" /><path d="M20 14a6 6 0 0 1-6 6H5" /><path d="m8 23-3-3 3-3" /></>,
  exchange: <><path d="M4 8h14" /><path d="m15 5 3 3-3 3" /><path d="M20 16H6" /><path d="m9 13-3 3 3 3" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  'thumbs-up': <><path d="M7 21V10l4.5-7A2 2 0 0 1 14 4.5l-.8 4.5H19a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 21H7Z" /><path d="M7 10H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /></>,
  'thumbs-down': <><path d="M17 3v11l-4.5 7A2 2 0 0 1 10 19.5l.8-4.5H5a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.4 3H17Z" /><path d="M17 14h3a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-3" /></>,
  minus: <path d="M6 12h12" />,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="17" cy="14.5" r="1.2" /></>,
  handshake: <><path d="m11 17 2 2 3-3 3 3 2-2-6-6-4 4" /><path d="M11 17 8 20l-2-2 3-3" /><path d="M3 11 8 6l4 3 3-3 6 6" /></>,
  banknote: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>,
  hourglass: <><path d="M7 3h10M7 21h10" /><path d="M7 3c0 5 5 6 5 9s-5 4-5 9" /><path d="M17 3c0 5-5 6-5 9s5 4 5 9" /></>,
  book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19v18H6.5A2.5 2.5 0 0 0 4 22V4.5Z" /><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>,
  video: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3v-4Z" /></>,
  award: <><circle cx="12" cy="9" r="6" /><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7" /></>,
  store: <><path d="M4 10v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V10" /><path d="M3 6.5 4.5 3h15L21 6.5a3 3 0 0 1-6 1a3 3 0 0 1-6 0a3 3 0 0 1-6-1Z" /><path d="M9 21v-6h6v6" /></>,
  truck: <><path d="M2 6h11v11H2V6Z" /><path d="M13 9h4l4 4v4h-8V9Z" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="17" cy="18.5" r="2" /></>,
  tooth: <path d="M12 3c2 0 3-1 5 0s2.5 3.5 2 6c-.6 3-1 4.5-1.5 8-.3 2-1 3-2 3s-1.5-1.5-2-4c-.3-1.6-.6-2.5-1.5-2.5s-1.2.9-1.5 2.5c-.5 2.5-1 4-2 4s-1.7-1-2-3c-.5-3.5-.9-5-1.5-8-.5-2.5-.1-5 2-6s3 0 5 0Z" />,
  flask: <><path d="M9 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19L15 9V3" /><path d="M8 3h8" /><path d="M7 14h10" /></>,
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z" /><path d="M10.5 19a2 2 0 0 0 3 0" /></>,

  'cloud-off': <><path d="M6.5 19A4.5 4.5 0 0 1 6 10a6 6 0 0 1 1.6-3" /><path d="M11 6.1A6 6 0 0 1 18 12h.5a4.5 4.5 0 0 1 2.9 7.9" /><path d="M9 19h9" /><path d="M2 2l20 20" /></>,
  'cloud-up': <><path d="M6.5 19a4.5 4.5 0 0 1 0-9 6 6 0 0 1 11.5 1.5h.5a4.5 4.5 0 0 1 0 9h-11" /><path d="M12 20v-7" /><path d="m9 16 3-3 3 3" /></>,
  share: <><path d="M12 3v12" /><path d="m8 7 4-4 4 4" /><path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5-6 6-2-2-5 5" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M12 7.5V12l3 2" /></>,
}

/**
 * @param name نام آیکون
 * @param size اندازه به پیکسل (پیش‌فرض ۱۶ — هم‌تراز با متن ۱۲–۱۴px)
 * @param label اگر آیکون تنها معنا را می‌رساند (بدون متن کنارش) این را بده تا
 *   صفحه‌خوان بخواندش؛ وگرنه آیکون تزئینی است و از دسترس‌پذیری پنهان می‌شود.
 */
export default function Icon({ name, size = 16, label, className, style }: {
  name: IconName
  size?: number
  label?: string
  className?: string
  style?: React.CSSProperties
}) {
  const path = P[name]
  if (!path) return null
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} className={className}
      style={{ flex: 'none', display: 'inline-block', verticalAlign: '-0.14em', ...style }}
      fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {path}
    </svg>
  )
}
