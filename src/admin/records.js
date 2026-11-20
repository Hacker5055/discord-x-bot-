import { DAY } from '../community/time.js';
import { timestamp } from '../community/ui.js';
import { AppError } from '../lib/errors.js';
import { audit, limits, memberRef, notFound, requestAt, roomRef, safeTitle } from './core.js';

export const requestTeam = { ticket: 'support', appeal: 'moderation', idea: 'events', creator: 'content', correction: 'content' };
const labels = { ticket: 'تذكرة', appeal: 'استئناف', idea: 'اقتراح', creator: 'طلب Creator', correction: 'تصحيح كتالوج' };
export const stages = { opening: 'قيد الفتح', open: 'مفتوحة', claimed: 'مستلمة', submitted: 'مستني المراجعة', review: 'قيد التصويت',
  closed: 'مقفولة', approved: 'اتقبل', rejected: 'اترَفض', implemented: 'اتنفّذ' };
export const duplicate = () => new AppError('ADMIN_DUPLICATE_REQUEST', 'عندك طلب مفتوح من النوع ده بالفعل. راجع /my.', 409);
export const setRecord = (a, record, { maxForMember = 1, unique } = {}) => {
  if (a.requests[record.id]) return a.requests[record.id];
  // Prune old metadata only. Archived ticket channels/messages are never auto-deleted.
  for (const [id, r] of Object.entries(a.requests)) if (r.closedAt && r.closedAt < record.at - 90 * DAY) delete a.requests[id];
  const open = Object.values(a.requests).filter((r) => r.kind === record.kind && r.by === record.by && !r.closedAt);
  if (open.length >= maxForMember || (unique && Object.values(a.requests).some(unique))) throw duplicate();
  if (Object.keys(a.requests).length >= 300) {
    // Preserve the entire support reporting window even under heavier request volume.
    const oldest = Object.values(a.requests).filter((r) => r.closedAt && r.closedAt < record.at - 7 * DAY)
      .sort((l, r) => l.closedAt - r.closedAt)[0];
    if (oldest) delete a.requests[oldest.id];
  }
  limits(a.requests, 300);
  a.requests[record.id] = record;
  audit(a, requestTeam[record.kind], `${record.kind}_opened`, record.by, record.id, record.at);
  return record;
};
export const kindAt = (a, id, kind) => {
  const record = requestAt(a.requests, id);
  if (record.kind !== kind) throw notFound();
  return record;
};
export const requestLine = (r) => `• \`${r.id}\` · ${labels[r.kind]} — ${stages[r.status]}${r.assignee ? ` · ${memberRef(r.assignee)}` : ''}`;
export function detailLines(r) {
  return [requestLine(r), `مقدّم الطلب: ${memberRef(r.by)} · ${timestamp(r.at)}`,
    ...(r.channelId ? [`الروم: ${roomRef(r.channelId)}`] : []), ...(r.subject ? [safeTitle(r.subject)] : []),
    ...(r.note ? [safeTitle(r.note)] : []), ...(r.link ? [`<${r.link}>`] : []),
    ...(r.caseId ? [`رقم التنبيه: \`${r.caseId}\``] : []), ...(r.animeId ? [`معرّف الأنمي: \`${r.animeId}\``] : []),
    ...(r.reason ? [`القرار: ${safeTitle(r.reason)}`] : [])];
}
