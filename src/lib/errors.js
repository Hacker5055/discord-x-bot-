export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

// Discord sometimes includes request bodies or credential-bearing URLs in errors.
// Keep only numeric metadata; do not retain the raw response or a cause.
export class DiscordApiError extends Error {
  constructor(status, discordCode) {
    super(`Discord HTTP ${status}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.discordCode = Number.isSafeInteger(discordCode) ? discordCode : undefined;
  }
}

// These Discord responses confirm that a guarded create did not succeed. Transport failures and 5xx do not.
export const rejectedWrite = (error) => error instanceof DiscordApiError && [400, 401, 403, 404, 429].includes(error.status);

export const ownerRequired = () => new AppError('OWNER_REQUIRED', 'الأمر متاح فقط لمالك السيرفر المطابق لـ BX_OWNER_DISCORD_ID.', 403);

const HIERARCHY_HELP = 'ارفع أعلى رول للبوت فوق رولات BLACK X من Server Settings → Roles.';
export const roleHierarchyError = () => new AppError('ROLE_HIERARCHY', HIERARCHY_HELP, 403);

export function describeError(error) {
  if (error instanceof AppError) return error.message;
  if (error instanceof DiscordApiError) {
    switch (error.status) {
      case 400: return 'ديسكورد رفض بيانات الطلب (400). راجع إعدادات المورد.';
      case 401: return 'ديسكورد رفض المصادقة (401). راجع DISCORD_BOT_TOKEN محليًا.';
      case 403:
        if (error.discordCode === 50001) return 'البوت لا يستطيع الوصول للمورد (403 Missing Access). راجع السيرفر والروم.';
        if (error.discordCode === 50013) return 'صلاحيات البوت غير كافية (403 Missing Permissions). راجع الصلاحيات والهرمية.';
        return 'ديسكورد رفض الوصول (403). راجع صلاحيات البوت وترتيب روله.';
      case 404: return 'المورد غير موجود في ديسكورد (404). راجع المعرّفات والإعداد.';
      case 429: return 'ديسكورد حدّ عدد الطلبات (429). جرّب لاحقًا.';
      default: return 'تعذّر الاتصال بديسكورد أو إكمال الطلب. جرّب لاحقًا.';
    }
  }
  return 'حدث خطأ غير متوقّع. راجع السجل أو جرّب لاحقًا.';
}

export function errorFields(error) {
  if (error instanceof AppError) return { code: error.code };
  if (error instanceof DiscordApiError) {
    return { code: 'DISCORD_ERROR', discordStatus: error.status, discordCode: error.discordCode };
  }
  return { code: 'UNEXPECTED_ERROR' };
}
