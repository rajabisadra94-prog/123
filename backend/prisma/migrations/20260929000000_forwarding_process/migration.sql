-- فرایند حمل بار: هدف مشتری، نحوهٔ رسیدن به انبار چین، تأییدیه انبار، پیش‌پرداخت و تکمیل وجه
ALTER TABLE "ForwardingCargo"
  ADD COLUMN IF NOT EXISTS "targetAmount" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "targetCurrency" "Currency",
  ADD COLUMN IF NOT EXISTS "desiredArrivalDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "inboundMode" TEXT,
  ADD COLUMN IF NOT EXISTS "pickupAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "warehouseInfoSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "warehouseConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "prepaymentAmount" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "prepaymentCurrency" "Currency",
  ADD COLUMN IF NOT EXISTS "prepaymentReceivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fullPaymentReceivedAt" TIMESTAMP(3);
