type PartMilestone =
  | 'CREATED'
  | 'PRICED_AND_INVOICED'
  | 'ORDER_PLACED'
  | 'IN_PRODUCTION'
  | 'QUALITY_CONTROL'
  | 'COMPLETED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'ARCHIVED';

const MILESTONE_WEIGHTS: Record<PartMilestone, number> = {
  CREATED: 0,
  PRICED_AND_INVOICED: 10,
  ORDER_PLACED: 20,
  IN_PRODUCTION: 50,
  QUALITY_CONTROL: 70,
  COMPLETED: 80,
  IN_TRANSIT: 95,
  DELIVERED: 100,
  ARCHIVED: -1, // excluded from calc
};

interface PartProgress {
  milestone: PartMilestone;
  archivedAt?: Date | null;
}

export function calculatePartProgress(part: PartProgress): number {
  if (part.archivedAt) return -1;
  return MILESTONE_WEIGHTS[part.milestone] ?? 0;
}

export function calculateProjectProgress(parts: PartProgress[]): number {
  const activeParts = parts.filter((p) => !p.archivedAt);
  if (activeParts.length === 0) return 0;
  const total = activeParts.reduce((sum, p) => sum + (MILESTONE_WEIGHTS[p.milestone] ?? 0), 0);
  return Math.round(total / activeParts.length);
}
