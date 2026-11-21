import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { DAY } from '../community/time.js';
import { timestamp } from '../community/ui.js';
import { guildPermissions, hasPermission } from '../discord/permissions.js';
import { truncate } from '../lib/catalog.js';
import { AppError, DiscordApiError, errorFields } from '../lib/errors.js';
import { adminOf, audit, denied, fixedChoice, idOf, isMissing, limits, live, memberRef, notFound, requestAt, roomRef,
  safeTitle, stale, TEXT_ROOMS, within } from './core.js';

const v = P.ViewChannel;
const s = P.SendMessages;
const memberOverwrite = (ch, userId) => {
  const entry = ch.permission_overwrites?.find(({ id, type }) => id === userId && type === 1);
  return entry ? { allow: String(entry.allow), deny: String(entry.deny) } : null;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withView = (before, allow) => ({ allow: String((BigInt(before?.allow ?? 0) & ~v) | (allow ? v : 0n)),
  deny: String((BigInt(before?.deny ?? 0) & ~v) | (allow ? 0n : v)) });
const over = (value, flag) => (BigInt(value?.allow ?? 0) & flag) ? 'سماح صريح' : (BigInt(value?.deny ?? 0) & flag) ? 'منع صريح' : 'مش محدد';
const manageable = [P.ManageRoles, P.ManageChannels];

async function scopeTarget(c, i, channelId, team, flags, types = [ChannelType.GuildText], module) {
  const ctx = await c.session(i, { team, roomId: channelId, flags, types, module });
  if (i.channelId !== channelId) {
    c.authorize(ctx.w, ctx.a, { by: ctx.by, member: ctx.member, team, channel: c.findRoom(ctx.w, i.channelId, TEXT_ROOMS) });
  }
  return ctx;
}
const protection = (c, ctx) => c.protect(ctx.w, ctx.a, ctx.channel);
const knownRejection = (error) => error instanceof DiscordApiError && error.status >= 400 && error.status < 500;
const slowReason = (id) => `BLACK X timed slow mode ${id}`;

async function hasUntouchedSlowMode(c, w, row) {
  c.botNeeds(w, undefined, P.ViewAuditLog);
  // The full span since our write matters: comparing just the current value misses an edit-and-revert.
  const since = Math.max(0, row.at - 10_000 - 1420070400000);
  let cursor = BigInt(since) << 22n; // Discord's millisecond epoch encoded as a lower-bound snowflake.
  const edits = [];
  for (let page = 0; page < 3; page += 1) {
    const { audit_log_entries: list } = await c.api.getChannelAudits(c.guildId, String(cursor));
    if (!Array.isArray(list)) break;
    for (const entry of list) {
      const id = BigInt(idOf(entry.id));
      if (id <= cursor) throw stale();
      if (entry.target_id === row.channelId && entry.action_type === 11) {
        const value = entry.changes?.find((change) => change.key === 'rate_limit_per_user');
        if (value) edits.push({ id, from: value.old_value ?? 0, to: value.new_value ?? 0,
          isOurs: entry.user_id === c.botId && entry.reason === slowReason(row.applyId) });
      }
    }
    if (list.length < 100) {
      const ours = edits.filter((entry) => entry.isOurs && entry.from === row.before && entry.to === row.after);
      if (ours.length !== 1) break;
      return !edits.some((entry) => entry.id > ours[0].id);
    }
    cursor = list.reduce((max, entry) => BigInt(entry.id) > max ? BigInt(entry.id) : max, cursor);
  }
  throw new AppError('ADMIN_SLOW_UNVERIFIED', 'تعذّر تأكيد سجل التهدئة في ديسكورد؛ البوت مش هيغيّر القيمة من غير دليل.', 409);
}

export function diagnosticActions(c) {
  async function layout(i) {
    const by = await c.owner(i);
    const w = await c.world();
    if (w.guild.owner_id !== by) throw denied();
    const hash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('base64url').slice(0, 22);
    const clean = (name) => truncate(c.redact(String(name ?? '').replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '')), 100);
    const channels = Object.fromEntries(w.channels.map((ch) => {
      const overwrites = (ch.permission_overwrites ?? []).map((o) => [o.id, o.type, String(o.allow), String(o.deny)]).sort((a, b) => a[0].localeCompare(b[0]));
      const name = clean(ch.name);
      return [ch.id, { name, key: hash([name, ch.type, ch.parent_id ?? null, ch.position]), acl: hash(overwrites) }];
    }));
    const roles = Object.fromEntries(w.allRoles.map((r) => {
      const name = clean(r.name);
      return [r.id, { name, key: hash([name, r.position, r.permissions, r.managed, r.mentionable, r.hoist]) }];
    }));
    return { by, channels, roles, at: c.now() };
  }
  return {
    async access(i, { channel, user }) {
      const ctx = await scopeTarget(c, i, idOf(channel?.id), 'ops', [], TEXT_ROOMS);
      const subject = idOf(user?.id);
      const target = await c.api.getMember(c.guildId, subject);
      const bits = c.bits(ctx.w, ctx.channel, subject, target);
      const owner = ctx.w.guild.owner_id === subject;
      const base = owner ? P.Administrator : guildPermissions(ctx.w.allRoles, c.guildId, target.roles);
      const view = hasPermission(bits, v);
      const timedOut = !owner && !hasPermission(base, P.Administrator) && Date.parse(target.communication_disabled_until) > c.now();
      const send = view && !timedOut && hasPermission(bits, s);
      const everyone = ctx.channel.permission_overwrites?.find((o) => o.type === 0 && o.id === c.guildId);
      const rules = (ctx.channel.permission_overwrites ?? []).filter((o) => o.type === 0 && o.id !== c.guildId);
      const roles = rules.filter((o) => target.roles.includes(o.id));
      const explicit = memberOverwrite(ctx.channel, subject);
      const ids = (rows) => rows.slice(0, 4).map((o) => `\`${o.id}\``).join('، ');
      const line = (flag) => {
        const allow = roles.filter((o) => (BigInt(o.allow) & flag) !== 0n);
        const deny = roles.filter((o) => (BigInt(o.deny) & flag) !== 0n);
        const absent = rules.filter((o) => !target.roles.includes(o.id) && (BigInt(o.allow) & flag) !== 0n);
        return [`@everyone: ${over(everyone, flag)}`, ...(allow.length ? [`سماح لرولات العضو ${ids(allow)}`] : []),
          ...(deny.length ? [`منع لرولات العضو ${ids(deny)}`] : []), `العضو: ${over(explicit, flag)}`,
          ...(absent.length ? [`رولات لها سماح ومش عند العضو: ${ids(absent)}`] : [])].join(' · ');
      };
      return [`🔍 ${memberRef(subject)} في ${roomRef(ctx.channel.id)}`, `الرؤية: ${view ? 'مسموحة' : 'ممنوعة'} · الكتابة: ${send ? 'مسموحة' : 'ممنوعة'}.`,
        ...(owner || hasPermission(base, P.Administrator) ? ['المالك أو Administrator بيتجاوز أذونات الروم.'] : [
          `الصلاحيات الأساسية: View=${hasPermission(base, v) ? 'نعم' : 'لا'}، Send=${hasPermission(base, s) ? 'نعم' : 'لا'}.`,
          `الرؤية في الروم — ${line(v)}`, `الكتابة في الروم — ${line(s)}`, ...(timedOut ? ['العضو عليه Timeout فعّال.'] : []),
        ]), 'تشخيص للقراءة بس.'];
    },
    async capture(i) {
      const snapshot = await layout(i);
      await c.edit((a) => {
        live(a);
        a.layout = snapshot;
        audit(a, 'ops', 'layout_captured', snapshot.by, 'layout', snapshot.at);
      });
      return [`اتحفظت لقطة ${Object.keys(snapshot.channels).length} روم و${Object.keys(snapshot.roles).length} رول. مفيش محتوى رسائل أو تعديل ديسكورد.`];
    },
    async diff(i) {
      const current = await layout(i);
      const a = adminOf(await c.read());
      live(a);
      const prior = a.layout;
      if (!prior) return ['لسه مفيش لقطة. استخدم /layout capture الأول.'];
      const edits = [];
      for (const [key, label] of [['channels', 'روم'], ['roles', 'رول']]) {
        for (const [id, info] of Object.entries(current[key])) {
          const before = prior[key][id];
          if (!before) edits.push(`• اتضاف ${label}: ${safeTitle(info.name)} (\`${id}\`)`);
          else if (before.key !== info.key || before.acl !== info.acl) {
            const changed = before.acl !== info.acl ? ' · تغيّرت أذونات الروم' : '';
            edits.push(`• اتغيّر ${label}: ${safeTitle(before.name)} → ${safeTitle(info.name)} (\`${id}\`)${changed}`);
          }
        }
        for (const [id, info] of Object.entries(prior[key])) if (!current[key][id]) edits.push(`• اختفى ${label}: ${safeTitle(info.name)} (\`${id}\`)`);
      }
      return [`🔎 مقارنة مع لقطة ${timestamp(prior.at)} · ${edits.length} اختلاف.`, ...edits.slice(0, 25),
        ...(edits.length > 25 ? ['اتعرض أول ٢٥ اختلاف فقط.'] : []), 'مفيش استرجاع تلقائي.'];
    },
  };
}

