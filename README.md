# سیستم مدیریت فابریک

## راه‌اندازی اولیه

### پیش‌نیازها
- Node.js 18+
- Docker Desktop

### مرحله ۱: دیتابیس
```bash
cd factory-system
docker compose up -d
```

### مرحله ۲: Backend
```bash
cd backend
npm install
npx prisma migrate dev --name init
npx tsx prisma/seed.ts
npm run dev
```

### مرحله ۳: Frontend
```bash
cd frontend
npm install
npm run dev
```

## دسترسی
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- ایمیل: admin@factory.com
- رمز: admin123
