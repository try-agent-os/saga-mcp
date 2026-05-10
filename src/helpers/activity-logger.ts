import type { DB } from '../db.js';

export async function logActivity(
  db: DB,
  entityType: string,
  entityId: number,
  action: string,
  fieldName: string | null,
  oldValue: string | null,
  newValue: string | null,
  summary: string
): Promise<void> {
  await db.execute(
    `INSERT INTO activity_log (entity_type, entity_id, action, field_name, old_value, new_value, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entityType, entityId, action, fieldName, oldValue, newValue, summary]
  );
}

export async function logEntityUpdate(
  db: DB,
  entityType: string,
  entityId: number,
  entityName: string,
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
  trackedFields: string[]
): Promise<void> {
  for (const field of trackedFields) {
    const oldVal = String(oldRow[field] ?? '');
    const newVal = String(newRow[field] ?? '');
    if (oldVal !== newVal) {
      const action = field === 'status' ? 'status_changed' : 'updated';
      await logActivity(
        db, entityType, entityId, action, field, oldVal, newVal,
        `${entityType} '${entityName}' ${field}: ${oldVal} -> ${newVal}`
      );
    }
  }
}
