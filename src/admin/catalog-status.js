import { timestamp } from '../community/ui.js';

export function createCatalogMonitor() {
  let lastError;
  return {
    reject({ at, status, code }) {
      if (Number.isSafeInteger(status) && status >= 400 && status <= 599 && /^[A-Z_]{1,48}$/.test(code ?? '')) lastError = { at, status, code };
    },
    lastError: () => lastError && { ...lastError },
  };
}

export function catalogStatus(c) {
  return async (i) => {
    const { state } = await c.session(i, { team: 'ops', gated: false });
    const last = state.catalogMeta;
    const failed = c.catalogMonitor?.lastError();
    return ['📊 استقبال الكتالوج · قراءة فقط', `الأعمال المحفوظة: ${Object.keys(state.catalog).length}.`,
      last ? `آخر دفعة اتقبلت: ${timestamp(last.at)} · ${last.batch} عنصر، ${last.removed} إزالة مطلوبة.` : 'مفيش وقت قبول مسجّل في الإصدار ده لسه.',
      failed ? `آخر رفض منذ إقلاع البوت: ${timestamp(failed.at)} · ${failed.status} \`${failed.code}\`.`
        : 'مفيش رفض مسجّل منذ إقلاع البوت.', 'الترشيحات بتقرأ المحفوظ؛ نجاح /recommend مش دليل إن كل دفعات الموقع اتزامنت.'];
  };
}