function reserveLease(c, ctx, info) {
  return c.edit((a) => {
    const prior = a.leases[info.key];
    if (prior) throw new AppError('ADMIN_ACTIVE_LEASE', 'فيه إعداد مؤقت على نفس المورد. راجعه من /room leases الأول.', 409);
    limits(a.leases, 60);
    a.leases[info.key] = info;
    audit(a, info.team, `${info.kind}_reserved`, info.by, info.channelId, info.at);
  }, ctx);
}
const leaseRecord = (kind, team, ctx, key, before, after, at, minutes, subject) => ({ kind, team, key, channelId: ctx.channel.id,
  by: ctx.by, before, after, subject, at, dueAt: at + minutes * 60_000, tries: 0 });

async function applyTemporary(c, ctx, record, write) {
  await reserveLease(c, ctx, record);
  try { await write(); }
  catch (error) {
    if (knownRejection(error)) await c.edit((a) => {
      if (a.leases[record.key]?.applyId !== record.applyId) return;
      delete a.leases[record.key];
      audit(a, record.team, `${record.kind}_rejected`, ctx.by, record.applyId, c.now());
    });
    throw error;
  }
}

export function roomActions(c) {
  const put = (ch, subject, data) => c.api.putOverwrite(ch.id, subject, { type: 1, ...data });
  return {
    async slow(i, { channel, seconds, minutes, confirm }) {
      within(seconds, 0, 21600); within(minutes, 1, 120);
      const id = idOf(channel?.id);
      return c.serial(`room:${id}`, async () => {
        const ctx = await scopeTarget(c, i, id, 'ops', [P.ManageChannels]);
        protection(c, ctx);
        const before = ctx.channel.rate_limit_per_user ?? 0;
        if (!confirm) return [`معاينة ${roomRef(id)}: ${before} → ${seconds} ثانية لمدة ${minutes} دقيقة. مفيش تعديل. للتنفيذ استخدم confirm:true.`];
        if (before === seconds) return ['الروم بالفعل على القيمة دي؛ مفيش تعديل.'];
        c.botNeeds(ctx.w, ctx.channel, v, P.ManageChannels);
        c.botNeeds(ctx.w, undefined, P.ViewAuditLog);
        const record = { ...leaseRecord('slow', 'ops', ctx, `slow:${id}`, before, seconds, c.now(), minutes), applyId: idOf(i.id) };
        await applyTemporary(c, ctx, record, () => c.api.updateChannel(id, { rate_limit_per_user: seconds }, { guarded: true, reason: slowReason(record.applyId) }));
        await c.edit((a) => audit(a, 'ops', 'slow_applied', ctx.by, id, c.now()));
        return [`التهدئة اتضبطت لمدة ${minutes} دقيقة. البوت بيراجع سجل التغييرات قبل ما يرجّع القيمة القديمة.`];
      });
    },
    async guest(i, { user, minutes }) {
      within(minutes, 1, 360);
      const subject = idOf(user?.id);
      c.assertGuild(i);
      const id = idOf(adminOf(await c.read()).rooms.guest);
      return c.serial(`room:${id}`, async () => {
        const ctx = await scopeTarget(c, i, id, 'events', manageable, undefined, 'events');
        if (ctx.a.rooms.guest !== id) throw stale();
        protection(c, ctx);
        const member = await c.api.getMember(c.guildId, subject);
        if (user.bot || member.user?.bot || subject === c.botId) throw denied();
        if (hasPermission(c.bits(ctx.w, ctx.channel, subject, member), v)) return ['العضو شايف الروم بالفعل؛ البوت ما غيّرش أي صلاحية.'];
        c.botNeeds(ctx.w, ctx.channel, v, P.ManageRoles);
        const before = memberOverwrite(ctx.channel, subject);
        const after = withView(before, true);
        const record = { ...leaseRecord('guest', 'events', ctx, `guest:${id}:${subject}`, before, after, c.now(), minutes, subject), applyId: idOf(i.id) };
        await applyTemporary(c, ctx, record, () => put(ctx.channel, subject, after));
        await c.edit((a) => {
          if (a.leases[record.key]?.applyId === record.applyId) a.leases[record.key].confirmed = true;
          audit(a, 'events', 'guest_granted', ctx.by, id, c.now());
        });
        return [`اتمنح ${memberRef(subject)} رؤية ${roomRef(id)} لمدة ${minutes} دقيقة من غير إضافة أي رول.`];
      });
    },
    async propose(i, { channel, user, visibility }) {
      fixedChoice(['allow', 'deny'], visibility);
      const ctx = await scopeTarget(c, i, idOf(channel?.id), 'ops', manageable);
      protection(c, ctx);
      const subject = idOf(user?.id);
      const member = await c.api.getMember(c.guildId, subject);
      if (user.bot || member.user?.bot || subject === c.botId || subject === ctx.w.guild.owner_id || subject === ctx.by ||
        hasPermission(c.bits(ctx.w, undefined, subject, member), P.Administrator)) throw denied();
      const before = memberOverwrite(ctx.channel, subject);
      const after = withView(before, visibility === 'allow');
      if (eq(before, after)) return ['الأذونات بالفعل على نفس القيمة.'];
      const id = idOf(i.id);
      const at = c.now();
      await c.edit((a) => {
        if (a.proposals[id]) return;
        for (const [key, p] of Object.entries(a.proposals)) if (p.until + DAY < at) delete a.proposals[key];
        limits(a.proposals, 80);
        a.proposals[id] = { id, by: ctx.by, sourceId: i.channelId, subject, channelId: ctx.channel.id, before, after, at,
          until: at + 30 * 60_000, status: 'pending' };
        audit(a, 'ops', 'access_proposed', ctx.by, id, at);
      }, ctx);
      return [`طلب \`${id}\`: ${memberRef(subject)} في ${roomRef(ctx.channel.id)} — ${over(before, v)} → ${over(after, v)}.`,
        'لسه مفيش تعديل. مشرف تاني مخوّل يراجع من /room pending ويوافق صراحةً خلال ٣٠ دقيقة.'];
    },
    async pending(i) {
      const ctx = await c.session(i, { team: 'ops' });
      const proposals = Object.values(ctx.a.proposals).filter((p) => ['pending', 'applying', 'review'].includes(p.status) && p.until > c.now() &&
        (ctx.owner || ctx.a.teams.ops?.rooms.includes(p.channelId))).slice(-15);
      return ['طلبات الرؤية اللي مستنية موافقة:', ...proposals.map((p) => `• \`${p.id}\` · ${memberRef(p.subject)} في ${roomRef(p.channelId)}: ${over(p.before, v)} → ${over(p.after, v)} · ${p.status === 'pending' ? `ينتهي ${timestamp(p.until)}` : 'تنفيذ غير مؤكد؛ راجع الروم'}`),
        ...(proposals.length ? [] : ['مفيش.'])];
    },
    async approve(i, { id, confirm }) {
      const caller = await c.session(i, { team: 'ops' });
      const row = requestAt(caller.a.proposals, id);
      if (!caller.owner && !caller.a.teams.ops?.rooms.includes(row.channelId)) throw denied();
      return c.serial(`room:${row.channelId}`, async () => {
        const ctx = await scopeTarget(c, i, row.channelId, 'ops', manageable);
        protection(c, ctx);
        const p = requestAt(ctx.a.proposals, id);
        if (p.by === ctx.by || p.subject === ctx.by) throw denied();
        if (p.status !== 'pending' || p.until <= c.now() || ctx.a.leases[`guest:${p.channelId}:${p.subject}`] ||
          !eq(memberOverwrite(ctx.channel, p.subject), p.before)) throw stale();
        if (!confirm) return [`معاينة \`${p.id}\`: ${memberRef(p.subject)} في ${roomRef(p.channelId)}. ${over(p.before, v)} → ${over(p.after, v)}. استخدم confirm:true للتنفيذ.`];
        const [origin, subject] = await Promise.all([c.api.getMember(c.guildId, p.by), c.api.getMember(c.guildId, p.subject)]);
        if (subject.user?.bot || hasPermission(c.bits(ctx.w, undefined, p.subject, subject), P.Administrator)) throw denied();
        c.authorize(ctx.w, ctx.a, { by: p.by, member: origin, team: 'ops', channel: ctx.channel, flags: manageable });
        if (p.sourceId !== p.channelId) {
          c.authorize(ctx.w, ctx.a, { by: p.by, member: origin, team: 'ops', channel: c.findRoom(ctx.w, p.sourceId, TEXT_ROOMS) });
        }
        c.botNeeds(ctx.w, ctx.channel, v, P.ManageRoles);
        await c.edit((a) => {
          const item = requestAt(a.proposals, id);
          if (item.status !== 'pending' || c.now() >= item.until || a.leases[`guest:${p.channelId}:${p.subject}`]) throw stale();
          item.status = 'applying';
          item.approvedBy = ctx.by;
          audit(a, 'ops', 'access_applying', ctx.by, id, c.now());
        }, ctx);
        try { await put(ctx.channel, p.subject, p.after); }
        catch (error) {
          await c.edit((a) => {
            const item = requestAt(a.proposals, id);
            item.status = knownRejection(error) ? 'pending' : 'review';
            audit(a, 'ops', 'access_unconfirmed', ctx.by, id, c.now(), item.status);
          });
          throw error;
        }
        await c.edit((a) => {
          const item = requestAt(a.proposals, id);
          item.status = 'applied'; item.approvedBy = ctx.by;
          audit(a, 'ops', 'access_approved', ctx.by, id, c.now());
        });
        return ['اتطبّق تعديل View Channel للعضو المحدد فقط.'];
      });
    },
    async leases(i) {
      const ctx = await c.session(i, { team: 'ops' });
      const leases = Object.values(ctx.a.leases).filter((entry) => ctx.owner || ctx.a.teams.ops?.rooms.includes(entry.channelId)).slice(0, 20);
      return ['الإعدادات المؤقتة:', ...leases.map((r) => `• ${r.kind} \`${r.applyId}\` · ${roomRef(r.channelId)} · ${r.failed ? 'تعذّر الاسترجاع؛ راجع الأذونات يدويًا' : timestamp(r.dueAt)}`),
        ...(leases.length ? [] : ['مفيش.'])];
    },
    async forget(i, { id }) {
      const by = await c.owner(i);
      idOf(id);
      await c.edit((a) => {
        const entry = Object.values(a.leases).find((r) => r.applyId === id);
        if (!entry?.failed) throw notFound();
        delete a.leases[entry.key];
        audit(a, entry.team, 'lease_failure_acknowledged', by, id, c.now());
      });
      return ['اتقفل سجل الاسترجاع الفاشل، من غير أي تغيير في الروم.'];
    },
  };
}

