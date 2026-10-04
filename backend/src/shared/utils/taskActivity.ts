import prisma from './prisma';

/**
 * Posts an automatic system message into a task's conversation thread,
 * e.g. "محمد ساعت ... وضعیت را از باز به انجام‌شده تغییر داد".
 */
export async function logTaskActivity(taskId: string, userId: string, text: string) {
  try {
    await prisma.comment.create({
      data: { taskId, userId, text, isSystem: true, attachmentUrls: [] },
    });
  } catch {
    // never block the main action because of an activity-log failure
  }
}
