import prisma from './prisma';
import { sendPushToUsers } from './push';

/**
 * مدیریت دسترسی کاربران به پروژه‌ها.
 * هر کاربر یک حالت دسترسی دارد: ALL (همه)، NONE (هیچ)، SPECIFIC (فقط پروژه‌های تخصیص‌یافته).
 * SUPER_ADMIN همیشه به همه دسترسی دارد.
 */

/** شناسهٔ پروژه‌هایی که کاربر دسترسی دارد. null یعنی «همهٔ پروژه‌ها» (بدون محدودیت). */
export async function accessibleProjectIds(userId: string, role: string): Promise<string[] | null> {
  if (role === 'SUPER_ADMIN') return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { projectAccessMode: true } });
  const mode = user?.projectAccessMode || 'ALL';
  if (mode === 'ALL') return null;
  if (mode === 'NONE') return [];
  const members = await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } });
  return members.map((m) => m.projectId);
}

/** آیا کاربر به این پروژه دسترسی دارد؟ */
export async function canAccessProject(userId: string, role: string, projectId: string): Promise<boolean> {
  const ids = await accessibleProjectIds(userId, role);
  if (ids === null) return true;
  return ids.includes(projectId);
}

/**
 * یک شرط `where` برای فیلتر کردن لیست‌ها بر اساس دسترسی پروژه.
 * اگر کاربر همه را ببیند → {} (بدون محدودیت). در غیر این صورت id پروژه باید در لیست باشد.
 * `field` نام فیلد شناسهٔ پروژه در مدل هدف است (پیش‌فرض projectId).
 */
export async function projectAccessWhere(userId: string, role: string, field = 'projectId'): Promise<Record<string, any>> {
  const ids = await accessibleProjectIds(userId, role);
  if (ids === null) return {};
  return { [field]: { in: ids } };
}

/** کاربرانی که به یک پروژه دسترسی دارند (برای اعلان تیمی). */
export async function projectAudienceUserIds(projectId: string): Promise<string[]> {
  const [users, members] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, role: true, projectAccessMode: true } }),
    prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } }),
  ]);
  const memberSet = new Set(members.map((m) => m.userId));
  return users
    .filter((u) => u.role === 'SUPER_ADMIN' || u.projectAccessMode === 'ALL' || (u.projectAccessMode === 'SPECIFIC' && memberSet.has(u.id)))
    .map((u) => u.id);
}

/** ساخت اعلان برای همهٔ مخاطبان یک پروژه به‌جز اقدام‌کننده. */
export async function notifyProjectAudience(
  projectId: string,
  actorId: string,
  type: string,
  message: string,
  entityType?: string,
  entityId?: string,
) {
  const ids = await projectAudienceUserIds(projectId);
  const recipients = ids.filter((id) => id !== actorId);
  if (recipients.length === 0) return;
  await prisma.notification.createMany({
    data: recipients.map((userId) => ({ userId, type, message, entityType, entityId })),
  });
  // اعلان Push پس‌زمینه (اگر FCM پیکربندی شده باشد)
  await sendPushToUsers(recipients, 'فابریک', message, { type, ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) });
}