// Compare only what the bot changed. If an admin edited it meanwhile, never undo that edit.
export async function restoreLeases(c, snapshot) {
  const time = c.now();
  const due = Object.values(snapshot.leases).filter((r) => r.dueAt <= time && !r.failed).slice(0, 6);
  for (const row of due) await c.serial(`room:${row.channelId}`, async () => {
    let outcome;
    try {
      const w = await c.world();
      const ch = w.channels.find(({ id }) => id === row.channelId);
      outcome = 'missing';
      if (ch?.type === ChannelType.GuildText) {
        outcome = 'changed_elsewhere';
        if (row.kind === 'slow' && (ch.rate_limit_per_user ?? 0) === row.after) {
          if (await hasUntouchedSlowMode(c, w, row)) {
            const fresh = await c.api.getChannel(ch.id);
            if (fresh?.guild_id === c.guildId && fresh.type === ch.type && (fresh.rate_limit_per_user ?? 0) === row.after) {
              c.botNeeds(w, fresh, v, P.ManageChannels);
              await c.api.updateChannel(ch.id, { rate_limit_per_user: row.before }, { guarded: true, reason: `BLACK X expiry ${row.applyId}` });
              outcome = 'restored';
            }
          }
        } else if (row.kind === 'guest' && eq(memberOverwrite(ch, row.subject), row.after)) {
          c.botNeeds(w, ch, v, P.ManageRoles);
          if (!row.confirmed) outcome = 'unconfirmed';
          else {
            if (row.before) await c.api.putOverwrite(ch.id, row.subject, { type: 1, ...row.before });
            else await c.api.deleteOverwrite(ch.id, row.subject);
            outcome = 'restored';
          }
        }
      }
    } catch (error) {
      outcome = isMissing(error) ? 'missing' : undefined;
      if (!outcome) c.log.warn('admin_restore_failed', { kind: row.kind, ...errorFields(error) });
    }
    await c.edit((a) => {
      const lease = a.leases[row.key];
      if (lease?.applyId !== row.applyId) return;
      if (outcome === 'unconfirmed') {
        lease.failed = true;
        audit(a, row.team, 'guest_restore_unconfirmed', undefined, row.channelId, c.now(), 'manual_review');
      } else if (outcome) {
        delete a.leases[row.key];
        audit(a, row.team, `${row.kind}_ended`, undefined, row.channelId, c.now(), outcome);
      } else {
        lease.tries += 1;
        if (lease.tries >= 6) {
          lease.failed = true;
          audit(a, row.team, `${row.kind}_restore_failed`, undefined, row.channelId, c.now(), 'manual_review');
        } else lease.dueAt = c.now() + Math.min(15, 2 ** lease.tries) * 60_000;
      }
    });
  });
                    }
